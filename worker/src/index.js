// ═══════════════════════════════════════════════════════════════
// GiveCloud — Cloudflare Worker (API sécurisée + serveur du front)
// ═══════════════════════════════════════════════════════════════
// RÔLE : unique interlocuteur du navigateur. Le token Airtable
// vit uniquement ici (wrangler secret). Le front ne parle qu'à ce Worker.
//
// Routes gérées :
//   GET    /api/health              → vérification de vie
//   POST   /api/auth/register       → inscription (PBKDF2)
//   POST   /api/auth/login          → connexion (cookie HttpOnly)
//   POST   /api/auth/logout         → déconnexion
//   GET    /api/auth/me             → profil courant
//   PATCH  /api/auth/me             → changer l'e-mail (profil)
//   POST   /api/auth/password       → changer le mot de passe
//   GET    /api/quota               → jauge de stockage
//   GET    /api/files?chemin=/…     → liste des fichiers du dossier courant
//   POST   /api/files/upload        → envoi multipart (5 Mo max)
//   PATCH  /api/files/:id           → renommer / déplacer
//   DELETE /api/files/:id           → corbeille (supprimeLe = maintenant)
//   DELETE /api/files/:id?definitif=1 → suppression définitive (déjà en corbeille)
//   GET    /api/files/:id/download  → proxy avec URL Airtable fraîche
//   GET    /api/files/:id/preview   → aperçu inline (images/PDF)
//   GET    /api/files/:id/content   → contenu inline (visionneuse / éditeur)
//   PUT    /api/files/:id/content   → enregistrer le contenu (éditeur de code)
//   POST   /api/folders             → créer un dossier
//   GET    /api/trash               → corbeille
//   POST   /api/trash/vider         → vider la corbeille (définitif)
//   POST   /api/files/:id/restore   → restaurer de la corbeille
//   POST   /api/shares              → créer un lien de partage (heures ou "jamais")
//   GET    /api/shares              → mes partages
//   DELETE /api/shares/:id          → révoquer un partage
//   GET    /s/:token                → téléchargement public (avec expiration optionnelle)
//   *      (autre)                  → assets statiques du front
// ═══════════════════════════════════════════════════════════════

// ───────────────────────── Constantes ─────────────────────────

// Limite dure de l'endpoint uploadAttachment d'Airtable : 5 Mo.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// PBKDF2 : 210 000 itérations = recommandation OWASP actuelle pour PBKDF2-SHA256.
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;   // sel unique par utilisateur
const HASH_BITS = 256;   // sortie de 32 octets

// Durée de vie du cookie de session (7 jours).
const SESSION_DAYS = 7;
const SESSION_COOKIE = 'gc_session';

// Corbeille : purge physique après 30 jours.
const TRASH_DAYS = 30;

// Quota de stockage par défaut d'un nouveau compte : 23 Go.
// (Surchargeable via la variable d'environnement QUOTA_MO_DEFAULT.)
const QUOTA_MO_DEFAUT = 23 * 1024;

// Limite d'écriture depuis l'éditeur de code : identique à l'upload.
const MAX_TEXTE_BYTES = 5 * 1024 * 1024;

// Partage : durée maximale autorisée (30 jours). 0 / null / "jamais" = sans expiration.
const SHARE_MAX_HEURES = 24 * 30;

// Rate limiting login/register : 5 tentatives par tranche de 10 minutes et par IP.
const RATE_FENETRE_MS = 10 * 60 * 1000;
const RATE_MAX_TENTATIVES = 5;

// Extensions interdites à l'upload : uniquement les exécutables natifs et les
// conteneurs dangereux au double-clic. Les fichiers de code (.js, .py, .html…)
// sont AUTORISÉS : ils ne sont jamais servis ni exécutés comme contenu actif
// (téléchargement = attachment, aperçu = Content-Type + CSP sandbox), donc
// ils peuvent être ouverts et édités en toute sécurité dans l'éditeur Monaco.
const EXT_INTERDITES = new Set([
  '.exe', '.com', '.pif', '.bat', '.cmd', '.scr', '.msi', '.dll', '.hta', '.lnk',
  '.run', '.bin', '.app', '.deb', '.rpm', '.dmg', '.cpl', '.gadget', '.inf', '.reg',
  '.scf', '.vb', '.vxd', '.wsc',
  '.ps1', '.psm1', '.vbs', '.vbe', '.wsf', '.wsh', '.jar', '.jse', '.ws', '.desktop'
]);

// Marqueur interne : un record Files dont "type" vaut ceci est un DOSSIER virtuel.
const TYPE_DOSSIER = 'application/x-givecloud-dossier';

// ───────────────────────── Crypto ─────────────────────────

/** Génère `n` octets aléatoires crypto sûrs, encodés base64. */
function randomB64(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytesToB64(bytes);
}

/** Génère un token hex aléatoire (pour les liens de partage). */
function randomHex(nOctets) {
  const bytes = new Uint8Array(nOctets);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** ArrayBuffer/Uint8Array → base64 (par blocs, compatible gros volumes). */
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** base64 → Uint8Array. */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Hachage de mot de passe : PBKDF2-SHA256 via WebCrypto (jamais de lib externe). */
async function hashPassword(motDePasse, selB64, iterations) {
  const enc = new TextEncoder();
  const matiere = await crypto.subtle.importKey(
    'raw', enc.encode(motDePasse), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(selB64), iterations },
    matiere,
    HASH_BITS
  );
  return bytesToB64(new Uint8Array(bits));
}

/** Comparaison de chaînes à temps constant (anti-timing-attack sur les hashs). */
function egalTempsConstant(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** b64url d'un tableau d'octets. */
function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Signe un JWT HS256 avec WebCrypto. */
async function signerJwt(payload, secret) {
  const enc = new TextEncoder();
  const entete = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const corps = b64url(enc.encode(JSON.stringify(payload)));
  const donnees = `${entete}.${corps}`;
  const cle = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cle, enc.encode(donnees));
  return `${donnees}.${b64url(new Uint8Array(sig))}`;
}

/** Reconstruit le padding base64 manquant (b64url n'en a pas). */
function completerPadding(b64urlSansPad) {
  const reste = b64urlSansPad.length % 4;
  return reste === 0 ? b64urlSansPad : b64urlSansPad + '='.repeat(4 - reste);
}

/** Vérifie un JWT HS256. Renvoie le payload ou null si invalide/expiré. */
async function verifierJwt(jwt, secret) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const [entete, corps, sig] = parts;
    const enc = new TextEncoder();
    const cle = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigNorm = completerPadding(sig.replace(/-/g, '+').replace(/_/g, '/'));
    const sigBytes = b64ToBytes(sigNorm);
    const ok = await crypto.subtle.verify(
      'HMAC', cle, sigBytes, enc.encode(`${entete}.${corps}`)
    );
    if (!ok) return null;
    const corpsNorm = completerPadding(corps.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(new TextDecoder().decode(b64ToBytes(corpsNorm)));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    if (typeof payload.sub !== 'string' || !payload.sub.startsWith('rec')) return null;
    return payload;
  } catch {
    return null;
  }
}

// ───────────────────────── HTTP / sécurité ─────────────────────────

