// ═══════════════════════════════════════════════════════════════
// GiveCloud — fonction serverless Vercel (route attrape-tout /api/*)
// ═══════════════════════════════════════════════════════════════
// Rôle : traduire la requête Node (req/res) en Request/Response Web
// standard, appeler la logique partagée (lib/app.js), puis renvoyer
// la réponse. AUCUNE logique métier ici — tout est dans lib/app.js.
//
// Variables d'environnement requises (dashboard Vercel → Settings) :
//   SESSION_SECRET, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
//   D1_DATABASE_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
// Optionnelles : R2_ACCOUNT_ID (= CLOUDFLARE_ACCOUNT_ID),
//                QUOTA_MO_DEFAULT, ALLOWED_ORIGIN
// ═══════════════════════════════════════════════════════════════

import { gererRequete } from '../lib/app.js';

/** Construit la configuration à partir des variables d'environnement Vercel. */
function chargerConfig() {
  return {
    SESSION_SECRET: process.env.SESSION_SECRET || '',
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '',
    D1_DATABASE_ID: process.env.D1_DATABASE_ID || '',
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '',
    R2_BUCKET: process.env.R2_BUCKET || '',
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
    QUOTA_MO_DEFAULT: process.env.QUOTA_MO_DEFAULT || '',
    ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || ''
  };
}

export default async function handler(req, res) {
  // ── Vérification de la configuration (message clair pour le déploiement) ──
  const config = chargerConfig();
  const manquantes = ['SESSION_SECRET', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
    'D1_DATABASE_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
    .filter(function (cle) { return !config[cle]; });
  if (manquantes.length > 0) {
    // On log le détail côté serveur, on ne renvoie jamais quoi que ce soit au client.
    console.error('Variables d\'environnement manquantes sur Vercel :', manquantes.join(', '));
    res.status(500).json({ error: 'Configuration serveur incomplète.' });
    return;
  }

  try {
    // ── Node req → Request Web ──
    const protocole = req.headers['x-forwarded-proto'] || 'https';
    const hote = req.headers.host || 'givecloud.vercel.app';
    const url = protocole + '://' + hote + req.url;

    const entetes = new Headers();
    for (const [cle, valeur] of Object.entries(req.headers)) {
      if (Array.isArray(valeur)) {
        valeur.forEach(function (v) { entetes.append(cle, v); });
      } else if (valeur !== undefined) {
        entetes.set(cle, valeur);
      }
    }

    const aCorps = !['GET', 'HEAD'].includes(req.method);
    const options = { method: req.method, headers: entetes };
    if (aCorps) {
      // On passe le flux brut à Request : formData()/json() le liront.
      // duplex:'half' est requis par le standard quand le corps est un flux.
      options.body = req;
      options.duplex = 'half';
    }
    const request = new Request(url, options);

    // ── Logique GiveCloud ──
    const reponse = await gererRequete(request, config);

    // ── Response Web → Node res ──
    res.status(reponse.status);
    reponse.headers.forEach(function (valeur, cle) {
      // Set-Cookie peut apparaître plusieurs fois : on utilise getSetCookie().
      if (cle.toLowerCase() === 'set-cookie') return;
      res.setHeader(cle, valeur);
    });
    const cookies = typeof reponse.headers.getSetCookie === 'function'
      ? reponse.headers.getSetCookie()
      : (reponse.headers.get('Set-Cookie') ? [reponse.headers.get('Set-Cookie')] : []);
    if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const tampon = Buffer.from(await reponse.arrayBuffer());
    res.send(tampon);
  } catch (err) {
    console.error('Erreur fonction Vercel:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erreur interne.' });
    } else {
      res.end();
    }
  }
}
