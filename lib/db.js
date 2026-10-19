// ═══════════════════════════════════════════════════════════════
// GiveCloud — couche données : client Cloudflare D1 (API REST)
// ═══════════════════════════════════════════════════════════════
// Remplace l'ancien client Airtable. On dialogue avec D1 via l'API
// REST de Cloudflare (l'API Vercel ne peut pas avoir de binding D1).
//
// Variables d'environnement requises :
//   CLOUDFLARE_ACCOUNT_ID  — identifiant de compte Cloudflare
//   D1_DATABASE_ID         — UUID de la base D1
//   CLOUDFLARE_API_TOKEN   — jeton avec la permission « D1 Edit »
//
// Le dépôt expose un petit ORM : creer/lire/maj/supprimer + requêtes
// métier explicites. Aucune concaténation SQL : tout passe par des
// requêtes préparées (paramètres liés) → pas d'injection possible.
// ═══════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Génère un identifiant "rec" + 20 caractères hexadécimaux. */
export function nouvelId() {
  const octets = new Uint8Array(10);
  crypto.getRandomValues(octets);
  return 'rec' + Array.from(octets, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** URL de l'endpoint REST D1. */
function urlD1(env) {
  const base = env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
  return `${base}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/query`;
}

/**
 * Exécute une ou plusieurs requêtes SQL via l'API REST D1.
 * `requetes` = tableau de { sql, params }. Renvoie un tableau de
 * tableaux de lignes (un par requête). Réessaie sur 429/5xx.
 */
async function appelerD1(env, requetes) {
  const corps = requetes.length === 1
    ? { sql: requetes[0].sql, params: requetes[0].params || [] }
    : { batch: requetes.map((r) => ({ sql: r.sql, params: r.params || [] })) };
  let derniere = null;
  for (let essai = 0; essai < 3; essai++) {
    if (essai > 0) await sleep(400 * 2 ** (essai - 1) + Math.random() * 200);
    derniere = await fetch(urlD1(env), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(corps)
    });
    if (derniere.status !== 429 && derniere.status < 500) break;
  }
  const data = await derniere.json().catch(() => null);
  if (!derniere.ok || !data || data.success !== true) {
    console.error('Erreur D1:', JSON.stringify(data && data.errors ? data.errors : derniere.status));
    throw new Error('D1_ERREUR');
  }
  // result : tableau, un élément par requête.
  return (data.result || []).map((r) => r.results || []);
}

/** Une requête → tableau de lignes. */
export function requete(env, sql, params = []) {
  return appelerD1(env, [{ sql, params }]).then((r) => r[0] || []);
}

/** Plusieurs requêtes (batch atomique) → tableau de tableaux de lignes. */
export function lot(env, requetes) {
  return appelerD1(env, requetes);
}

// ───────────────────────── Correspondance table ↔ champs ─────────────────────────

// Chaque table : mapping colonne SQL ↔ nom de champ "métier" (camelCase,
// identique aux anciens champs Airtable pour limiter les changements).
const TABLES = {
  users: {
    ts: 'created_at',
    versChamps: (l) => ({
      email: l.email,
      passwordHash: l.password_hash,
      salt: l.salt,
      iterations: l.iterations,
      quotaMo: l.quota_mo,
      createdAt: l.created_at
    }),
    versColonnes: {
      email: 'email', passwordHash: 'password_hash', salt: 'salt',
      iterations: 'iterations', quotaMo: 'quota_mo', createdAt: 'created_at'
    }
  },
  files: {
    ts: 'cree_le',
    versChamps: (l) => ({
      nom: l.nom,
      chemin: l.chemin,
      taille: l.taille,
      type: l.type,
      proprietaire: l.owner_id,
      r2Key: l.r2_key,
      supprimeLe: l.supprime_le
    }),
    versColonnes: {
      nom: 'nom', chemin: 'chemin', taille: 'taille', type: 'type',
      proprietaire: 'owner_id', r2Key: 'r2_key', supprimeLe: 'supprime_le'
    }
  },
  shares: {
    ts: 'cree_le',
    versChamps: (l) => ({
      token: l.token,
      fichier: l.file_id,
      expireLe: l.expire_le,
      revoque: Boolean(l.revoque)
    }),
    versColonnes: {
      token: 'token', fichier: 'file_id', expireLe: 'expire_le', revoque: 'revoque'
    }
  }
};

/** Transforme une ligne SQL en "record" { id, fields, createdTime }. */
function versRecord(table, ligne) {
  const t = TABLES[table];
  return { id: ligne.id, fields: t.versChamps(ligne), createdTime: ligne[t.ts] };
}

// ───────────────────────── ORM générique ─────────────────────────

/** Crée une ligne. Renvoie { record } ou { erreur }. */
export async function creer(env, table, champs) {
  const t = TABLES[table];
  const id = nouvelId();
  const ts = new Date().toISOString();
  const colonnes = ['id', t.ts];
  const valeurs = [id, ts];
  for (const [champ, colonne] of Object.entries(t.versColonnes)) {
    if (champs[champ] !== undefined) {
      colonnes.push(colonne);
      valeurs.push(champs[champ]);
    }
  }
  const marques = colonnes.map(() => '?').join(', ');
  try {
    await requete(env, `INSERT INTO ${table} (${colonnes.join(', ')}) VALUES (${marques})`, valeurs);
  } catch {
    return { erreur: 422, message: "Enregistrement impossible (valeur en double ou invalide)." };
  }
  return { record: { id, fields: champs, createdTime: ts } };
}

/** Lit une ligne par id. Renvoie { record } ou { erreur }. */
export async function lire(env, table, id) {
  const lignes = await requete(env, `SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [id]);
  if (!lignes.length) return { erreur: 404 };
  return { record: versRecord(table, lignes[0]) };
}

/** Met à jour des champs. Renvoie { record } (relu) ou { erreur }. */
export async function maj(env, table, id, champs) {
  const t = TABLES[table];
  const sets = [];
  const valeurs = [];
  for (const [champ, colonne] of Object.entries(t.versColonnes)) {
    if (champs[champ] !== undefined) {
      sets.push(`${colonne} = ?`);
      valeurs.push(champs[champ]);
    }
  }
  if (sets.length === 0) return lire(env, table, id);
  valeurs.push(id);
  try {
    await requete(env, `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, valeurs);
  } catch {
    return { erreur: 422, message: 'Modification impossible.' };
  }
  return lire(env, table, id);
}