/** En-têtes de sécurité appliqués à TOUTES les réponses du Worker. */
function enTetesSecurite() {
  const h = new Headers();
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // CSP stricte pour l'API : aucune ressource, aucun frame.
  h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  return h;
}

/** Applique le CORS (uniquement si l'origine correspond à ALLOWED_ORIGIN). */
function appliquerCors(request, env, headers) {
  const origine = request.headers.get('Origin');
  if (origine && env.ALLOWED_ORIGIN && origine === env.ALLOWED_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', origine);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

/** Réponse JSON standard (sécurité + CORS inclus). */
function json(request, env, data, status = 200) {
  const headers = enTetesSecurite();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  appliquerCors(request, env, headers);
  return new Response(JSON.stringify(data), { status, headers });
}

/** Lit un JSON de requête avec une taille plafond (10 Ko). */
async function lireJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > 10_000) throw new Error('PAYLOAD_TROP_GROS');
  const texte = await request.text();
  if (texte.length > 10_000) throw new Error('PAYLOAD_TROP_GROS');
  try { return JSON.parse(texte); } catch { throw new Error('JSON_INVALIDE'); }
}

/** Parse l'en-tête Cookie. */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const paire of header.split(';')) {
    const i = paire.indexOf('=');
    if (i > 0) out[paire.slice(0, i).trim()] = decodeURIComponent(paire.slice(i + 1).trim());
  }
  return out;
}

/** Construit l'attribut Set-Cookie de session (HttpOnly + Secure + SameSite=Strict). */
function cookieSession(valeur) {
  // Le jeton n'est JAMAIS accessible en JS : HttpOnly. Secure: HTTPS forcé.
  // SameSite=Strict: aucune requête cross-site ne l'envoie (anti-CSRF).
  return `${SESSION_COOKIE}=${valeur}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

/** Cookie effacé (déconnexion). */
function cookieSessionVide() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// ───────────────────────── Rate limiting (en mémoire) ─────────────────────────
// Limite connue : les compteurs vivent dans l'isolate (remis à zéro au cold start).
// Suffisant pour décourager le brute-force basique ; en production : KV/Durable Objects.

const rateLimitCompteurs = new Map();

/** Vérifie et consomme une tentative. Renvoie false si la limite est atteinte. */
function rateLimit(ip, cle) {
  const maintenant = Date.now();
  const cleMap = `${ip}|${cle}`;
  let bucket = rateLimitCompteurs.get(cleMap);
  if (!bucket || maintenant - bucket.debut > RATE_FENETRE_MS) {
    bucket = { debut: maintenant, tentatives: 0 };
    rateLimitCompteurs.set(cleMap, bucket);
  }
  bucket.tentatives += 1;
  // Nettoyage grossier pour éviter une fuite mémoire infinie.
  if (rateLimitCompteurs.size > 10_000) {
    for (const [k, b] of rateLimitCompteurs) {
      if (maintenant - b.debut > RATE_FENETRE_MS) rateLimitCompteurs.delete(k);
    }
  }
  return bucket.tentatives <= RATE_MAX_TENTATIVES;
}

// ───────────────────────── Client Airtable (avec retry 429) ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Appel générique à l'API Airtable avec gestion des 429 :
 * 5 requêtes/s/base → en cas de 429, back-off exponentiel (1s, 2s, 4s) + 4 essais.
 */
async function atAppel(env, methode, chemin, corps) {
  let derniere = null;
  for (let essai = 0; essai < 4; essai++) {
    if (essai > 0) await sleep(1000 * 2 ** (essai - 1) + Math.random() * 400);
    const entetes = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` };
    const options = { method: methode, headers: entetes };
    if (corps !== undefined) {
      entetes['Content-Type'] = 'application/json';
      options.body = JSON.stringify(corps);
    }
    derniere = await fetch(`https://api.airtable.com/v0/${env.BASE_ID}/${chemin}`, options);
    if (derniere.status !== 429) return derniere; // hors rate limit : on renvoie
  }
  return derniere; // 429 persistant : le handler renverra une 429 au client
}

/** Liste paginée (100 max/page). Renvoie tous les records sur toutes les pages. */
async function atLister(env, table, { filtre, tri } = {}) {
  const resultats = [];
  let offset;
  do {
    const params = new URLSearchParams();
    if (filtre) params.set('filterByFormula', filtre);
    if (tri) {
      params.set('sort[0][field]', tri.champ);
      params.set('sort[0][direction]', tri.sens || 'asc');
    }
    params.set('pageSize', '100');
    if (offset) params.set('offset', offset);
    const res = await atAppel(env, 'GET', `${encodeURIComponent(table)}?${params}`);
    if (!res.ok) return { erreur: res.status, message: await lireMessageErreur(res) };
    const data = await res.json();
    resultats.push(...data.records);
    offset = data.offset;
  } while (offset);
  return { records: resultats };
}

/** Lecture d'un record par ID. */
async function atLire(env, table, id) {
  const res = await atAppel(env, 'GET', `${encodeURIComponent(table)}/${id}`);
  if (!res.ok) return { erreur: res.status };
  return { record: await res.json() };
}

/** Création d'un record. */
async function atCreer(env, table, champs) {
  const res = await atAppel(env, 'POST', encodeURIComponent(table), { fields: champs });
  if (!res.ok) return { erreur: res.status, message: await lireMessageErreur(res) };
  return { record: await res.json() };
}

/** Mise à jour d'un record (null pour vider un champ). */
async function atMaj(env, table, id, champs) {
  const res = await atAppel(env, 'PATCH', `${encodeURIComponent(table)}/${id}`, { fields: champs });
  if (!res.ok) return { erreur: res.status, message: await lireMessageErreur(res) };
  return { record: await res.json() };
}

/** Suppression physique d'un record. */
async function atSupprimer(env, table, id) {
  const res = await atAppel(env, 'DELETE', `${encodeURIComponent(table)}/${id}`);
  return res.ok;
}

/**
 * Upload d'une pièce jointe sur un record existant.
 * Endpoint officiel : POST /v0/{baseId}/{recordId}/{champ}/uploadAttachment
 * (JSON base64, 5 Mo max — la taille est déjà validée avant cet appel).
 */
async function atUploadAttachment(env, table, recordId, champ, base64, filename, contentType) {
  let derniere = null;
  for (let essai = 0; essai < 4; essai++) {
    if (essai > 0) await sleep(1000 * 2 ** (essai - 1) + Math.random() * 400);
    derniere = await fetch(
      `https://content.airtable.com/v0/${env.BASE_ID}/${recordId}/${encodeURIComponent(champ)}/uploadAttachment`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ contentType, filename, file: base64 })
      }
    );
    if (derniere.status !== 429) return derniere;
  }
  return derniere;
}

/** Traduit une erreur Airtable en message utilisateur (sans fuite d'infos). */
async function lireMessageErreur(res) {
  try {
    const data = await res.json();
    const type = data?.error?.type || '';
    // 422 arrive notamment quand la base a atteint ses 1 000 records (plan gratuit).
    if (res.status === 422 && /LIMIT|CAPACITY/i.test(type)) {
      return "La base de données est pleine (limite du plan gratuit). Contacte l'administrateur.";
    }
    return null;
  } catch {
    return null;
  }
}

