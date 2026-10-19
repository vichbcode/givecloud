// ═══════════════════════════════════════════════════════════════
// GiveCloud — client Cloudflare R2 (signature AWS SigV4, sans npm)
// ═══════════════════════════════════════════════════════════════
// Génère des URLs pré-signées (upload direct navigateur → R2, et
// téléchargement direct R2 → navigateur). Le serveur ne fait que
// SIGNER : les octets ne transitent jamais par Vercel (pas de limite
// de taille, pas de bande passante consommée).
//
// Variables d'environnement requises :
//   R2_ACCOUNT_ID          — identifiant de compte Cloudflare
//   R2_BUCKET              — nom du bucket
//   R2_ACCESS_KEY_ID       — clé d'accès R2 (jeton S3)
//   R2_SECRET_ACCESS_KEY   — secret R2
//   (à défaut, R2_ACCOUNT_ID retombe sur CLOUDFLARE_ACCOUNT_ID)
// ═══════════════════════════════════════════════════════════════

const REGION = 'auto';
const SERVICE = 's3';

const enc = new TextEncoder();

/** Encodage RFC 3986 strict (comme exigé par AWS SigV4). */
function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Encode chaque segment d'un chemin en préservant les "/". */
function encoderChemin(chemin) {
  return chemin.split('/').map(encodeRfc3986).join('/');
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(texte) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(texte)));
}

async function hmac(cle, texte) {
  const k = await crypto.subtle.importKey('raw', cle, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(texte)));
}

async function cleSignature(secret, dateStamp) {
  const kDate = await hmac(enc.encode('AWS4' + secret), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

/** Horodatage SigV4 : { amzDate, dateStamp }. */
function horodatage(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260119T120000Z
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** Hôte S3 de R2. */
function hote(env) {
  const compte = env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  return `${env.R2_BUCKET}.${compte}.r2.cloudflarestorage.com`;
}

/**
 * Construit une URL pré-signée.
 * opts : { expires (s, défaut 3600), disposition (nom de fichier, pour GET),
 *          contentType (pour GET inline) }
 */
export async function urlSignee(env, methode, cle, opts = {}) {
  const host = hote(env);
  const cheminCanonique = '/' + encoderChemin(cle);
  const { amzDate, dateStamp } = horodatage();
  const portee = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const expires = String(opts.expires || 3600);

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    'X-Amz-Credential': `${env.R2_ACCESS_KEY_ID}/${portee}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': expires,
    'X-Amz-SignedHeaders': 'host'
  };
  if (opts.disposition) {
    params['response-content-disposition'] =
      `attachment; filename*=UTF-8''${encodeURIComponent(opts.disposition)}`;
  }
  if (opts.contentType) params['response-content-type'] = opts.contentType;

  const chaineCanonique = Object.keys(params).sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join('&');

  const requeteCanonique = [
    methode,
    cheminCanonique,
    chaineCanonique,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD'
  ].join('\n');

  const aSigner = [
    'AWS4-HMAC-SHA256',
    amzDate,
    portee,
    await sha256Hex(requeteCanonique)
  ].join('\n');

  const signature = hex(await hmac(await cleSignature(env.R2_SECRET_ACCESS_KEY, dateStamp), aSigner));
  return `https://${host}${cheminCanonique}?${chaineCanonique}&X-Amz-Signature=${signature}`;
}

/** Clé d'objet R2 pour un fichier donné (stable, sans le nom original). */
export function cleObjet(ownerId, fileId) {
  return `${ownerId}/${fileId}`;
}

/** URL d'upload (PUT) pré-signée, valable 1 h. */
export function urlUpload(env, cle, expires = 3600) {
  return urlSignee(env, 'PUT', cle, { expires });
}

/** URL de téléchargement (GET) pré-signée, forcée en pièce jointe. */
export function urlTelechargement(env, cle, nom, expires = 300) {
  return urlSignee(env, 'GET', cle, { expires, disposition: nom });
}

/** URL d'aperçu (GET) pré-signée, en ligne (inline), avec le bon type MIME. */
export function urlApercu(env, cle, contentType, expires = 300) {
  return urlSignee(env, 'GET', cle, { expires, contentType });
}

/** Écrit un objet depuis le serveur (URL PUT pré-signée). Renvoie true si OK. */
export async function ecrireObjet(env, cle, corps, contentType) {
  const url = await urlUpload(env, cle, 300);
  const headers = contentType ? { 'Content-Type': contentType } : {};
  const res = await fetch(url, { method: 'PUT', body: corps, headers });
  return res.ok;
}

/** Supprime un objet R2 (appel serveur signé). Renvoie true si OK. */
export async function supprimerObjet(env, cle) {
  const url = await urlSignee(env, 'DELETE', cle, { expires: 60 });
  const res = await fetch(url, { method: 'DELETE' });
  return res.ok;
}

/** Récupère la taille réelle d'un objet (HEAD). Renvoie le nombre d'octets ou null. */
export async function tailleObjet(env, cle) {
  const url = await urlSignee(env, 'HEAD', cle, { expires: 60 });
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) return null;
  const n = Number(res.headers.get('content-length'));
  return Number.isFinite(n) ? n : null;
}
