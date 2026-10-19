// ═══════════════════════════════════════════════════════════════
// GiveCloud — logique API
// Cible : fonction serverless Vercel (api/index.js) qui appelle
// gererRequete(request, config). Stockage : Cloudflare D1
// (métadonnées) + Cloudflare R2 (fichiers, upload direct).
// ═══════════════════════════════════════════════════════════════
//
// Routes gérées :
//   GET    /api/health              → vérification de vie
//   POST   /api/auth/register       → inscription (PBKDF2)
//   POST   /api/auth/login          → connexion (cookie HttpOnly)
//   POST   /api/auth/logout         → déconnexion
//   GET    /api/auth/me             → profil courant
//   PATCH  /api/auth/me             → changer l'e-mail
//   POST   /api/auth/password       → changer le mot de passe
//   GET    /api/quota               → jauge de stockage
//   GET    /api/files?chemin=/…     → liste des fichiers du dossier courant
//   POST   /api/files/upload        → autorisation d'envoi (URL R2 pré-signée)
//   POST   /api/files/:id/finalize  → clôture d'un envoi direct vers R2
//   PATCH  /api/files/:id           → renommer / déplacer
//   DELETE /api/files/:id           → corbeille (supprimeLe = maintenant)
//   DELETE /api/files/:id?definitif=1 → suppression définitive (déjà en corbeille)
//   GET    /api/files/:id/download  → redirection R2 (URL pré-signée)
//   GET    /api/files/:id/content   → contenu inline (visionneuse universelle)
//   PUT    /api/files/:id/content   → enregistrer le texte (éditeur de code)
//   POST   /api/folders             → créer un dossier
//   GET    /api/trash               → corbeille
//   POST   /api/trash/vider         → vider la corbeille
//   POST   /api/files/:id/restore   → restaurer de la corbeille
//   POST   /api/shares              → créer un lien de partage (heures ou "jamais")
//   GET    /api/shares              → mes partages
//   DELETE /api/shares/:id          → révoquer un partage
//   GET    /api/s/:token            → téléchargement public (avec expiration)
// ═══════════════════════════════════════════════════════════════

// ───────────────────────── Dépendances ─────────────────────────

import * as db from './db.js';
import * as r2 from './r2.js';

// ───────────────────────── Constantes ─────────────────────────

// Taille maximale d'un fichier envoyé vers R2 : 1 Go.
// L'upload est direct navigateur → R2 (URL pré-signée), donc la limite de
// corps des fonctions Vercel (~4,5 Mo) ne s'applique PAS aux fichiers.
// « Gros mais pas trop » : au-delà, il faudrait un upload multipart R2.
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

// PBKDF2 : 210 000 itérations = recommandation OWASP actuelle pour PBKDF2-SHA256.
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;   // sel unique par utilisateur
const HASH_BITS = 256;   // sortie de 32 octets

// Durée de vie du cookie de session (7 jours).
const SESSION_DAYS = 7;
const SESSION_COOKIE = 'gc_session';

// Corbeille : purge physique après 30 jours.
const TRASH_DAYS = 30;

// Quota de stockage par défaut d'un nouveau compte : 20 Go.
// (Surchargeable via la variable d'environnement QUOTA_MO_DEFAULT.)
const QUOTA_MO_DEFAUT = 20 * 1024;

// Limite d'écriture depuis l'éditeur de code : identique à l'upload.
const MAX_TEXTE_BYTES = 3 * 1024 * 1024;

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

// ───────────────────────── Erreurs de stockage ─────────────────────────