/** Traduit une erreur Airtable en code HTTP cohérent pour le client. */
function statutDepuisAirtable(erreur) {
  if (erreur === 429) return 429;
  if (erreur === 404) return 404;
  if (erreur === 403) return 403;
  if (erreur === 422) return 507; // Insufficient Storage
  if (erreur === 401) return 502; // token mal configuré côté serveur
  return 502;
}

// ───────────────────────── Validation des fichiers ─────────────────────────

/** Assainit un nom de fichier : supprime chemins, caractères de contrôle, longueur. */
function assainirNom(nom) {
  let n = String(nom || 'fichier')
    .replace(/[\\/]+/g, '_')            // pas de séparateurs de chemin
    .replace(/[\x00-\x1f\x7f]/g, '')    // caractères de contrôle
    .replace(/^\.+/, '')                // pas de fichier caché type ".."
    .trim()
    .slice(0, 200);                     // longueur max
  if (!n) n = 'fichier';
  return n;
}

/** Extension d'un nom de fichier, en minuscules, avec le point (ex. ".png"). */
function extensionDe(nom) {
  const i = nom.lastIndexOf('.');
  return i > 0 ? nom.slice(i).toLowerCase() : '';
}

/** Vrai si l'extension est interdite (exécutable / contenu actif). */
function extensionInterdite(nom) {
  return EXT_INTERDITES.has(extensionDe(nom));
}

// Types MIME déduits de l'extension quand le navigateur n'en fournit pas.
// Indispensable pour que la lecture native (vidéo/audio) fonctionne.
const MIME_PAR_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.f4v': 'video/mp4', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.m2v': 'video/mpeg', '.ts': 'video/mp2t', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.ogv': 'video/ogg', '.vob': 'video/dvd',
  '.mxf': 'application/mxf', '.asf': 'video/x-ms-asf', '.divx': 'video/x-msvideo',
  '.rm': 'application/vnd.rn-realmedia', '.ogm': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wave': 'audio/wav', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff', '.alac': 'audio/mp4', '.ape': 'audio/x-ape', '.wv': 'audio/x-wavpack',
  '.mpc': 'audio/x-musepack', '.mka': 'audio/x-matroska', '.ac3': 'audio/ac3',
  '.eac3': 'audio/eac3', '.dts': 'audio/vnd.dts', '.amr': 'audio/amr', '.au': 'audio/basic',
  '.mid': 'audio/midi', '.midi': 'audio/midi', '.ra': 'audio/x-realaudio', '.caf': 'audio/x-caf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
  '.tif': 'image/tiff', '.avif': 'image/avif', '.ico': 'image/x-icon'
};

/** Devine le type MIME depuis le nom si le navigateur n'en a pas fourni de valable. */
function mimeDepuisNom(nom, fourni) {
  const t = String(fourni || '').trim();
  if (t && t !== 'application/octet-stream') return t;
  return MIME_PAR_EXT[extensionDe(nom)] || t || 'application/octet-stream';
}

/**
 * Normalise un chemin de dossier : "/photos/2026" → segments propres.
 * Interdit "..", vide, et les caractères dangereux (anti-injection de formule Airtable).
 */
function normaliserChemin(input) {
  if (!input) return '/';
  const parties = String(input)
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[^\p{L}\p{N}\s.\-()+]/gu, '_').slice(0, 100));
  return '/' + parties.join('/');
}

