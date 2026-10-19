// ═══════════════════════════════════════════════════════════════
// GiveCloud — thème clair/sombre (partagé par toutes les pages)
// Le thème est la SEULE chose stockée en localStorage (jamais de jeton).
// ═══════════════════════════════════════════════════════════════
(function () {
  const CLE = 'gc-theme';

  /** Applique le thème sur <html data-theme>. */
  function appliquer(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'sombre' ? '#06060e' : '#0000f2');
  }

  // Thème au chargement : préférence système, ou choix mémorisé.
  const sauvegarde = localStorage.getItem(CLE);
  const systeme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair';
  appliquer(sauvegarde || systeme);

  // Bascule (bouton avec l'id btn-theme).
  document.addEventListener('DOMContentLoaded', function () {
    const bouton = document.getElementById('btn-theme');
    if (!bouton) return;
    bouton.addEventListener('click', function () {
      const actuel = document.documentElement.getAttribute('data-theme') === 'sombre' ? 'clair' : 'sombre';
      appliquer(actuel);
      localStorage.setItem(CLE, actuel);
      bouton.textContent = actuel === 'sombre' ? ':clair:' : ':sombre:';
    });
    // Texte initial du bouton.
    bouton.textContent = document.documentElement.getAttribute('data-theme') === 'sombre' ? ':clair:' : ':sombre:';
  });

  // Petit utilitaire de toast partagé.
  window.GC_toast = function (message, genre) {
    const zone = document.getElementById('toasts');
    if (!zone) return;
    const t = document.createElement('div');
    t.className = 'toast' + (genre ? ' ' + genre : '');
    t.textContent = message; // textContent uniquement : anti-XSS
    zone.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  };
})();