/** Traduit une erreur du dépôt (D1/R2) en code HTTP cohérent pour le client. */
function statutDepuisErreur(erreur) {
  if (erreur === 429) return 429;
  if (erreur === 404) return 404;
  if (erreur === 403) return 403;
  if (erreur === 422) return 507; // capacité / contrainte (base pleine, doublon)
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
 * Interdit "..", le vide, et les caractères dangereux.
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

/** Renvoie l'utilisateur courant ou null. Re-vérifie à chaque requête. */
async function utilisateurCourant(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const jwt = cookies[SESSION_COOKIE];
  if (!jwt) return null;
  const payload = await verifierJwt(jwt, env.SESSION_SECRET);
  if (!payload) return null;
  // On relit toujours l'utilisateur : un compte supprimé perd son accès immédiatement.
  const { record, erreur } = await db.lire(env, 'users', payload.sub);
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
  if (!/^rec[\w]{14,}$/.test(id || '')) return null; // identifiant invalide
  const { record, erreur } = await db.lire(env, 'files', id);
  if (erreur) return null;
  if (record.fields.proprietaire !== utilisateur.id) return null; // IDOR bloqué ici
  return record;
}

/** Chemin complet d'un élément : "/dossier/nom". */
function cheminComplet(record) {
  const base = (record.fields.chemin || '/') === '/' ? '' : record.fields.chemin;
  return `${base}/${record.fields.nom}`;
}

/** Forme publique d'un fichier (jamais on ne renvoie les champs internes). */
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
    aPieceJointe: Boolean(record.fields.r2Key),
    creeLe: record.createdTime
  };
}

/** Octets déjà utilisés par l'utilisateur (hors corbeille). */
async function calculerQuota(env, utilisateur) {
  return db.tailleUtilisee(env, utilisateur.id);
}

/** Purge de la corbeille : supprime physiquement les fichiers de + de 30 jours. */
async function purgerCorbeille(env, utilisateur) {
  const limite = new Date(Date.now() - TRASH_DAYS * 86400_000).toISOString();
  const expires = await db.expiresCorbeille(env, utilisateur.id, limite);
  for (const r of expires) {
    // On ne supprime jamais un dossier qui a encore des enfants actifs.
    if (r.fields.type === TYPE_DOSSIER) {
      const enfants = await db.enfantsPrefixe(env, utilisateur.id, cheminComplet(r));
      if (enfants.length > 0) continue;
    }
    if (r.fields.r2Key) await r2.supprimerObjet(env, r.fields.r2Key).catch(() => {});
    await db.supprimer(env, 'files', r.id);
  }
}

// ───────────────────────── Handlers : authentification ─────────────────────────