/** Échappe une valeur pour l'insérer sans danger dans une formule Airtable. */
function echapperFormule(valeur) {
  return String(valeur).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Vrai si le string ressemble à un e-mail (validation grossière côté serveur). */
function estEmail(email) {
  return typeof email === 'string' && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** Nombre de Mo → texte lisible ("512 Mo", "23 Go"). */
function formaterMo(mo) {
  const n = Number(mo) || 0;
  if (n >= 1024) {
    const go = n / 1024;
    return (Number.isInteger(go) ? go : go.toFixed(1).replace('.', ',')) + ' Go';
  }
  return Math.round(n) + ' Mo';
}

/** Nombre d'octets → texte lisible ("3 Mo"). */
function formaterOctets(octets) {
  return formaterMo(Number(octets) / (1024 * 1024));
}

// ───────────────────────── Session ─────────────────────────

/** Renvoie l'utilisateur courant (record Airtable) ou null. Re-vérifie à chaque requête. */
async function utilisateurCourant(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const jwt = cookies[SESSION_COOKIE];
  if (!jwt) return null;
  const payload = await verifierJwt(jwt, env.SESSION_SECRET);
  if (!payload) return null;
  // On relit toujours l'utilisateur : un compte supprimé perd son accès immédiatement.
  const { record, erreur } = await atLire(env, env.USERS_TABLE, payload.sub);
  if (erreur) return null;
  return {
    id: record.id,
    email: record.fields.email,
    quotaMo: Number(record.fields.quotaMo) || QUOTA_MO_DEFAUT,
    createdAt: record.fields.createdAt
  };
}

/** Renvoie un fichier SI et seulement SI il appartient à l'utilisateur (anti-IDOR). */
async function fichierProprio(env, utilisateur, id) {
  if (!/^rec[\w]{14,}$/.test(id || '')) return null; // ID Airtable invalide
  const { record, erreur } = await atLire(env, env.FILES_TABLE, id);
  if (erreur) return null;
  const proprietaire = record.fields.proprietaire;
  if (proprietaire !== utilisateur.id) return null; // IDOR bloqué ici
  return record;
}

/** Forme publique d'un record file (jamais on ne renvoie les champs bruts). */
function filePublic(record) {
  const estDossier = record.fields.type === TYPE_DOSSIER;
  return {
    id: record.id,
    nom: record.fields.nom,
    chemin: record.fields.chemin || '/',
    taille: Number(record.fields.taille) || 0,
    type: record.fields.type || 'application/octet-stream',
    supprimeLe: record.fields.supprimeLe || null,
    estDossier,
    aPieceJointe: Array.isArray(record.fields.fichier) && record.fields.fichier.length > 0,
    creeLe: record.createdTime
  };
}

/** Calcule l'octets déjà utilisés par l'utilisateur (hors corbeille). */
async function calculerQuota(env, utilisateur) {
  let total = 0;
  let page;
  do {
    const params = new URLSearchParams({
      filterByFormula: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', {supprimeLe}=BLANK())`,
      pageSize: '100'
    });
    if (page) params.set('offset', page);
    const res = await atAppel(env, 'GET', `${encodeURIComponent(env.FILES_TABLE)}?${params}`);
    if (!res.ok) break;
    const data = await res.json();
    for (const r of data.records) total += Number(r.fields.taille) || 0;
    page = data.offset;
  } while (page);
  return total;
}

/** Purge de la corbeille : supprime physiquement les fichiers de + de 30 jours. */
async function purgerCorbeille(env, utilisateur) {
  const limite = new Date(Date.now() - TRASH_DAYS * 86400_000).toISOString();
  const { records } = await atLister(env, env.FILES_TABLE, {
    filtre: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', NOT({supprimeLe}=BLANK()), IS_BEFORE({supprimeLe}, '${limite}'))`
  });
  if (!records) return;
  // Les dossiers vides supprimés sont purgés aussi (type dossier sans pièce jointe).
  for (const r of records) {
    // On ne supprime jamais un dossier qui a encore des enfants.
    if (r.fields.type === TYPE_DOSSIER) {
      const cheminDossier = `${(r.fields.chemin || '/') === '/' ? '' : r.fields.chemin}/${r.fields.nom}`;
      const enfants = await atLister(env, env.FILES_TABLE, {
        filtre: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', {supprimeLe}=BLANK(), OR({chemin}='${echapperFormule(cheminDossier)}', LEFT({chemin}, ${cheminDossier.length + 1})='${echapperFormule(cheminDossier)}/'))`
      });
      if (enfants.records && enfants.records.length > 0) continue;
    }
    await atSupprimer(env, env.FILES_TABLE, r.id);
  }
}

// ───────────────────────── Handlers : authentification ─────────────────────────

async function handlerRegister(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'inconnu';
  if (!rateLimit(ip, 'register')) {
    return json(request, env, { error: 'Trop de tentatives. Réessaie dans quelques minutes.' }, 429);
  }
  const { email, motDePasse } = await lireJson(request);
  const emailNormalise = String(email || '').trim().toLowerCase();
  // Messages volontairement génériques : ne pas révéler quel champ a échoué.
  if (!estEmail(emailNormalise) || typeof motDePasse !== 'string' || motDePasse.length < 8 || motDePasse.length > 200) {
    return json(request, env, { error: 'Identifiants invalides. E-mail invalide ou mot de passe trop court (8 caractères min).' }, 400);
  }
  // Unicité de l'e-mail.
  const existant = await atLister(env, env.USERS_TABLE, {
    filtre: `LOWER({email})='${echapperFormule(emailNormalise)}'`
  });
  if (existant.records && existant.records.length > 0) {
    return json(request, env, { error: 'Impossible de créer ce compte.' }, 409);
  }
  // Hachage PBKDF2 : sel unique + itérations élevées, jamais de clair.
  const sel = randomB64(SALT_BYTES);
  const hash = await hashPassword(motDePasse, sel, PBKDF2_ITERATIONS);
  const { record, erreur } = await atCreer(env, env.USERS_TABLE, {
    email: emailNormalise,
    passwordHash: hash,
    salt: sel,
    iterations: PBKDF2_ITERATIONS,
    quotaMo: Number(env.QUOTA_MO_DEFAULT) || QUOTA_MO_DEFAUT
  });
  if (erreur) {
    return json(request, env, { error: 'Impossible de créer ce compte.' }, statutDepuisAirtable(erreur));
  }
  // Session immédiate.
  const jwt = await signerJwt(
    { sub: record.id, email: emailNormalise, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 },
    env.SESSION_SECRET
  );
  const headers = enTetesSecurite();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.append('Set-Cookie', cookieSession(jwt));
  return new Response(JSON.stringify({ email: emailNormalise }), {
    status: 201,
    headers: appliquerCors(request, env, headers)
  });
}

async function handlerLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'inconnu';
  if (!rateLimit(ip, 'login')) {
    return json(request, env, { error: 'Trop de tentatives. Réessaie dans quelques minutes.' }, 429);
  }
  const { email, motDePasse } = await lireJson(request);
  const emailNormalise = String(email || '').trim().toLowerCase();
  if (!estEmail(emailNormalise) || typeof motDePasse !== 'string' || motDePasse.length > 200) {
    return json(request, env, { error: 'Identifiants invalides.' }, 401);
  }
  const { records } = await atLister(env, env.USERS_TABLE, {
    filtre: `LOWER({email})='${echapperFormule(emailNormalise)}'`
  });
  const utilisateur = records && records[0];
  if (!utilisateur) {
    // Hachage factice pour uniformiser le temps de réponse (anti-énumération d'e-mails).
    await hashPassword(motDePasse, randomB64(SALT_BYTES), PBKDF2_ITERATIONS);
    return json(request, env, { error: 'Identifiants invalides.' }, 401);
  }
  const iterations = Number(utilisateur.fields.iterations) || PBKDF2_ITERATIONS;
  const candidat = await hashPassword(motDePasse, utilisateur.fields.salt, iterations);
  if (!egalTempsConstant(candidat, utilisateur.fields.passwordHash)) {
    return json(request, env, { error: 'Identifiants invalides.' }, 401);
  }
  const jwt = await signerJwt(
    { sub: utilisateur.id, email: emailNormalise, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 },
    env.SESSION_SECRET
  );
  const headers = enTetesSecurite();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.append('Set-Cookie', cookieSession(jwt));
  return new Response(JSON.stringify({ email: emailNormalise }), {
    status: 200,
    headers: appliquerCors(request, env, headers)
  });
}

async function handlerLogout(request, env) {
  const headers = enTetesSecurite();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.append('Set-Cookie', cookieSessionVide());
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: appliquerCors(request, env, headers)
  });
}

async function handlerMe(request, env, utilisateur) {
  return json(request, env, {
    email: utilisateur.email,
    quotaMo: utilisateur.quotaMo,
    createdAt: utilisateur.createdAt
  });
}

/** Changement d'e-mail (profil). Re-signe le cookie car l'e-mail est dans le JWT. */
async function handlerMajProfil(request, env, utilisateur) {
  const { email } = await lireJson(request);
  const emailNormalise = String(email || '').trim().toLowerCase();
  if (!estEmail(emailNormalise)) {
    return json(request, env, { error: 'E-mail invalide.' }, 400);
  }
  if (emailNormalise === utilisateur.email) {
    return json(request, env, { email: emailNormalise });
  }
  // Unicité, en s'excluant soi-même.
  const existant = await atLister(env, env.USERS_TABLE, {
    filtre: `LOWER({email})='${echapperFormule(emailNormalise)}'`
  });
  if (existant.records && existant.records.some((r) => r.id !== utilisateur.id)) {
    return json(request, env, { error: 'Impossible de modifier ce compte.' }, 409);
  }
  const { erreur, message } = await atMaj(env, env.USERS_TABLE, utilisateur.id, { email: emailNormalise });
  if (erreur) {
    return json(request, env, { error: message || 'Modification impossible.' }, statutDepuisAirtable(erreur));
  }
  const jwt = await signerJwt(
    { sub: utilisateur.id, email: emailNormalise, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 },
    env.SESSION_SECRET
  );
  const headers = enTetesSecurite();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.append('Set-Cookie', cookieSession(jwt));
  return new Response(JSON.stringify({ email: emailNormalise }), {
    status: 200,
    headers: appliquerCors(request, env, headers)
  });
}

/** Changement de mot de passe : vérifie l'ancien, puis re-hache (sel neuf). */
async function handlerChangerMotDePasse(request, env, utilisateur) {
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'inconnu';
  if (!rateLimit(ip, 'password')) {
    return json(request, env, { error: 'Trop de tentatives. Réessaie dans quelques minutes.' }, 429);
  }
  const { actuel, nouveau } = await lireJson(request);
  if (typeof nouveau !== 'string' || nouveau.length < 8 || nouveau.length > 200) {
    return json(request, env, { error: 'Nouveau mot de passe invalide (8 caractères min).' }, 400);
  }
  const { record, erreur } = await atLire(env, env.USERS_TABLE, utilisateur.id);
  if (erreur) return json(request, env, { error: 'Compte introuvable.' }, 404);
  const iterations = Number(record.fields.iterations) || PBKDF2_ITERATIONS;
  const candidat = await hashPassword(String(actuel || ''), record.fields.salt, iterations);
  if (!egalTempsConstant(candidat, record.fields.passwordHash)) {
    return json(request, env, { error: 'Mot de passe actuel incorrect.' }, 401);
  }
  const sel = randomB64(SALT_BYTES);
  const hash = await hashPassword(nouveau, sel, PBKDF2_ITERATIONS);
  const maj = await atMaj(env, env.USERS_TABLE, utilisateur.id, {
    passwordHash: hash,
    salt: sel,
    iterations: PBKDF2_ITERATIONS
  });
  if (maj.erreur) return json(request, env, { error: 'Modification impossible.' }, statutDepuisAirtable(maj.erreur));
  return json(request, env, { ok: true });
}

