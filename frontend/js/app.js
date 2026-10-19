// ═══════════════════════════════════════════════════════════════
// GiveCloud — application (liste, upload, dossiers, partages…)
// Règle d'or : AUCUNE donnée utilisateur en innerHTML.
// Tout le DOM dynamique est construit avec createElement + textContent.
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const API = (window.GIVECLOUD_CONFIG && window.GIVECLOUD_CONFIG.API_BASE) || '';
  // Limite d'upload : 5 Mo (Airtable) ou 3 Mo si Vercel tronque le corps de
  // requête. La vraie valeur est récupérée sur /api/health au démarrage.
  let MAX_OCTETS = 5 * 1024 * 1024;

  /** Texte de la zone de dépôt, à jour avec la vraie limite. */
  function texteZoneDepot() {
    const mo = Math.round(MAX_OCTETS / (1024 * 1024));
    return 'Glisse tes fichiers ici (' + mo + ' Mo max par envoi) ou clique sur « Envoyer »';
  }

  // ── État de l'application ──
  const etat = {
    vue: 'fichiers',          // fichiers | partages | corbeille
    chemin: '/',               // dossier courant
    fichiers: [],             // liste affichée
    tri: 'nom',
    recherche: '',
    fichierCourant: null,     // fichier ciblé par une modale
    quota: null
  };

  // ── Raccourcis DOM ──
  const $ = function (id) { return document.getElementById(id); };
  const conteneurListe = $('conteneur-liste');
  const filAriane = $('fil-ariane');
  const zoneDepot = $('zone-depot-app');
  const inputUpload = $('input-upload');

  // ═════════ Utilitaires ═════════

  /** Format de taille lisible : 1 234 567 octets → "1,2 Mo". */
  function formaterTaille(o) {
    if (!o) return '0 o';
    const unites = ['o', 'Ko', 'Mo', 'Go'];
    let i = 0;
    let n = o;
    while (n >= 1024 && i < unites.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',')) + ' ' + unites[i];
  }

  /** Date ISO → date locale lisible. */
  function formaterDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
    } catch { return '—'; }
  }

  /** Appel API JSON avec gestion 401 (redirection login). */
  async function api(chemin, options) {
    const opts = options || {};
    opts.credentials = API ? 'include' : 'same-origin';
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
      opts.body = JSON.stringify(opts.body);
    }
    const reponse = await fetch(API + chemin, opts);
    if (reponse.status === 401) {
      window.location.href = 'login.html';
      throw new Error('SESSION_EXPIREE');
    }
    const data = await reponse.json().catch(function () { return {}; });
    if (!reponse.ok) {
      throw new Error(data.error || 'Erreur serveur (' + reponse.status + ').');
    }
    return data;
  }

  /** Ouvre une modale. */
  function ouvrirModale(id) {
    const m = $(id);
    m.classList.add('visible');
    const premier = m.querySelector('input, select, button');
    if (premier) premier.focus();
  }
  /** Ferme une modale (clic sur fond, bouton [data-fermer], Échap). */
  function fermerModale(id) { $(id).classList.remove('visible'); }

  document.querySelectorAll('.modale-fond').forEach(function (fond) {
    fond.addEventListener('click', function (e) { if (e.target === fond) fond.classList.remove('visible'); });
    fond.querySelectorAll('[data-fermer]').forEach(function (b) {
      b.addEventListener('click', function () { fond.classList.remove('visible'); });
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modale-fond.visible').forEach(function (m) { m.classList.remove('visible'); });
    }
  });

  // ═════════ Navigation entre vues ═════════

  function activerVue(vue) {
    etat.vue = vue;
    $('vue-fichiers').hidden = vue !== 'fichiers';
    $('vue-partages').hidden = vue !== 'partages';
    $('vue-corbeille').hidden = vue !== 'corbeille';
    $('outils-fichiers').style.display = vue === 'fichiers' ? '' : 'none';
    filAriane.style.display = vue === 'fichiers' ? '' : 'none';
    document.querySelectorAll('.sidebar-nav button').forEach(function (b) {
      b.classList.toggle('actif', b.dataset.vue === vue);
    });
    if (vue === 'fichiers') chargerFichiers();
    else if (vue === 'partages') chargerPartages();
    else if (vue === 'corbeille') chargerCorbeille();
  }

  document.querySelectorAll('.sidebar-nav button').forEach(function (b) {
    b.addEventListener('click', function () { activerVue(b.dataset.vue); });
  });

  // ═════════ Fil d'ariane ═════════

  function rendreFilAriane() {
    // On vide avec textContent puis reconstruit : jamais de innerHTML.
    while (filAriane.firstChild) filAriane.removeChild(filAriane.firstChild);
    const segments = etat.chemin.split('/').filter(Boolean);
    const btnRacine = document.createElement('button');
    btnRacine.type = 'button';
    btnRacine.textContent = '/ racine';
    btnRacine.addEventListener('click', function () { naviguerVers('/'); });
    filAriane.appendChild(btnRacine);
    let cheminPartiel = '';
    segments.forEach(function (seg, i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      filAriane.appendChild(sep);
      cheminPartiel += '/' + seg;
      if (i === segments.length - 1) {
        const courant = document.createElement('span');
        courant.className = 'courant';
        courant.textContent = seg;
        filAriane.appendChild(courant);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = seg;
        const cible = cheminPartiel; // capture de la valeur
        btn.addEventListener('click', function () { naviguerVers(cible); });
        filAriane.appendChild(btn);
      }
    });
  }

  function naviguerVers(chemin) {
    etat.chemin = chemin;
    etat.recherche = '';
    $('recherche').value = '';
    rendreFilAriane();
    chargerFichiers();
  }

  // ═════════ Chargement des données ═════════

  async function chargerQuota() {
    try {
      const q = await api('/api/quota');
      etat.quota = q;
      const remplissage = $('jauge-remplissage');
      const barre = remplissage.parentElement;
      remplissage.style.width = q.pourcentage + '%';
      remplissage.classList.toggle('attention', q.pourcentage >= 75 && q.pourcentage < 95);
      remplissage.classList.toggle('plein', q.pourcentage >= 95);
      barre.setAttribute('aria-valuenow', String(q.pourcentage));
      $('jauge-detail').textContent = formaterTaille(q.utiliseOctets) + ' / ' + formaterTaille(q.quotaOctets);
    } catch { /* la jauge reste telle quelle en cas d'erreur */ }
  }

  async function chargerFichiers() {
    try {
      const params = new URLSearchParams({ chemin: etat.chemin, tri: etat.tri });
      const data = await api('/api/files?' + params);
      etat.fichiers = data.fichiers;
      rendreListe();
      chargerQuota();
    } catch (err) {
      if (err.message !== 'SESSION_EXPIREE') afficherVide('⚠ ' + err.message);
    }
  }

  async function chargerCorbeille() {
    try {
      const data = await api('/api/trash');
      rendreListeCorbeille(data.fichiers);
    } catch (err) {
      if (err.message !== 'SESSION_EXPIREE') $('liste-corbeille').textContent = err.message;
    }
  }

  async function chargerPartages() {
    try {
      const data = await api('/api/shares');
      rendreListePartages(data.partages, $('liste-partages-app'));
    } catch (err) {
      if (err.message !== 'SESSION_EXPIREE') $('liste-partages-app').textContent = err.message;
    }
  }

  // ═════════ Rendu de la liste de fichiers ═════════

  function iconePour(fichier) {
    // Renvoie un caractère emoji simple (textContent = sûr).
    if (fichier.estDossier) return '📁';
    const t = fichier.type || '';
    if (t.startsWith('image/')) return '🖼';
    if (t === 'application/pdf') return '📕';
    if (t.startsWith('video/')) return '🎬';
    if (t.startsWith('audio/')) return '🎵';
    if (t.startsWith('text/')) return '📄';
    return '📎';
  }

  function afficherVide(message) {
    while (conteneurListe.firstChild) conteneurListe.removeChild(conteneurListe.firstChild);
    const div = document.createElement('div');
    div.className = 'vide';
    const grand = document.createElement('div');
    grand.className = 'grand';
    grand.textContent = '☁';
    const p = document.createElement('p');
    p.textContent = message;
    div.appendChild(grand);
    div.appendChild(p);
    conteneurListe.appendChild(div);
  }

  function rendreListe() {
    // Recherche filtrée côté client sur la liste déjà chargée.
    const q = etat.recherche.toLowerCase();
    const fichiers = etat.fichiers.filter(function (f) {
      return !q || f.nom.toLowerCase().includes(q);
    });
    // Dossiers toujours en premier.
    fichiers.sort(function (a, b) {
      if (a.estDossier !== b.estDossier) return a.estDossier ? -1 : 1;
      return 0;
    });

    while (conteneurListe.firstChild) conteneurListe.removeChild(conteneurListe.firstChild);
    if (fichiers.length === 0) {
      afficherVide(q ? 'Aucun résultat pour « ' + q + ' ».' : 'Ce dossier est vide. Dépose un fichier pour commencer.');
      return;
    }

    const table = document.createElement('table');
    table.className = 'tableau-fichiers';
    // <thead>
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    [['Nom', ''], ['Taille', 'col-taille'], ['Type', 'col-type'], ['Date', 'col-date'], ['', '']].forEach(function (c) {
      const th = document.createElement('th');
      th.textContent = c[0];
      if (c[1]) th.className = c[1];
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);
    // <tbody>
    const tbody = document.createElement('tbody');
    fichiers.forEach(function (f) { tbody.appendChild(ligneFichier(f)); });
    table.appendChild(tbody);
    conteneurListe.appendChild(table);
  }

  function ligneFichier(f) {
    const tr = document.createElement('tr');

    // Colonne nom
    const tdNom = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'cell-nom';
    const ico = document.createElement('span');
    ico.className = 'ico-type' + (f.estDossier ? ' dossier' : '');
    ico.textContent = iconePour(f);
    ico.setAttribute('aria-hidden', 'true');
    const boutonNom = document.createElement('button');
    boutonNom.type = 'button';
    boutonNom.className = 'nom-texte';
    boutonNom.textContent = f.nom;
    boutonNom.title = f.nom;
    boutonNom.addEventListener('click', function () {
      if (f.estDossier) naviguerVers((f.chemin === '/' ? '' : f.chemin) + '/' + f.nom);
      else ouvrirApercu(f);
    });
    wrap.appendChild(ico);
    wrap.appendChild(boutonNom);
    tdNom.appendChild(wrap);
    tr.appendChild(tdNom);

    // Colonne taille
    const tdTaille = document.createElement('td');
    tdTaille.textContent = f.estDossier ? '—' : formaterTaille(f.taille);
    tr.appendChild(tdTaille);

    // Colonne type
    const tdType = document.createElement('td');
    tdType.className = 'col-type';
    tdType.textContent = f.estDossier ? 'dossier' : (f.type.split('/').pop() || 'inconnu');
    tr.appendChild(tdType);

    // Colonne date
    const tdDate = document.createElement('td');
    tdDate.className = 'col-date';
    tdDate.textContent = formaterDate(f.creeLe);
    tr.appendChild(tdDate);

    // Colonne actions
    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'actions-ligne';

    if (!f.estDossier) {
      if (f.type.startsWith('image/') || f.type === 'application/pdf') {
        actions.appendChild(btnAction('👀', 'Aperçu', function () { ouvrirApercu(f); }));
      }
      actions.appendChild(btnAction('⬇', 'Télécharger', function () { telecharger(f); }));
      actions.appendChild(btnAction('🔗', 'Partager', function () { ouvrirPartage(f); }));
    }
    actions.appendChild(btnAction('✏', 'Renommer', function () { ouvrirRenommer(f); }));
    actions.appendChild(btnAction('📦', 'Déplacer', function () { ouvrirDeplacer(f); }));
    actions.appendChild(btnAction('🗑', 'Supprimer', function () { ouvrirSupprimer(f); }, true));

    tdActions.appendChild(actions);
    tr.appendChild(tdActions);
    return tr;
  }

  function btnAction(icone, titre, action, danger) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-icone' + (danger ? ' danger' : '');
    b.textContent = icone;
    b.title = titre;
    b.setAttribute('aria-label', titre);
    b.addEventListener('click', action);
    return b;
  }

  // ═════════ Upload (XHR pour la barre de progression) ═════════

  function uploaderFichiers(fichiers) {
    const liste = Array.from(fichiers);
    if (liste.length === 0) return;
    let succes = 0;
    let reste = liste.length;

    liste.forEach(function (f) {
      // Validation côté UX (le serveur revalide) :
      if (f.size > MAX_OCTETS) {
        const mo = Math.round(MAX_OCTETS / (1024 * 1024));
        window.GC_toast('« ' + f.name + ' » dépasse ' + mo + ' Mo — ignoré.', 'erreur');
        reste--;
        return;
      }
      const form = new FormData();
      form.append('fichier', f, f.name);
      form.append('chemin', etat.chemin);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/api/files/upload');
      xhr.withCredentials = Boolean(API);
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable && zoneDepot) {
          const pct = Math.round((e.loaded / e.total) * 100);
          zoneDepot.textContent = 'Envoi de ' + f.name + '… ' + pct + '%';
        }
      });
      xhr.addEventListener('load', function () {
        reste--;
        if (xhr.status >= 200 && xhr.status < 300) {
          succes++;
        } else {
          let msg = 'Échec de l\'envoi de ' + f.name;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* réponse non-JSON */ }
          window.GC_toast(msg, 'erreur');
        }
        if (reste === 0) termineUpload(succes, liste.length);
      });
      xhr.addEventListener('error', function () {
        reste--;
        window.GC_toast('Erreur réseau lors de l\'envoi de ' + f.name, 'erreur');
        if (reste === 0) termineUpload(succes, liste.length);
      });
      xhr.send(form);
    });
  }

  function termineUpload(succes, total) {
    if (zoneDepot) zoneDepot.textContent = texteZoneDepot();
    if (succes > 0) {
      window.GC_toast(succes + '/' + total + ' fichier(s) envoyé(s).', 'succes');
      chargerFichiers();
    }
  }

  $('btn-upload').addEventListener('click', function () { inputUpload.click(); });
  inputUpload.addEventListener('change', function () {
    uploaderFichiers(inputUpload.files);
    inputUpload.value = '';
  });

  // Glisser-déposer sur la zone de l'app (et tout le conteneur).
  ['dragenter', 'dragover'].forEach(function (ev) {
    zoneDepot.addEventListener(ev, function (e) {
      e.preventDefault();
      zoneDepot.classList.add('survol');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zoneDepot.addEventListener(ev, function (e) {
      e.preventDefault();
      zoneDepot.classList.remove('survol');
    });
  });
  zoneDepot.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) uploaderFichiers(e.dataTransfer.files);
  });
  zoneDepot.addEventListener('click', function () { inputUpload.click(); });

  // ═════════ Recherche & tri ═════════

  let minuteurRecherche;
  $('recherche').addEventListener('input', function (e) {
    clearTimeout(minuteurRecherche);
    minuteurRecherche = setTimeout(function () {
      etat.recherche = e.target.value.trim();
      rendreListe();
    }, 180);
  });
  $('tri').addEventListener('change', function (e) {
    etat.tri = e.target.value;
    // Tri côté serveur (nom/taille) ; la date est triée par le Worker aussi.
    chargerFichiers();
  });

  // ═════════ Dossier : création ═════════

  $('btn-dossier').addEventListener('click', function () {
    $('input-dossier').value = '';
    ouvrirModale('modale-dossier');
  });
  $('confirmer-dossier').addEventListener('click', async function () {
    const nom = $('input-dossier').value.trim();
    if (!nom) return;
    try {
      await api('/api/folders', { method: 'POST', body: { nom: nom, chemin: etat.chemin } });
      fermerModale('modale-dossier');
      window.GC_toast('Dossier créé.', 'succes');
      chargerFichiers();
    } catch (err) {
      window.GC_toast(err.message, 'erreur');
    }
  });

  // ═════════ Renommer ═════════

  function ouvrirRenommer(f) {
    etat.fichierCourant = f;
    $('input-renommer').value = f.nom;
    ouvrirModale('modale-renommer');
  }
  $('confirmer-renommer').addEventListener('click', async function () {
    const nom = $('input-renommer').value.trim();
    if (!nom || !etat.fichierCourant) return;
    try {
      await api('/api/files/' + etat.fichierCourant.id, { method: 'PATCH', body: { nom: nom } });
      fermerModale('modale-renommer');
      window.GC_toast('Renommé.', 'succes');
      chargerFichiers();
    } catch (err) {
      window.GC_toast(err.message, 'erreur');
    }
  });

  // ═════════ Déplacer ═════════

  function ouvrirDeplacer(f) {
    etat.fichierCourant = f;
    $('input-deplacer').value = f.chemin || '/';
    ouvrirModale('modale-deplacer');
  }
  $('confirmer-deplacer').addEventListener('click', async function () {
    const chemin = $('input-deplacer').value.trim() || '/';
    if (!etat.fichierCourant) return;
    try {
      await api('/api/files/' + etat.fichierCourant.id, { method: 'PATCH', body: { chemin: chemin } });
      fermerModale('modale-deplacer');
      window.GC_toast('Déplacé vers ' + chemin, 'succes');
      chargerFichiers();
    } catch (err) {
      window.GC_toast(err.message, 'erreur');
    }
  });

  // ═════════ Supprimer (corbeille) ═════════

  function ouvrirSupprimer(f) {
    etat.fichierCourant = f;
    $('supprimer-nom').textContent = f.nom;
    ouvrirModale('modale-supprimer');
  }
  $('confirmer-supprimer').addEventListener('click', async function () {
    if (!etat.fichierCourant) return;
    try {
      await api('/api/files/' + etat.fichierCourant.id, { method: 'DELETE' });
      fermerModale('modale-supprimer');
      window.GC_toast('Envoyé à la corbeille.', 'succes');
      chargerFichiers();
    } catch (err) {
      window.GC_toast(err.message, 'erreur');
    }
  });

  // ═════════ Téléchargement (cookie envoyé automatiquement) ═════════

  function telecharger(f) {
    // Le Worker streamme le fichier avec Content-Disposition: attachment.
    const lien = document.createElement('a');
    lien.href = API + '/api/files/' + f.id + '/download';
    lien.rel = 'noopener';
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
  }

  // ═════════ Aperçu (images / PDF) ═════════

  function ouvrirApercu(f) {
    etat.fichierCourant = f;
    $('titre-apercu').textContent = f.nom;
    const zone = $('contenu-apercu');
    while (zone.firstChild) zone.removeChild(zone.firstChild);

    const estImage = f.type.startsWith('image/');
    const estPdf = f.type === 'application/pdf';
    if (!estImage && !estPdf) {
      zone.textContent = 'Aperçu non disponible pour ce type.';
    } else {
      // On récupère le binaire via l'API (cookie de session inclus) :
      // l'URL Airtable expire, le Worker régénère un lien frais à chaque fois.
      zone.textContent = 'Chargement…';
      fetch(API + '/api/files/' + f.id + '/preview', { credentials: API ? 'include' : 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('Aperçu indisponible.');
          return r.blob();
        })
        .then(function (blob) {
          const url = URL.createObjectURL(blob);
          while (zone.firstChild) zone.removeChild(zone.firstChild);
          if (estImage) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = 'Aperçu de ' + f.nom;
            zone.appendChild(img);
          } else {
            const iframe = document.createElement('iframe');
            iframe.src = url;
            iframe.title = 'Aperçu PDF de ' + f.nom;
            zone.appendChild(iframe);
          }
          const lienDl = $('apercu-telecharger');
          lienDl.href = API + '/api/files/' + f.id + '/download';
        })
        .catch(function (err) {
          zone.textContent = err.message;
        });
    }
    $('apercu-telecharger').setAttribute('href', API + '/api/files/' + f.id + '/download');
    ouvrirModale('modale-apercu');
  }

  // ═════════ Partage ═════════

  function ouvrirPartage(f) {
    etat.fichierCourant = f;
    $('partager-nom').textContent = f.nom;
    $('lien-cree').hidden = true;
    ouvrirModale('modale-partager');
    chargerPartagesModale();
  }

  async function chargerPartagesModale() {
    if (!etat.fichierCourant) return;
    const zone = $('liste-partages-modale');
    while (zone.firstChild) zone.removeChild(zone.firstChild);
    try {
      const data = await api('/api/shares');
      const miens = data.partages.filter(function (p) { return p.fileId === etat.fichierCourant.id; });
      if (miens.length === 0) {
        const p = document.createElement('p');
        p.style.color = 'var(--muted)';
        p.textContent = 'Aucun lien actif.';
        zone.appendChild(p);
        return;
      }
      miens.forEach(function (p) {
        const item = document.createElement('div');
        item.className = 'item-partage';
        const texte = document.createElement('span');
        texte.className = p.expire ? 'mort' : '';
        texte.textContent = p.expire ? 'Expiré / révoqué — ' + formaterDate(p.expireLe) : 'Expire le ' + formaterDate(p.expireLe);
        item.appendChild(texte);
        if (!p.expire) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-icone danger';
          btn.textContent = 'Révoquer';
          btn.addEventListener('click', async function () {
            try {
              await api('/api/shares/' + p.id, { method: 'DELETE' });
              window.GC_toast('Lien révoqué.', 'succes');
              chargerPartagesModale();
            } catch (err) {
              window.GC_toast(err.message, 'erreur');
            }
          });
          item.appendChild(btn);
        }
        zone.appendChild(item);
      });
    } catch (err) {
      zone.textContent = err.message;
    }
  }

  $('creer-partage').addEventListener('click', async function () {
    if (!etat.fichierCourant) return;
    try {
      const data = await api('/api/shares', {
        method: 'POST',
        body: { fileId: etat.fichierCourant.id, heures: Number($('input-expiration').value) }
      });
      $('texte-lien').textContent = data.partage.url;
      $('lien-cree').hidden = false;
      window.GC_toast('Lien créé.', 'succes');
      chargerPartagesModale();
    } catch (err) {
      window.GC_toast(err.message, 'erreur');
    }
  });

  $('copier-lien').addEventListener('click', async function () {
    const texte = $('texte-lien').textContent;
    try {
      await navigator.clipboard.writeText(texte);
      window.GC_toast('Lien copié.', 'succes');
    } catch {
      window.GC_toast('Copie impossible — sélectionne le lien manuellement.', 'erreur');
    }
  });

  // ═════════ Vues partages / corbeille ═════════

  function rendreListePartages(partages, zone) {
    while (zone.firstChild) zone.removeChild(zone.firstChild);
    if (partages.length === 0) {
      const p = document.createElement('p');
      p.className = 'vide';
      p.textContent = 'Aucun lien de partage. Utilise 🔗 sur un fichier.';
      zone.appendChild(p);
      return;
    }
    const table = document.createElement('table');
    table.className = 'tableau-fichiers';
    const tbody = document.createElement('tbody');
    partages.forEach(function (p) {
      const tr = document.createElement('tr');
      const tdNom = document.createElement('td');
      tdNom.textContent = p.nom;
      const tdExpire = document.createElement('td');
      tdExpire.textContent = p.expire ? 'inactif' : formaterDate(p.expireLe);
      const tdAction = document.createElement('td');
      tdAction.style.textAlign = 'right';
      if (!p.expire) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-icone danger';
        btn.textContent = 'Révoquer';
        btn.addEventListener('click', async function () {
          try {
            await api('/api/shares/' + p.id, { method: 'DELETE' });
            window.GC_toast('Révoqué.', 'succes');
            chargerPartages();
          } catch (err) {
            window.GC_toast(err.message, 'erreur');
          }
        });
        tdAction.appendChild(btn);
      }
      tr.appendChild(tdNom);
      tr.appendChild(tdExpire);
      tr.appendChild(tdAction);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    zone.appendChild(table);
  }

  function rendreListeCorbeille(fichiers) {
    const zone = $('liste-corbeille');
    while (zone.firstChild) zone.removeChild(zone.firstChild);
    if (fichiers.length === 0) {
      const p = document.createElement('div');
      p.className = 'vide';
      const grand = document.createElement('div');
      grand.className = 'grand';
      grand.textContent = '🗑';
      const texte = document.createElement('p');
      texte.textContent = 'La corbeille est vide.';
      p.appendChild(grand);
      p.appendChild(texte);
      zone.appendChild(p);
      return;
    }
    const table = document.createElement('table');
    table.className = 'tableau-fichiers';
    const tbody = document.createElement('tbody');
    fichiers.forEach(function (f) {
      const tr = document.createElement('tr');
      const tdNom = document.createElement('td');
      tdNom.textContent = iconePour(f) + ' ' + f.nom;
      const tdDate = document.createElement('td');
      tdDate.textContent = 'supprimé le ' + formaterDate(f.supprimeLe);
      const tdAction = document.createElement('td');
      tdAction.style.textAlign = 'right';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-bleu btn-petit';
      btn.textContent = 'Restaurer';
      btn.addEventListener('click', async function () {
        try {
          await api('/api/files/' + f.id + '/restore', { method: 'POST' });
          window.GC_toast('Restauré.', 'succes');
          chargerCorbeille();
          chargerQuota();
        } catch (err) {
          window.GC_toast(err.message, 'erreur');
        }
      });
      tdAction.appendChild(btn);
      tr.appendChild(tdNom);
      tr.appendChild(tdDate);
      tr.appendChild(tdAction);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    zone.appendChild(table);
  }

  // ═════════ Déconnexion ═════════

  async function deconnecter() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* même en cas d'erreur, on renvoie vers la page de login */ }
    window.location.href = 'login.html';
  }
  $('btn-deconnexion').addEventListener('click', deconnecter);
  const btnDeconnexionMobile = $('btn-deconnexion-mobile');
  if (btnDeconnexionMobile) btnDeconnexionMobile.addEventListener('click', deconnecter);

  // ═════════ Démarrage ═════════

  (async function demarrer() {
    // Récupère la vraie limite d'upload exposée par le serveur.
    try {
      const sante = await fetch(API + '/api/health', { credentials: API ? 'include' : 'same-origin' })
        .then(function (r) { return r.json(); });
      if (sante && sante.maxFichierOctets) MAX_OCTETS = sante.maxFichierOctets;
    } catch { /* la valeur par défaut reste 5 Mo */ }
    if (zoneDepot) zoneDepot.textContent = texteZoneDepot();
    try {
      const me = await api('/api/auth/me');
      $('email-user').textContent = me.email;
    } catch { /* redirection login déjà lancée par api() */ }
    rendreFilAriane();
    activerVue('fichiers');
  })();
})();
