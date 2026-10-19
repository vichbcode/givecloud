// ═══════════════════════════════════════════════════════════════
// GiveCloud — page login : inscription / connexion
// Le jeton de session vit UNIQUEMENT dans un cookie HttpOnly posé
// par le Worker. Ce script ne stocke aucun secret côté navigateur.
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const API = (window.GIVECLOUD_CONFIG && window.GIVECLOUD_CONFIG.API_BASE) || '';

  const form = document.getElementById('formulaire');
  const inputEmail = document.getElementById('email');
  const inputMdp = document.getElementById('motdepasse');
  const btnSoumettre = document.getElementById('btn-soumettre');
  const tabConnexion = document.getElementById('tab-connexion');
  const tabInscription = document.getElementById('tab-inscription');
  const msgErreur = document.getElementById('message-erreur');
  const msgInfo = document.getElementById('message-info');
  const titre = document.getElementById('titre-page');
  const sousTitre = document.getElementById('sous-titre');
  const aideMdp = document.getElementById('aide-mdp');

  let mode = 'connexion'; // ou 'inscription'

  /** Passe en mode connexion/inscription (onglets ARIA + libellés). */
  function setMode(nouveau) {
    mode = nouveau;
    const inscription = mode === 'inscription';
    tabConnexion.setAttribute('aria-selected', String(!inscription));
    tabInscription.setAttribute('aria-selected', String(inscription));
    btnSoumettre.textContent = inscription ? 'Créer mon espace' : 'Se connecter';
    titre.textContent = inscription ? 'Créer un compte.' : 'Bienvenue.';
    sousTitre.textContent = inscription
      ? '100 Mo offerts, sans carte bancaire.'
      : 'Connecte-toi ou crée ton espace en 10 secondes.';
    // autocomplete différent : new-password pour l'inscription (gestionnaire de mots de passe).
    inputMdp.setAttribute('autocomplete', inscription ? 'new-password' : 'current-password');
    aideMdp.hidden = !inscription;
    cacherMessages();
  }

  function montrerErreur(texte) {
    msgErreur.textContent = texte;
    msgErreur.classList.add('visible');
    msgInfo.classList.remove('visible');
  }
  function montrerInfo(texte) {
    msgInfo.textContent = texte;
    msgInfo.classList.add('visible');
    msgErreur.classList.remove('visible');
  }
  function cacherMessages() {
    msgErreur.classList.remove('visible');
    msgInfo.classList.remove('visible');
  }

  tabConnexion.addEventListener('click', function () { setMode('connexion'); });
  tabInscription.addEventListener('click', function () { setMode('inscription'); });

  // ?mode=inscription ouvre directement le bon onglet.
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'inscription') setMode('inscription');

  // Déjà connecté ? On redirige vers l'app.
  fetch(API + '/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) { if (r.ok) window.location.replace('app.html'); })
    .catch(function () { /* hors ligne ou API absente : on reste sur la page */ });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    cacherMessages();

    const email = inputEmail.value.trim().toLowerCase();
    const motDePasse = inputMdp.value;

    // Validation grossière côté UX (le serveur revalide tout).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      montrerErreur('Adresse e-mail invalide.');
      inputEmail.focus();
      return;
    }
    if (motDePasse.length < 8) {
      montrerErreur('Le mot de passe doit faire au moins 8 caractères.');
      inputMdp.focus();
      return;
    }

    btnSoumettre.disabled = true;
    btnSoumettre.textContent = mode === 'inscription' ? 'Création…' : 'Connexion…';

    try {
      const reponse = await fetch(API + '/api/auth/' + (mode === 'inscription' ? 'register' : 'login'), {
        method: 'POST',
        // same-origin : le cookie est envoyé automatiquement si on est sur le Worker.
        // Si front et API sont sur des domaines différents : 'include'.
        credentials: API ? 'include' : 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, motDePasse: motDePasse })
      });
      const data = await reponse.json().catch(function () { return {}; });

      if (!reponse.ok) {
        // Message générique renvoyé par le serveur (pas de fuite d'info).
        montrerErreur(data.error || 'Une erreur est survenue. Réessaie.');
        btnSoumettre.disabled = false;
        btnSoumettre.textContent = mode === 'inscription' ? 'Créer mon espace' : 'Se connecter';
        return;
      }

      // Le Worker a posé le cookie HttpOnly : on n'a rien à stocker ici.
      if (window.GC_toast) {
        window.GC_toast(mode === 'inscription' ? 'Compte créé, bienvenue !' : 'Connexion réussie.', 'succes');
      }
      window.location.href = 'app.html';
    } catch (err) {
      montrerErreur('Impossible de contacter le serveur. Réessaie plus tard.');
      btnSoumettre.disabled = false;
      btnSoumettre.textContent = mode === 'inscription' ? 'Créer mon espace' : 'Se connecter';
    }
  });
})();