// ───────────────────────── Handlers : quota ─────────────────────────

async function handlerQuota(request, env, utilisateur) {
  const utilise = await calculerQuota(env, utilisateur);
  const quotaOctets = utilisateur.quotaMo * 1024 * 1024;
  return json(request, env, {
    utiliseOctets: utilise,
    quotaOctets,
    pourcentage: Math.min(100, Math.round((utilise / quotaOctets) * 100))
  });
}

// ───────────────────────── Handlers : fichiers ─────────────────────────

async function handlerListerFichiers(request, env, utilisateur, url, ctx) {
  // Purge de la corbeille (fichiers de + de 30 jours) en tâche de fond.
  ctx.waitUntil(purgerCorbeille(env, utilisateur).catch(() => {}));
  const chemin = normaliserChemin(url.searchParams.get('chemin'));
  let filtre = `{proprietaire}='${echapperFormule(utilisateur.id)}', {supprimeLe}=BLANK(), {chemin}='${echapperFormule(chemin)}'`;
  filtre = `AND(${filtre})`;
  const triChamp = url.searchParams.get('tri') || 'nom';
  const triSens = url.searchParams.get('sens') === 'desc' ? 'desc' : 'asc';
  const champsTries = new Set(['nom', 'taille', 'type', 'creeLe']);
  const tri = champsTries.has(triChamp)
    ? (triChamp === 'creeLe' ? null : { champ: triChamp, sens: triSens })
    : { champ: 'nom', sens: triSens };
  // createdTime n'est pas triable par champ : on trie côté JS pour "creeLe".
  const { records, erreur, message } = await atLister(env, env.FILES_TABLE, { filtre, tri });
  if (erreur) {
    return json(request, env, { error: message || 'Erreur lors de la lecture.' }, statutDepuisAirtable(erreur));
  }
  let fichiers = records.map(filePublic);
  if (triChamp === 'creeLe') {
    fichiers.sort((a, b) => (triSens === 'desc' ? -1 : 1) * a.creeLe.localeCompare(b.creeLe));
  }
  return json(request, env, { fichiers, chemin });
}

async function handlerUpload(request, env, utilisateur) {
  const typeRequete = request.headers.get('Content-Type') || '';
  if (!typeRequete.includes('multipart/form-data')) {
    return json(request, env, { error: 'Requête invalide.' }, 400);
  }
  const form = await request.formData();
  const fichier = form.get('fichier');
  const chemin = normaliserChemin(form.get('chemin'));
  if (!fichier || typeof fichier === 'string' || fichier.size === 0) {
    return json(request, env, { error: 'Aucun fichier reçu.' }, 400);
  }
  // ── Validation 1 : taille (5 Mo, limite dure Airtable) ──
  if (fichier.size > MAX_FILE_BYTES) {
    return json(request, env, { error: `Fichier trop volumineux (${Math.round(MAX_FILE_BYTES / 1048576)} Mo maximum).` }, 413);
  }
  // ── Validation 2 : extension interdite ──
  const nom = assainirNom(fichier.name);
  if (extensionInterdite(nom)) {
    return json(request, env, { error: 'Type de fichier non autorisé (exécutables bloqués).' }, 415);
  }
  // ── Validation 3 : MIME (si le navigateur envoie un type actif, on force l'octet-stream) ──
  let mimeType = mimeDepuisNom(nom, fichier.type);
  if (mimeType === 'application/x-msdownload') {
    return json(request, env, { error: 'Type de fichier non autorisé.' }, 415);
  }
  // ── Validation 4 : quota utilisateur ──
  const utilise = await calculerQuota(env, utilisateur);
  const quotaOctets = utilisateur.quotaMo * 1024 * 1024;
  if (utilise + fichier.size > quotaOctets) {
    return json(request, env, { error: `Quota dépassé (${formaterMo(utilisateur.quotaMo)}). Supprime des fichiers.` }, 413);
  }
  // ── Création du record puis upload de la pièce jointe ──
  const { record, erreur, message } = await atCreer(env, env.FILES_TABLE, {
    nom,
    chemin,
    taille: fichier.size,
    type: mimeType,
    proprietaire: utilisateur.id
  });
  if (erreur) {
    return json(request, env, { error: message || 'Enregistrement impossible.' }, statutDepuisAirtable(erreur));
  }
  const octets = new Uint8Array(await fichier.arrayBuffer());
  const base64 = bytesToB64(octets);
  const resUpload = await atUploadAttachment(env, env.FILES_TABLE, record.id, 'fichier', base64, nom, mimeType);
  if (!resUpload.ok) {
    // Nettoyage : on ne laisse pas d'orphelin si l'upload a échoué.
    await atSupprimer(env, env.FILES_TABLE, record.id);
    const msg = resUpload.status === 413
      ? `Fichier trop volumineux (${Math.round(MAX_FILE_BYTES / 1048576)} Mo maximum).`
      : "Échec de l'envoi vers le stockage. Réessaie.";
    return json(request, env, { error: msg }, resUpload.status === 413 ? 413 : 502);
  }
  const maj = await resUpload.json();
  return json(request, env, { fichier: filePublic(maj) }, 201);
}

async function handlerModifierFichier(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  const { nom, chemin } = await lireJson(request);
  const champs = {};
  if (typeof nom === 'string' && nom.trim()) {
    const propre = assainirNom(nom);
    if (fichier.fields.type !== TYPE_DOSSIER && extensionInterdite(propre)) {
      return json(request, env, { error: 'Extension non autorisée.' }, 415);
    }
    champs.nom = propre;
  }
  if (typeof chemin === 'string') {
    champs.chemin = normaliserChemin(chemin);
  }
  if (Object.keys(champs).length === 0) {
    return json(request, env, { error: 'Rien à modifier.' }, 400);
  }
  const ancienChemin = fichier.fields.chemin || '/';
  const ancienNom = fichier.fields.nom;
  const { record, erreur, message } = await atMaj(env, env.FILES_TABLE, id, champs);
  if (erreur) {
    return json(request, env, { error: message || 'Modification impossible.' }, statutDepuisAirtable(erreur));
  }
  // Si c'est un dossier déplacé/renommé, on déplace aussi ses enfants (récursif par préfixe).
  if (fichier.fields.type === TYPE_DOSSIER && (champs.chemin || champs.nom)) {
    const nouveauCheminDossier = record.fields.chemin || '/';
    const nouveauNom = record.fields.nom;
    const ancienPrefixe = `${ancienChemin === '/' ? '' : ancienChemin}/${ancienNom}`;
    const nouveauPrefixe = `${nouveauCheminDossier === '/' ? '' : nouveauCheminDossier}/${nouveauNom}`;
    const { records: enfants } = await atLister(env, env.FILES_TABLE, {
      filtre: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', {supprimeLe}=BLANK(), OR({chemin}='${echapperFormule(ancienPrefixe)}', LEFT({chemin}, ${ancienPrefixe.length + 1})='${echapperFormule(ancienPrefixe)}/'))`
    });
    for (const enfant of enfants || []) {
      const suffixe = (enfant.fields.chemin || '/').slice(ancienPrefixe.length) || '';
      const cheminEnfant = (nouveauPrefixe + suffixe) || '/';
      await atMaj(env, env.FILES_TABLE, enfant.id, { chemin: normaliserChemin(cheminEnfant) });
    }
  }
  return json(request, env, { fichier: filePublic(record) });
}

