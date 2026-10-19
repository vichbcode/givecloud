// ═══════════════════════════════════════════════════════════════
// GiveCloud — thème + personnalisation du design (toutes les pages)
// Seule chose stockée en localStorage : les préférences d'apparence
// (jamais de jeton, jamais de donnée utilisateur sensible).
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const CLE_ANCIEN = 'gc-theme';       // ancienne clé (clair/sombre uniquement)
  const CLE_APPARENCE = 'gc-apparence'; // nouvelle clé (objet complet)

  const DEFAUT = Object.freeze({
    mode: 'systeme',   // systeme | clair | sombre
    accent: '#0000f2', // couleur d'accent du site
    radius: 14,        // arrondi des coins (px)
    fond: 'uni'        // uni | doux | degrade
  });

  // ── Préférence système ──
  function themeSysteme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair';
  }

  // ── Lecture / écriture de la préférence ──
  function lire() {
    let obj = {};
    try { obj = JSON.parse(localStorage.getItem(CLE_APPARENCE) || '{}') || {}; } catch { obj = {}; }
    // Migration de l'ancienne clé gc-theme.
    const ancien = localStorage.getItem(CLE_ANCIEN);
    if (!obj.mode && (ancien === 'clair' || ancien === 'sombre')) obj.mode = ancien;
    return Object.assign({}, DEFAUT, obj);
  }
  function ecrire(obj) {
    try { localStorage.setItem(CLE_APPARENCE, JSON.stringify(obj)); } catch { /* mode privé : on ignore */ }
  }

  // ── Outils couleur ──
  function hexVersRgb(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    const v = parseInt(/^[0-9a-f]{6}$/i.test(h) ? h : '0000f2', 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }
  function rgbVersHex(r, g, b) {
    const c = function (x) { return Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'); };
    return '#' + c(r) + c(g) + c(b);
  }
  function melange(hex, cible, t) {
    const a = hexVersRgb(hex);
    return rgbVersHex(a.r + (cible[0] - a.r) * t, a.g + (cible[1] - a.g) * t, a.b + (cible[2] - a.b) * t);
  }
  const eclaircir = function (hex, t) { return melange(hex, [255, 255, 255], t); };
  const assombrir = function (hex, t) { return melange(hex, [0, 0, 0], t); };
  const rgba = function (hex, a) {
    const c = hexVersRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  };

  // ── Application ──
  function appliquer(obj) {
    const o = Object.assign({}, DEFAUT, obj || {});
    const theme = o.mode === 'systeme' ? themeSysteme() : o.mode;
    document.documentElement.setAttribute('data-theme', theme);
    const sombre = theme === 'sombre';
    const s = document.documentElement.style;

    // La couleur d'accent pilote tout le design (sidebar, boutons, liens…).
    s.setProperty('--bleu', o.accent);
    s.setProperty('--bleu-clair', eclaircir(o.accent, 0.16));
    s.setProperty('--bleu-nuit', assombrir(o.accent, 0.35));
    s.setProperty('--bleu-pale', sombre ? melange(o.accent, [6, 6, 14], 0.88) : eclaircir(o.accent, 0.9));
    s.setProperty('--radius', o.radius + 'px');
    s.setProperty('--radius-petit', Math.max(4, Math.round(o.radius * 0.57)) + 'px');
    s.setProperty('--ombre-forte', '0 18px 60px ' + rgba(o.accent, sombre ? 0.35 : 0.18));

    let fond = 'none';
    if (o.fond === 'degrade') {
      fond = 'linear-gradient(135deg, ' + rgba(o.accent, sombre ? 0.22 : 0.10) + ', transparent 45%)';
    } else if (o.fond === 'doux') {
      fond = 'radial-gradient(ellipse 90% 60% at 50% -10%, ' + rgba(o.accent, sombre ? 0.30 : 0.15) + ', transparent 62%)';
    }
    s.setProperty('--fond-image', fond);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', sombre ? '#06060e' : o.accent);
    return o;
  }

  let courant = lire();
  appliquer(courant);

  // ── API publique ──
  window.GC_apparence = {
    defaut: DEFAUT,
    presets: ['#0000f2', '#6d28d9', '#0a8f4a', '#d9003a', '#e07000', '#0891b2', '#111827', '#db2777'],
    lire: function () { return Object.assign({}, courant); },
    appliquer: function (modif) {
      courant = appliquer(Object.assign({}, courant, modif || {}));
      ecrire(courant);
      return courant;
    },
    reinitialiser: function () {
      courant = appliquer(Object.assign({}, DEFAUT));
      ecrire(courant);
      return courant;
    },
    eclaircir: eclaircir,
    assombrir: assombrir,
    rgba: rgba
  };

  // Suivre le thème système quand on est en mode « systeme ».
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (courant.mode === 'systeme') appliquer(courant);
  });

  // Bouton bascule clair/sombre des pages publiques (index.html).
  document.addEventListener('DOMContentLoaded', function () {
    const bouton = document.getElementById('btn-theme');
    if (!bouton) return;
    bouton.addEventListener('click', function () {
      const nouveau = document.documentElement.getAttribute('data-theme') === 'sombre' ? 'clair' : 'sombre';
      window.GC_apparence.appliquer({ mode: nouveau });
      bouton.textContent = nouveau === 'sombre' ? ':clair:' : ':sombre:';
    });
    bouton.textContent = document.documentElement.getAttribute('data-theme') === 'sombre' ? ':clair:' : ':sombre:';
  });

  // Toast partagé (textContent uniquement : anti-XSS).
  window.GC_toast = function (message, genre) {
    const zone = document.getElementById('toasts');
    if (!zone) return;
    const t = document.createElement('div');
    t.className = 'toast' + (genre ? ' ' + genre : '');
    t.textContent = message;
    zone.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  };
})();