async function handlerRegister(request, env) {
  // IP réelle : Cloudflare, sinon Vercel (X-Forwarded-For : "ip1, ip2").
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || request.headers.get('X-Real-IP')
    || 'inconnu';
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
  const existant = await db.userParEmail(env, emailNormalise);
  if (existant) {
    return json(request, env, { error: 'Impossible de créer ce compte.' }, 409);
  }
  // Hachage PBKDF2 : sel unique + itérations élevées, jamais de clair.
  const sel = randomB64(SALT_BYTES);
  const hash = await hashPassword(motDePasse, sel, PBKDF2_ITERATIONS);
  const { record, erreur } = await db.creer(env, 'users', {
    email: emailNormalise,
    passwordHash: hash,
    salt: sel,
    iterations: PBKDF2_ITERATIONS,
    quotaMo: Number(env.QUOTA_MO_DEFAULT) || QUOTA_MO_DEFAUT
  });
  if (erreur) {
    return json(request, env, { error: 'Impossible de créer ce compte.' }, statutDepuisErreur(erreur));
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
  // IP réelle : Cloudflare, sinon Vercel (X-Forwarded-For : "ip1, ip2").
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || request.headers.get('X-Real-IP')
    || 'inconnu';
  if (!rateLimit(ip, 'login')) {
    return json(request, env, { error: 'Trop de tentatives. Réessaie dans quelques minutes.' }, 429);
  }
  const { email, motDePasse } = await lireJson(request);
  const emailNormalise = String(email || '').trim().toLowerCase();
  if (!estEmail(emailNormalise) || typeof motDePasse !== 'string' || motDePasse.length > 200) {
    return json(request, env, { error: 'Identifiants invalides.' }, 401);
  }
  const utilisateur = await db.userParEmail(env, emailNormalise);
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
  const existant = await db.userParEmail(env, emailNormalise);
  if (existant && existant.id !== utilisateur.id) {
    return json(request, env, { error: 'Impossible de modifier ce compte.' }, 409);
  }
  const { erreur, message } = await db.maj(env, 'users', utilisateur.id, { email: emailNormalise });
  if (erreur) {
    return json(request, env, { error: message || 'Modification impossible.' }, statutDepuisErreur(erreur));
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
  const { record, erreur } = await db.lire(env, 'users', utilisateur.id);
  if (erreur) return json(request, env, { error: 'Compte introuvable.' }, 404);
  const iterations = Number(record.fields.iterations) || PBKDF2_ITERATIONS;
  const candidat = await hashPassword(String(actuel || ''), record.fields.salt, iterations);
  if (!egalTempsConstant(candidat, record.fields.passwordHash)) {
    return json(request, env, { error: 'Mot de passe actuel incorrect.' }, 401);
  }
  const sel = randomB64(SALT_BYTES);
  const hash = await hashPassword(nouveau, sel, PBKDF2_ITERATIONS);
  const maj = await db.maj(env, 'users', utilisateur.id, {
    passwordHash: hash,
    salt: sel,
    iterations: PBKDF2_ITERATIONS
  });
  if (maj.erreur) return json(request, env, { error: 'Modification impossible.' }, statutDepuisErreur(maj.erreur));
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
  // Purge de la corbeille (fichiers de + de 30 jours).
  await purgerCorbeille(env, utilisateur).catch(() => {});
  const chemin = normaliserChemin(url.searchParams.get('chemin'));
  const triChamp = url.searchParams.get('tri') || 'nom';
  const triSens = url.searchParams.get('sens') === 'desc' ? 'desc' : 'asc';
  const champsTries = new Set(['nom', 'taille', 'type', 'creeLe']);
  const champ = champsTries.has(triChamp) ? triChamp : 'nom';
  const fichiers = (await db.fichiersDossier(env, utilisateur.id, chemin, champ, triSens)).map(filePublic);
  return json(request, env, { fichiers, chemin });
}

/** Étape 1 de l'upload : autorise un envoi direct vers R2 (URL pré-signée). */
async function handlerDemanderUpload(request, env, utilisateur) {
  const { nom: nomBrut, chemin: cheminBrut, taille, type } = await lireJson(request);
  const nom = assainirNom(nomBrut);
  if (extensionInterdite(nom)) {
    return json(request, env, { error: 'Type de fichier non autorisé (exécutables bloqués).' }, 415);
  }
  const mimeType = mimeDepuisNom(nom, type);
  if (mimeType === 'application/x-msdownload') {
    return json(request, env, { error: 'Type de fichier non autorisé.' }, 415);
  }
  const tailleDeclaree = Number(taille) || 0;
  if (tailleDeclaree <= 0) {
    return json(request, env, { error: 'Taille de fichier invalide.' }, 400);
  }
  if (tailleDeclaree > MAX_FILE_BYTES) {
    return json(request, env, { error: `Fichier trop volumineux (${formaterOctets(MAX_FILE_BYTES)} maximum).` }, 413);
  }
  // Quota (indicatif : revérifié à la clôture avec la taille réelle).
  const utilise = await calculerQuota(env, utilisateur);
  if (utilise + tailleDeclaree > utilisateur.quotaMo * 1024 * 1024) {
    return json(request, env, { error: `Quota dépassé (${formaterMo(utilisateur.quotaMo)}). Supprime des fichiers.` }, 413);
  }
  const cle = `${utilisateur.id}/${db.nouvelId()}`;
  const uploadUrl = await r2.urlUpload(env, cle, 3600);
  return json(request, env, {
    uploadUrl, cle, maxFichierOctets: MAX_FILE_BYTES,
    nom, chemin: normaliserChemin(cheminBrut), type: mimeType
  });
}

/** Étape 2 de l'upload : clôture — vérifie l'objet R2 puis crée l'entrée. */
async function handlerFinaliserUpload(request, env, utilisateur) {
  const { cle, nom: nomBrut, chemin: cheminBrut, type } = await lireJson(request);
  const prefixe = `${utilisateur.id}/`;
  if (typeof cle !== 'string' || !cle.startsWith(prefixe)) {
    return json(request, env, { error: "Référence d'envoi invalide." }, 400);
  }
  const nom = assainirNom(nomBrut);
  if (extensionInterdite(nom)) {
    return json(request, env, { error: 'Type de fichier non autorisé (exécutables bloqués).' }, 415);
  }
  const mimeType = mimeDepuisNom(nom, type);
  const chemin = normaliserChemin(cheminBrut);
  // Taille réelle = source de vérité (une URL pré-signée ne limite pas la taille).
  const tailleReelle = await r2.tailleObjet(env, cle);
  if (tailleReelle === null) {
    return json(request, env, { error: 'Envoi introuvable. Réessaie.' }, 400);
  }
  if (tailleReelle > MAX_FILE_BYTES) {
    await r2.supprimerObjet(env, cle).catch(() => {});
    return json(request, env, { error: `Fichier trop volumineux (${formaterOctets(MAX_FILE_BYTES)} maximum).` }, 413);
  }
  const utilise = await calculerQuota(env, utilisateur);
  if (utilise + tailleReelle > utilisateur.quotaMo * 1024 * 1024) {
    await r2.supprimerObjet(env, cle).catch(() => {});
    return json(request, env, { error: `Quota dépassé (${formaterMo(utilisateur.quotaMo)}). Supprime des fichiers.` }, 413);
  }
  const { record, erreur, message } = await db.creer(env, 'files', {
    nom, chemin, taille: tailleReelle, type: mimeType, proprietaire: utilisateur.id, r2Key: cle
  });
  if (erreur) {
    await r2.supprimerObjet(env, cle).catch(() => {});
    return json(request, env, { error: message || 'Enregistrement impossible.' }, statutDepuisErreur(erreur));
  }
  return json(request, env, { fichier: filePublic(record) }, 201);
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
  const { record, erreur, message } = await db.maj(env, 'files', id, champs);
  if (erreur) {
    return json(request, env, { error: message || 'Modification impossible.' }, statutDepuisErreur(erreur));
  }
  // Si c'est un dossier déplacé/renommé, on déplace aussi ses enfants (par préfixe).
  if (fichier.fields.type === TYPE_DOSSIER && (champs.chemin || champs.nom)) {
    const ancienPrefixe = `${ancienChemin === '/' ? '' : ancienChemin}/${ancienNom}`;
    const nouveauPrefixe = cheminComplet(record);
    if (ancienPrefixe !== nouveauPrefixe) {
      await db.renommerPrefixe(env, utilisateur.id, ancienPrefixe, nouveauPrefixe);
    }
  }
  return json(request, env, { fichier: filePublic(record) });
}

async function handlerSupprimerFichier(request, env, utilisateur, id, definitif) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  // Un dossier non vide ne part pas en corbeille : protège contre les suppressions en masse accidentelles.
  const enfants = await db.enfantsPrefixe(env, utilisateur.id, cheminComplet(fichier));
  if (fichier.fields.type === TYPE_DOSSIER && enfants.length > 0) {
    return json(request, env, { error: "Le dossier n'est pas vide." }, 409);
  }
  if (definitif) {
    // Suppression DÉFINITIVE : uniquement pour un élément déjà dans la corbeille.
    if (!fichier.fields.supprimeLe) {
      return json(request, env, { error: "Passe d'abord par la corbeille." }, 400);
    }
    if (fichier.fields.r2Key) await r2.supprimerObjet(env, fichier.fields.r2Key).catch(() => {});
    const ok = await db.supprimer(env, 'files', id);
    if (!ok) return json(request, env, { error: 'Suppression impossible.' }, 502);
    return json(request, env, { ok: true, definitif: true });
  }
  // Suppression LOGIQUE : on ne pose que supprimeLe (corbeille 30 jours).
  const { record, erreur, message } = await db.maj(env, 'files', id, {
    supprimeLe: new Date().toISOString()
  });
  if (erreur) {
    return json(request, env, { error: message || 'Suppression impossible.' }, statutDepuisErreur(erreur));
  }
  return json(request, env, { fichier: filePublic(record) });
}

async function handlerCorbeille(request, env, utilisateur) {
  const fichiers = (await db.fichiersCorbeille(env, utilisateur.id)).map(filePublic);
  return json(request, env, { fichiers });
}

async function handlerRestaurer(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (!fichier.fields.supprimeLe) {
    return json(request, env, { error: "Ce fichier n'est pas dans la corbeille." }, 400);
  }
  const { record, erreur, message } = await db.maj(env, 'files', id, { supprimeLe: null });
  if (erreur) {
    return json(request, env, { error: message || 'Restauration impossible.' }, statutDepuisErreur(erreur));
  }
  return json(request, env, { fichier: filePublic(record) });
}

/**
 * Vide entièrement la corbeille de l'utilisateur (suppression définitive).
 * Les fichiers partent d'abord, puis les dossiers devenus vides (plusieurs passes).
 */
async function handlerViderCorbeille(request, env, utilisateur) {
  const records = await db.fichiersCorbeille(env, utilisateur.id);
  let restants = records;
  let supprimes = 0;
  for (let passe = 0; passe < 5 && restants.length > 0; passe++) {
    const encore = [];
    for (const r of restants) {
      if (r.fields.type === TYPE_DOSSIER) {
        const enfants = await db.enfantsPrefixe(env, utilisateur.id, cheminComplet(r));
        if (enfants.length > 0) { encore.push(r); continue; }
      }
      if (r.fields.r2Key) await r2.supprimerObjet(env, r.fields.r2Key).catch(() => {});
      if (await db.supprimer(env, 'files', r.id)) supprimes++;
    }
    if (encore.length === restants.length) break; // plus rien de supprimable
    restants = encore;
  }
  return json(request, env, { supprimes });
}

/**
 * Sert un objet R2 via redirection vers une URL pré-signée : aucun octet ne
 * transite par Vercel (ni bande passante, ni limite de taille).
 * mode = 'attachment' (téléchargement forcé) ou 'inline' (aperçu/visionneuse).
 */
async function servirObjet(request, env, fichier, mode) {
  const cle = fichier.fields.r2Key;
  if (!cle) {
    return json(request, env, { error: 'Fichier introuvable.' }, 404);
  }
  const nom = fichier.fields.nom || 'fichier';
  const url = mode === 'attachment'
    ? await r2.urlTelechargement(env, cle, nom)
    : await r2.urlApercu(env, cle, fichier.fields.type || 'application/octet-stream');
  const headers = enTetesSecurite();
  headers.set('Location', url);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(null, { status: 302, headers });
}

async function handlerTelecharger(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (fichier.fields.type === TYPE_DOSSIER) {
    return json(request, env, { error: 'Impossible de télécharger un dossier.' }, 400);
  }
  return servirObjet(request, env, fichier, 'attachment');
}

async function handlerApercu(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  const t = fichier.fields.type || '';
  const estApercu = t.startsWith('image/') || t === 'application/pdf';
  if (!estApercu) {
    return json(request, env, { error: "Aperçu non disponible pour ce type." }, 415);
  }
  return servirObjet(request, env, fichier, 'inline');
}

/**
 * Contenu brut d'un fichier, servi en ligne (inline) quel que soit son type.
 * Sert à la visionneuse universelle (images, vidéo, audio, PDF) ET à
 * l'éditeur de code (récupéré en texte, puis réenregistré via PUT).
 * Le CSP sandbox + X-Content-Type-Options empêchent toute exécution.
 */
async function handlerContenu(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (fichier.fields.type === TYPE_DOSSIER) {
    return json(request, env, { error: 'Un dossier n\'a pas de contenu.' }, 400);
  }
  return servirObjet(request, env, fichier, 'inline');
}

/**
 * Enregistre le contenu texte édité (éditeur de code). Le corps est le texte
 * brut. On vide l'ancienne pièce jointe puis on upload le nouveau contenu.
 */
async function handlerEnregistrerContenu(request, env, utilisateur, id) {
  const fichier = await fichierProprio(env, utilisateur, id);
  if (!fichier) return json(request, env, { error: 'Fichier introuvable.' }, 404);
  if (fichier.fields.type === TYPE_DOSSIER) {
    return json(request, env, { error: 'Un dossier n\'a pas de contenu.' }, 400);
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
  // Réécrit l'objet R2 (même clé si le fichier existait déjà, sinon nouvelle).
  const cle = fichier.fields.r2Key || `${utilisateur.id}/${db.nouvelId()}`;
  const ok = await r2.ecrireObjet(env, cle, octets, mimeType);
  if (!ok) {
    return json(request, env, { error: "Échec de l'enregistrement. Réessaie." }, 502);
  }
  const maj = await db.maj(env, 'files', id, { taille: octets.length, r2Key: cle });
  if (maj.erreur) return json(request, env, { error: 'Enregistrement impossible.' }, statutDepuisErreur(maj.erreur));
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
  if (await db.elementExistant(env, utilisateur.id, cheminDossier, nomPropre)) {
    return json(request, env, { error: 'Un élément porte déjà ce nom ici.' }, 409);
  }
  const { record, erreur, message } = await db.creer(env, 'files', {
    nom: nomPropre,
    chemin: cheminDossier,
    taille: 0,
    type: TYPE_DOSSIER,
    proprietaire: utilisateur.id
  });
  if (erreur) {
    return json(request, env, { error: message || 'Création impossible.' }, statutDepuisErreur(erreur));
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
  const { record, erreur, message } = await db.creer(env, 'shares', champsPartage);
  if (erreur) {
    return json(request, env, { error: message || 'Partage impossible.' }, statutDepuisErreur(erreur));
  }
  return json(request, env, {
    partage: {
      id: record.id,
      token,
      expireLe,
      url: `${origine}/api/s/${token}`,
      nom: fichier.fields.nom
    }
  }, 201);
}

async function handlerListerPartages(request, env, utilisateur) {
  const lignes = await db.sharesDeOwner(env, utilisateur.id);
  const partages = lignes.map((l) => ({
    id: l.id,
    token: l.token,
    expireLe: l.expire_le,
    revoque: Boolean(l.revoque),
    fileId: l.file_id,
    nom: l.nom || '(fichier supprimé)',
    expire: Boolean(l.revoque) || (l.expire_le && Date.parse(l.expire_le) < Date.now())
  }));
  return json(request, env, { partages });
}

async function handlerRevoquerPartage(request, env, utilisateur, id) {
  const { record, erreur } = await db.lire(env, 'shares', id);
  if (erreur) return json(request, env, { error: 'Partage introuvable.' }, 404);
  const idFichier = record.fields.fichier;
  // Anti-IDOR : le partage doit pointer vers un fichier de l'utilisateur.
  const fichier = idFichier ? await fichierProprio(env, utilisateur, idFichier) : null;
  if (!fichier) return json(request, env, { error: 'Partage introuvable.' }, 404);
  const maj = await db.maj(env, 'shares', id, { revoque: 1 });
  if (maj.erreur) return json(request, env, { error: 'Révocation impossible.' }, statutDepuisErreur(maj.erreur));
  return json(request, env, { ok: true });
}

/** Accès public par token (aucune session). Vérifie expiration + révocation. */
async function handlerLienPublic(request, env, token) {
  if (!/^[a-f0-9]{32,64}$/.test(token || '')) {
    return json(request, env, { error: 'Lien invalide.' }, 404);
  }
  const partage = await db.shareParToken(env, token);
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
  const { record: fichier, erreur: errFichier } = await db.lire(env, 'files', idFichier);
  if (errFichier || fichier.fields.supprimeLe) {
    return json(request, env, { error: 'Fichier introuvable.' }, 404);
  }
  // Téléchargement forcé, jamais d'aperçu public.
  return servirObjet(request, env, fichier, 'attachment');
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
    // maxFichierOctets permet au front d'afficher la vraie limite (1 Go via R2).
    return json(request, env, { ok: true, service: 'givecloud-api', maxFichierOctets: MAX_FILE_BYTES });
  }
  if (chemin === '/api/auth/register' && methode === 'POST') return handlerRegister(request, env);
  if (chemin === '/api/auth/login' && methode === 'POST') return handlerLogin(request, env);
  if (chemin === '/api/auth/logout' && methode === 'POST') return handlerLogout(request, env);
  if (chemin.startsWith('/api/s/') && methode === 'GET') {
    return handlerLienPublic(request, env, chemin.slice(7));
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
  if (chemin === '/api/files/upload' && methode === 'POST') return handlerDemanderUpload(request, env, utilisateur);
  if (chemin === '/api/files/finalize' && methode === 'POST') return handlerFinaliserUpload(request, env, utilisateur);
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

// ───────────────────────── Point d'entrée (Vercel) ─────────────────────────
// Adapté par api/index.js. `config` = les variables d'environnement
// Vercel (CLOUDFLARE_*, D1_DATABASE_ID, R2_*, SESSION_SECRET…).

/** Traite une requête Web (Request) et renvoie une Response. */
export async function gererRequete(request, config) {
  const url = new URL(request.url);
  try {
    return await routerApi(request, config, url, null);
  } catch (err) {
    // Messages d'erreur génériques : jamais de détail interne côté client.
    if (err && (err.message === 'JSON_INVALIDE' || err.message === 'PAYLOAD_TROP_GROS')) {
      return json(request, config, { error: 'Requête invalide.' }, 400);
    }
    console.error('Erreur interne:', err);
    return json(request, config, { error: 'Erreur interne.' }, 500);
  }
}