async function handlerSupprimerFichier(request, env, utilisateur, id, definitif) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  // Un dossier non vide ne part pas en corbeille : protège contre les suppressions en masse accidentelles.
  const cheminDossier = `${(fichier.fields.chemin || '/') === '/' ? '' : fichier.fields.chemin}/${fichier.fields.nom}`;
  const { records: enfants } = await atLister(env, env.FILES_TABLE, {
    filtre: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', {supprimeLe}=BLANK(), OR({chemin}='${echapperFormule(cheminDossier)}', LEFT({chemin}, ${cheminDossier.length + 1})='${echapperFormule(cheminDossier)}/'))`
  });
  if (fichier.fields.type === TYPE_DOSSIER && enfants && enfants.length > 0) {
    return json(request, env, { error: "Le dossier n'est pas vide." }, 409);
  }
  if (definitif) {
    // Suppression DÉFINITIVE : uniquement pour un élément déjà dans la corbeille.
    if (!fichier.fields.supprimeLe) {
      return json(request, env, { error: "Passe d'abord par la corbeille." }, 400);
    }
    const ok = await atSupprimer(env, env.FILES_TABLE, id);
    if (!ok) return json(request, env, { error: 'Suppression impossible.' }, 502);
    return json(request, env, { ok: true, definitif: true });
  }
  // Suppression LOGIQUE : on ne pose que supprimeLe (corbeille 30 jours).
  const { record, erreur, message } = await atMaj(env, env.FILES_TABLE, id, {
    supprimeLe: new Date().toISOString()
  });
  if (erreur) {
    return json(request, env, { error: message || 'Suppression impossible.' }, statutDepuisAirtable(erreur));
  }
  return json(request, env, { fichier: filePublic(record) });
}

async function handlerCorbeille(request, env, utilisateur) {
  const { records, erreur, message } = await atLister(env, env.FILES_TABLE, {
    filtre: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', NOT({supprimeLe}=BLANK()))`,
    tri: { champ: 'supprimeLe', sens: 'desc' }
  });
  if (erreur) {
    return json(request, env, { error: message || 'Erreur.' }, statutDepuisAirtable(erreur));
  }
  return json(request, env, { fichiers: records.map(filePublic) });
}

async function handlerRestaurer(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (!fichier.fields.supprimeLe) {
    return json(request, env, { error: "Ce fichier n'est pas dans la corbeille." }, 400);
  }
  // null vide le champ Date dans l'API Airtable.
  const { record, erreur, message } = await atMaj(env, env.FILES_TABLE, id, { supprimeLe: null });
  if (erreur) {
    return json(request, env, { error: message || 'Restauration impossible.' }, statutDepuisAirtable(erreur));
  }
  return json(request, env, { fichier: filePublic(record) });
}

/**
 * Vide entièrement la corbeille de l'utilisateur (suppression définitive).
 * Les fichiers partent d'abord, puis les dossiers devenus vides (plusieurs passes).
 */
async function handlerViderCorbeille(request, env, utilisateur) {
  const { records, erreur, message } = await atLister(env, env.FILES_TABLE, {
    filtre: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', NOT({supprimeLe}=BLANK()))`
  });
  if (erreur) {
    return json(request, env, { error: message || 'Erreur.' }, statutDepuisAirtable(erreur));
  }
  let restants = records || [];
  let supprimes = 0;
  for (let passe = 0; passe < 5 && restants.length > 0; passe++) {
    const encore = [];
    for (const r of restants) {
      if (r.fields.type === TYPE_DOSSIER) {
        const cheminDossier = `${(r.fields.chemin || '/') === '/' ? '' : r.fields.chemin}/${r.fields.nom}`;
        const { records: enfants } = await atLister(env, env.FILES_TABLE, {
          filtre: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', OR({chemin}='${echapperFormule(cheminDossier)}', LEFT({chemin}, ${cheminDossier.length + 1})='${echapperFormule(cheminDossier)}/'))`
        });
        if (enfants && enfants.length > 0) { encore.push(r); continue; }
      }
      if (await atSupprimer(env, env.FILES_TABLE, r.id)) supprimes++;
    }
    if (encore.length === restants.length) break; // plus rien de supprimable
    restants = encore;
  }
  return json(request, env, { supprimes });
}

/**
 * Proxy de téléchargement/aperçu : le Worker régénère un lien frais à chaque
 * requête (les URLs Airtable expirent) et le streamme avec les bons en-têtes.
 * mode = 'attachment' (téléchargement forcé) ou 'inline' (aperçu images/PDF).
 */
