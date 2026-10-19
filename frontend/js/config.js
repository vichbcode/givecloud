// ═══════════════════════════════════════════════════════════════
// GiveCloud — configuration front
// ═══════════════════════════════════════════════════════════════
// API_BASE : URL du Worker GiveCloud.
//   - '' (vide) = même origine → recommandé : le Worker sert le front
//     (cookies SameSite=Strict fonctionnent à coup sûr).
//   - Si le front est hébergé ailleurs (Cloudflare Pages, GitHub Pages…),
//     mets ici l'URL complète du Worker, ex. :
//     'https://givecloud-api.ton-subdomain.workers.dev'
//     et pense à :
//     1) ALLOWED_ORIGIN dans worker/wrangler.toml (puis wrangler deploy)
//     2) la CSP des pages HTML : ajoute l'URL du Worker dans connect-src
//        (ex. connect-src 'self' https://givecloud-api.xxx.workers.dev)
window.GIVECLOUD_CONFIG = {
  API_BASE: ''
};
