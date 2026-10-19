// ═══════════════════════════════════════════════════════════════
// GiveCloud — page vitrine : menu, onglets, démo upload, scroll
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── Menu mobile ──
  const btnBurger = document.getElementById('btn-burger');
  const menuMobile = document.getElementById('menu-mobile');
  if (btnBurger && menuMobile) {
    btnBurger.addEventListener('click', function () {
      const ouvert = menuMobile.classList.toggle('ouvert');
      btnBurger.setAttribute('aria-expanded', String(ouvert));
    });
    // Ferme le menu après un clic sur un lien.
    menuMobile.querySelectorAll('a').forEach(function (lien) {
      lien.addEventListener('click', function () {
        menuMobile.classList.remove('ouvert');
        btnBurger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ── Onglets :Web: / :Mobile: (sémantique ARIA) ──
  const tabWeb = document.getElementById('tab-web');
  const tabMobile = document.getElementById('tab-mobile');
  const panneauWeb = document.getElementById('panneau-web');
  const panneauMobile = document.getElementById('panneau-mobile');

  function activerOnglet(ongletActif, autreOnglet, panneauActif, panneauAutre) {
    ongletActif.setAttribute('aria-selected', 'true');
    autreOnglet.setAttribute('aria-selected', 'false');
    panneauActif.hidden = false;
    panneauAutre.hidden = true;
  }
  if (tabWeb && tabMobile && panneauWeb && panneauMobile) {
    tabWeb.addEventListener('click', function () {
      activerOnglet(tabWeb, tabMobile, panneauWeb, panneauMobile);
    });
    tabMobile.addEventListener('click', function () {
      activerOnglet(tabMobile, tabWeb, panneauMobile, panneauWeb);
    });
  }

  // ── Démo d'upload (sans compte, animation locale uniquement) ──
  const zone = document.getElementById('zone-depot-demo');
  const input = document.getElementById('input-demo');
  const barre = document.getElementById('barre-demo');
  const statut = document.getElementById('statut-demo');
  const barreProgression = barre ? barre.parentElement : null;

  function lancerDemo(nomFichier) {
    if (!barre || !statut) return;
    statut.textContent = '// envoi de ' + nomFichier + '…';
    let progres = 0;
    barre.style.width = '0%';
    const minuteur = setInterval(function () {
      progres = Math.min(100, progres + Math.random() * 16 + 4);
      barre.style.width = progres + '%';
      if (barreProgression) barreProgression.setAttribute('aria-valuenow', String(Math.round(progres)));
      if (progres >= 100) {
        clearInterval(minuteur);
        statut.textContent = '// démo terminée — crée un compte pour un vrai dépôt';
        if (window.GC_toast) window.GC_toast('Ceci est une démonstration. Crée un compte pour envoyer de vrais fichiers !', 'succes');
      }
    }, 160);
  }

  if (zone && input) {
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    // Glisser-déposer sur la zone de démo.
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault();
        zone.classList.add('survol');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault();
        zone.classList.remove('survol');
      });
    });
    zone.addEventListener('drop', function (e) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) lancerDemo(f.name);
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) lancerDemo(input.files[0].name);
    });
    // Rendre la zone accessible au clavier.
    zone.setAttribute('tabindex', '0');
    zone.setAttribute('role', 'button');
  }

  // ── Apparition douce au scroll (IntersectionObserver) ──
  const elements = document.querySelectorAll('.reveler');
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const observateur = new IntersectionObserver(function (entrees) {
      entrees.forEach(function (entree) {
        if (entree.isIntersecting) {
          entree.target.classList.add('visible');
          observateur.unobserve(entree.target);
        }
      });
    }, { threshold: 0.12 });
    elements.forEach(function (el) { observateur.observe(el); });
  } else {
    // Pas d'Observer ou reduced-motion : tout est visible immédiatement.
    elements.forEach(function (el) { el.classList.add('visible'); });
  }
})();