async function proxyPieceJointe(request, env, fichier, mode) {
  const att = (fichier.fields.fichier || [])[0];
  if (!att || !att.url) {
    return json(request, env, { error: 'Pièce jointe introuvable.' }, 404);
  }
  // URL fraîche : on ne la stocke jamais côté GiveCloud.
  const amont = await fetch(att.url);
  if (!amont.ok || !amont.body) {
    return json(request, env, { error: 'Stockage inaccessible. Réessaie.' }, 502);
  }
  const headers = enTetesSecurite();
  headers.set('Content-Type', mode === 'inline' ? (att.type || fichier.fields.type || 'application/octet-stream') : 'application/octet-stream');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store');
  // Encodage RFC 5987 pour les noms accentués/unicode.
  const nom = fichier.fields.nom || 'fichier';
  const disposition = mode === 'inline' ? 'inline' : 'attachment';
  headers.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(nom)}`);
  if (mode === 'inline') {
    // L'aperçu ne sert qu'aux images et PDF ; la CSP sandbox neutralise tout contenu actif.
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'");
  }
  return new Response(amont.body, { status: 200, headers });
}

async function handlerTelecharger(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (fichier.fields.type === TYPE_DOSSIER) {
    return json(request, env, { error: 'Impossible de télécharger un dossier.' }, 400);
  }
  return proxyPieceJointe(request, env, fichier, 'attachment');
}

async function handlerApercu(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  const t = fichier.fields.type || '';
  const estApercu = t.startsWith('image/') || t === 'application/pdf';
  if (!estApercu) {
    return json(request, env, { error: "Aperçu non disponible pour ce type." }, 415);
  }
  return proxyPieceJointe(request, env, fichier, 'inline');
}

/**
 * Renvoie le contenu brut d'un fichier en "inline" (proxy frais).
 * Sert à la visionneuse universelle (images, vidéo, audio, PDF) ET à
 * l'éditeur de code (récupéré en texte, puis réenregistré via PUT).
 * Le CSP sandbox + X-Content-Type-Options empêchent toute exécution.
 */
async function handlerContenu(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (fichier.fields.type === TYPE_DOSSIER) {
    return json(request, env, { error: "Un dossier n'a pas de contenu." }, 400);
  }
  return proxyPieceJointe(request, env, fichier, 'inline');
}

/**
 * Enregistre le contenu texte édité (éditeur de code). Le corps est le texte
 * brut. On vide l'ancienne pièce jointe puis on upload le nouveau contenu.
 */
async function handlerEnregistrerContenu(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (fichier.fields.type === TYPE_DOSSIER) {
    return json(request, env, { error: "Un dossier n'a pas de contenu." }, 400);
  }
  const nom = fichier.fields.nom;
  if (extensionInterdite(nom)) {
    return json(request, env, { error: 'Extension non autorisée.' }, 415);
  }
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_TEXTE_BYTES + 8192) {
    return json(request, env, { error: `Fichier trop volumineux (${formaterOctets(MAX_TEXTE_BYTES)} maximum).` }, 413);
  }
  const texte = await request.text();
  const octets = new TextEncoder().encode(texte);
  if (octets.length > MAX_TEXTE_BYTES) {
    return json(request, env, { error: `Fichier trop volumineux (${formaterOctets(MAX_TEXTE_BYTES)} maximum).` }, 413);
  }
  const mimeType = fichier.fields.type || 'text/plain';
  // Remplacement de la pièce jointe : vider le champ, puis uploader la nouvelle.
  await atMaj(env, env.FILES_TABLE, id, { fichier: [] });
  const base64 = bytesToB64(octets);
  const resUpload = await atUploadAttachment(env, env.FILES_TABLE, id, 'fichier', base64, nom, mimeType);
  if (!resUpload.ok) {
    return json(request, env, { error: "Échec de l'enregistrement. Réessaie." }, 502);
  }
  const maj = await atMaj(env, env.FILES_TABLE, id, { taille: octets.length });
  if (maj.erreur) return json(request, env, { error: 'Enregistrement impossible.' }, statutDepuisAirtable(maj.erreur));
  return json(request, env, { fichier: filePublic(maj.record) });
}

// ───────────────────────── Handlers : dossiers ─────────────────────────

async function handlerCreerDossier(request, env, utilisateur) {
  const { nom, chemin } = await lireJson(request);
  const nomPropre = assainirNom(nom);
  if (!nomPropre || nom === '.') {
    return json(request, env, { error: 'Nom de dossier invalide.' }, 400);
  }
  const cheminDossier = normaliserChemin(chemin);
  // Unicité du nom dans le dossier courant.
  const existant = await atLister(env, env.FILES_TABLE, {
    filtre: `AND({proprietaire}='${echapperFormule(utilisateur.id)}', {supprimeLe}=BLANK(), {chemin}='${echapperFormule(cheminDossier)}', {nom}='${echapperFormule(nomPropre)}')`
  });
  if (existant.records && existant.records.length > 0) {
    return json(request, env, { error: 'Un élément porte déjà ce nom ici.' }, 409);
  }
  const { record, erreur, message } = await atCreer(env, env.FILES_TABLE, {
    nom: nomPropre,
    chemin: cheminDossier,
    taille: 0,
    type: TYPE_DOSSIER,
    proprietaire: utilisateur.id
  });
  if (erreur) {
    return json(request, env, { error: message || 'Création impossible.' }, statutDepuisAirtable(erreur));
  }
  return json(request, env, { fichier: filePublic(record) }, 201);
}

// ───────────────────────── Handlers : partages ─────────────────────────

async function handlerCreerPartage(request, env, utilisateur, origine) {
  const { fileId, heures } = await lireJson(request);
  const fichier = await fichierProprio(env, utilisateur, fileId);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (fichier.fields.type === TYPE_DOSSIER) {
    return json(request, env, { error: 'Les dossiers ne se partagent pas (pour l’instant).' }, 400);
  }
  if (fichier.fields.supprimeLe) {
    return json(request, env, { error: 'Fichier supprimé.' }, 400);
  }
  // Durée : nombre d'heures, ou "jamais" (0/null/"jamais"/"infini") = sans expiration.
  const texteDuree = String(heures == null ? '' : heures).trim().toLowerCase();
  const jamais = heures === null || heures === undefined || heures === 0 || heures === '0' ||
    texteDuree === 'jamais' || texteDuree === 'infini' || texteDuree === 'never' || texteDuree === '';
  let expireLe = null;
  if (!jamais) {
    const duree = Math.min(Math.max(Number(heures) || 24, 1), SHARE_MAX_HEURES);
    expireLe = new Date(Date.now() + duree * 3600_000).toISOString();
  }
  const token = randomHex(24); // 48 caractères hex : devinable impossible
  const champsPartage = { token, fichier: fileId, revoque: false };
  if (expireLe) champsPartage.expireLe = expireLe;
  const { record, erreur, message } = await atCreer(env, env.SHARES_TABLE, champsPartage);
  if (erreur) {
    return json(request, env, { error: message || 'Partage impossible.' }, statutDepuisAirtable(erreur));
  }
  return json(request, env, {
    partage: {
      id: record.id,
      token,
      expireLe,
      url: `${origine}/s/${token}`,
      nom: fichier.fields.nom
    }
  }, 201);
}

async function handlerListerPartages(request, env, utilisateur) {
  // 1) les IDs des fichiers de l'utilisateur (max ~1000 sur le plan gratuit)
  const fichiers = await atLister(env, env.FILES_TABLE, {
    filtre: `{proprietaire}='${echapperFormule(utilisateur.id)}'`
  });
  const idsFichiers = (fichiers.records || []).map((r) => r.id);
  const nomsFichiers = new Map((fichiers.records || []).map((r) => [r.id, r.fields.nom]));
  if (idsFichiers.length === 0) return json(request, env, { partages: [] });
  // 2) les partages pointant vers ces fichiers (par lots de 50 IDs pour la formule)
  const partages = [];
  for (let i = 0; i < idsFichiers.length; i += 50) {
    const lot = idsFichiers.slice(i, i + 50);
    const ou = lot.map((id) => `{fichier}='${id}'`).join(',');
    const { records, erreur } = await atLister(env, env.SHARES_TABLE, { filtre: `OR(${ou})` });
    if (erreur) return json(request, env, { error: 'Erreur.' }, statutDepuisAirtable(erreur));
    for (const r of records || []) {
      const idFichier = r.fields.fichier;
      partages.push({
        id: r.id,
        token: r.fields.token,
        expireLe: r.fields.expireLe,
        revoque: Boolean(r.fields.revoque),
        fileId: idFichier,
        nom: nomsFichiers.get(idFichier) || '(fichier supprimé)',
        expire: Boolean(r.fields.revoque) || (r.fields.expireLe && Date.parse(r.fields.expireLe) < Date.now())
      });
    }
  }
  return json(request, env, { partages });
}

async function handlerRevoquerPartage(request, env, utilisateur, id) {
  const { record, erreur } = await atLire(env, env.SHARES_TABLE, id);
  if (erreur) return json(request, env, { error: 'Partage introuvable.' }, 404);
  const idFichier = record.fields.fichier;
  // Anti-IDOR : le partage doit pointer vers un fichier de l'utilisateur.
  const fichier = idFichier ? await fichierProprio(env, utilisateur, idFichier) : null;
  if (!fichier) return json(request, env, { error: 'Partage introuvable.' }, 404);
  const maj = await atMaj(env, env.SHARES_TABLE, id, { revoque: true });
  if (maj.erreur) return json(request, env, { error: 'Révocation impossible.' }, statutDepuisAirtable(maj.erreur));
  return json(request, env, { ok: true });
}

/** Accès public par token (aucune session). Vérifie expiration + révocation. */
async function handlerLienPublic(request, env, token) {
  if (!/^[a-f0-9]{32,64}$/.test(token || '')) {
    return json(request, env, { error: 'Lien invalide.' }, 404);
  }
  const { records, erreur } = await atLister(env, env.SHARES_TABLE, {
    filtre: `{token}='${token}'`
  });
  const partage = records && records[0];
  if (!partage || partage.fields.revoque) {
    return json(request, env, { error: 'Lien invalide ou révoqué.' }, 404);
  }
  const expireLe = partage.fields.expireLe;
  // expireLe vide = lien sans expiration ("jamais").
  if (expireLe && Date.parse(expireLe) < Date.now()) {
    return json(request, env, { error: 'Ce lien a expiré.' }, 410);
  }
  const idFichier = partage.fields.fichier;
  if (!idFichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  const { record: fichier, erreur: errFichier } = await atLire(env, env.FILES_TABLE, idFichier);
  if (errFichier || fichier.fields.supprimeLe) {
    return json(request, env, { error: 'Fichier introuvable.' }, 404);
  }
  // Téléchargement forcé, jamais d'aperçu public.
  return proxyPieceJointe(request, env, fichier, 'attachment');
}

// ───────────────────────── Router ─────────────────────────

async function routerApi(request, env, url, ctx) {
  const methode = request.method.toUpperCase();
  const chemin = url.pathname;
  const origine = url.origin;

  // OPTIONS = préflight CORS
  if (methode === 'OPTIONS') {
    const headers = enTetesSecurite();
    headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
    appliquerCors(request, env, headers);
    return new Response(null, { status: 204, headers });
  }

  // ── Routes publiques ──
  if (chemin === '/api/health' && methode === 'GET') {
    // maxFichierOctets permet au front d'afficher la vraie limite (5 Mo côté Worker).
    return json(request, env, { ok: true, service: 'givecloud-api', maxFichierOctets: MAX_FILE_BYTES });
  }
  if (chemin === '/api/auth/register' && methode === 'POST') return handlerRegister(request, env);
  if (chemin === '/api/auth/login' && methode === 'POST') return handlerLogin(request, env);
  if (chemin === '/api/auth/logout' && methode === 'POST') return handlerLogout(request, env);
  if (chemin.startsWith('/s/') && methode === 'GET') {
    return handlerLienPublic(request, env, chemin.slice(3));
  }

  // ── Routes authentifiées : la session est vérifiée UNE fois, puis chaque
  //    route fichier revérifie le propriétaire (anti-IDOR en profondeur) ──
  const utilisateur = await utilisateurCourant(request, env);
  if (!utilisateur) {
    return json(request, env, { error: 'Session expirée ou absente.' }, 401);
  }

  if (chemin === '/api/auth/me' && methode === 'GET') return handlerMe(request, env, utilisateur);
  if (chemin === '/api/auth/me' && methode === 'PATCH') return handlerMajProfil(request, env, utilisateur);
  if (chemin === '/api/auth/password' && methode === 'POST') return handlerChangerMotDePasse(request, env, utilisateur);
  if (chemin === '/api/quota' && methode === 'GET') return handlerQuota(request, env, utilisateur);
  if (chemin === '/api/files' && methode === 'GET') return handlerListerFichiers(request, env, utilisateur, url, ctx);
  if (chemin === '/api/files/upload' && methode === 'POST') return handlerUpload(request, env, utilisateur);
  if (chemin === '/api/trash' && methode === 'GET') return handlerCorbeille(request, env, utilisateur);
  if (chemin === '/api/trash/vider' && methode === 'POST') return handlerViderCorbeille(request, env, utilisateur);
  if (chemin === '/api/folders' && methode === 'POST') return handlerCreerDossier(request, env, utilisateur);
  if (chemin === '/api/shares' && methode === 'GET') return handlerListerPartages(request, env, utilisateur);
  if (chemin === '/api/shares' && methode === 'POST') return handlerCreerPartage(request, env, utilisateur, origine);

  // Routes avec ID
  let m = chemin.match(/^\/api\/files\/(rec[\w]+)\/download$/);
  if (m && methode === 'GET') return handlerTelecharger(request, env, utilisateur, m[1]);
  m = chemin.match(/^\/api\/files\/(rec[\w]+)\/preview$/);
  if (m && methode === 'GET') return handlerApercu(request, env, utilisateur, m[1]);
  m = chemin.match(/^\/api\/files\/(rec[\w]+)\/content$/);
  if (m && methode === 'GET') return handlerContenu(request, env, utilisateur, m[1]);
  if (m && methode === 'PUT') return handlerEnregistrerContenu(request, env, utilisateur, m[1]);
  m = chemin.match(/^\/api\/files\/(rec[\w]+)\/restore$/);
  if (m && methode === 'POST') return handlerRestaurer(request, env, utilisateur, m[1]);
  m = chemin.match(/^\/api\/files\/(rec[\w]+)$/);
  if (m && methode === 'PATCH') return handlerModifierFichier(request, env, utilisateur, m[1]);
  if (m && methode === 'DELETE') return handlerSupprimerFichier(request, env, utilisateur, m[1], url.searchParams.get('definitif') === '1');
  m = chemin.match(/^\/api\/shares\/(rec[\w]+)$/);
  if (m && methode === 'DELETE') return handlerRevoquerPartage(request, env, utilisateur, m[1]);

  return json(request, env, { error: 'Route inconnue.' }, 404);
}

// ───────────────────────── Point d'entrée ─────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Toutes les routes /api/* et /s/* passent par le router.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) {
      try {
        return await routerApi(request, env, url, ctx);
      } catch (err) {
        // Messages d'erreur génériques : jamais de détail interne côté client.
        if (err && (err.message === 'JSON_INVALIDE' || err.message === 'PAYLOAD_TROP_GROS')) {
          return json(request, env, { error: 'Requête invalide.' }, 400);
        }
        console.error('Erreur interne:', err);
        return json(request, env, { error: 'Erreur interne.' }, 500);
      }
    }

    // Le reste = front statique (assets liés dans wrangler.toml).
    // On injecte des en-têtes de sécurité supplémentaires sur les pages HTML.
    const reponse = await env.ASSETS.fetch(request);
    const clone = new Response(reponse.body, reponse);
    const type = clone.headers.get('Content-Type') || '';
    if (type.includes('text/html')) {
      clone.headers.set('X-Content-Type-Options', 'nosniff');
      clone.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      clone.headers.set('X-Frame-Options', 'DENY');
      clone.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return clone;
  }
};