/** Supprime une ligne. Renvoie true/false. */
export async function supprimer(env, table, id) {
  const lignes = await requete(env, `DELETE FROM ${table} WHERE id = ? RETURNING id`, [id]);
  return lignes.length > 0;
}

// ───────────────────────── Requêtes métier ─────────────────────────

/** Utilisateur par e-mail (déjà en minuscules). */
export async function userParEmail(env, email) {
  const lignes = await requete(env, 'SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  return lignes.length ? versRecord('users', lignes[0]) : null;
}

/** Total d'octets utilisés (hors corbeille) par un propriétaire. */
export async function tailleUtilisee(env, ownerId) {
  const lignes = await requete(
    env,
    'SELECT COALESCE(SUM(taille), 0) AS total FROM files WHERE owner_id = ? AND supprime_le IS NULL',
    [ownerId]
  );
  return Number(lignes[0]?.total) || 0;
}

/** Fichiers actifs d'un dossier, triés. */
export async function fichiersDossier(env, ownerId, chemin, triChamp, triSens) {
  const colonnes = { nom: 'nom', taille: 'taille', type: 'type', creeLe: 'cree_le' };
  const col = colonnes[triChamp] || 'nom';
  const sens = triSens === 'desc' ? 'DESC' : 'ASC';
  const lignes = await requete(
    env,
    `SELECT * FROM files WHERE owner_id = ? AND supprime_le IS NULL AND chemin = ? ORDER BY ${col} COLLATE NOCASE ${sens}`,
    [ownerId, chemin]
  );
  return lignes.map((l) => versRecord('files', l));
}

/** Fichiers dans la corbeille d'un propriétaire (récents d'abord). */
export async function fichiersCorbeille(env, ownerId) {
  const lignes = await requete(
    env,
    'SELECT * FROM files WHERE owner_id = ? AND supprime_le IS NOT NULL ORDER BY supprime_le DESC',
    [ownerId]
  );
  return lignes.map((l) => versRecord('files', l));
}

/** Fichiers actifs dont le chemin est `prefixe` ou un sous-dossier de `prefixe`. */
export async function enfantsPrefixe(env, ownerId, prefixe) {
  const lignes = await requete(
    env,
    `SELECT * FROM files WHERE owner_id = ? AND supprime_le IS NULL AND (chemin = ? OR chemin LIKE ?)`,
    [ownerId, prefixe, prefixe + '/%']
  );
  return lignes.map((l) => versRecord('files', l));
}

/** Un élément actif du même nom existe-t-il déjà dans ce dossier ? */
export async function elementExistant(env, ownerId, chemin, nom) {
  const lignes = await requete(
    env,
    'SELECT id FROM files WHERE owner_id = ? AND supprime_le IS NULL AND chemin = ? AND nom = ? LIMIT 1',
    [ownerId, chemin, nom]
  );
  return lignes.length > 0;
}

/** Fichiers actifs dans la corbeille expirés (supprime_le < limite). */
export async function expiresCorbeille(env, ownerId, limiteIso) {
  const lignes = await requete(
    env,
    'SELECT * FROM files WHERE owner_id = ? AND supprime_le IS NOT NULL AND supprime_le < ?',
    [ownerId, limiteIso]
  );
  return lignes.map((l) => versRecord('files', l));
}

/**
 * Réécrit le préfixe de chemin des enfants d'un dossier déplacé/renommé.
 * ancienPrefixe/nouveauPrefixe = "/a/b" (sans slash final).
 */
export async function renommerPrefixe(env, ownerId, ancienPrefixe, nouveauPrefixe) {
  const enfants = await enfantsPrefixe(env, ownerId, ancienPrefixe);
  const majs = [];
  for (const rec of enfants) {
    const suffixe = (rec.fields.chemin || '/').slice(ancienPrefixe.length) || '';
    const nouveauChemin = (nouveauPrefixe + suffixe) || '/';
    majs.push({ sql: 'UPDATE files SET chemin = ? WHERE id = ?', params: [nouveauChemin, rec.id] });
  }
  if (majs.length) await lot(env, majs);
}

/** Partage par token. */
export async function shareParToken(env, token) {
  const lignes = await requete(env, 'SELECT * FROM shares WHERE token = ? LIMIT 1', [token]);
  return lignes.length ? versRecord('shares', lignes[0]) : null;
}

/** Tous les partages rattachés aux fichiers d'un propriétaire (nom inclus). */
export async function sharesDeOwner(env, ownerId) {
  return requete(
    env,
    `SELECT s.id, s.token, s.expire_le, s.revoque, s.file_id, f.nom AS nom
       FROM shares s JOIN files f ON f.id = s.file_id
      WHERE f.owner_id = ?`,
    [ownerId]
  );
}
