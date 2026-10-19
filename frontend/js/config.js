// ═══════════════════════════════════════════════════════════════
// GiveCloud — configuration front
// ═══════════════════════════════════════════════════════════════
// API_BASE : URL de l'API GiveCloud.
//   - '' (vide) = même origine → recommandé : Vercel sert le front ET l'API
//     (cookies SameSite=Strict fonctionnent à coup sûr).
//   - Si le front est hébergé ailleurs (Cloudflare Pages, GitHub Pages…),
//     mets ici l'URL complète de l'API, ex. :
//     'https://givecloud.vercel.app'
//     et pense à :
//     1) ALLOWED_ORIGIN (variable d'environnement Vercel) avec ce domaine
//     2) la CSP des pages HTML : ajoute l'URL dans connect-src
window.GIVECLOUD_CONFIG = {
  API_BASE: ''
};
