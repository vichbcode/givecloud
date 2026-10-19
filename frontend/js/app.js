// ═══════════════════════════════════════════════════════════════
// GiveCloud — application (liste, upload, dossiers, partages,
// paramètres, visionneuse universelle + éditeur de code Monaco).
// Règle d'or : AUCUNE donnée utilisateur en innerHTML.
// Tout le DOM dynamique est construit avec createElement + textContent.
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const API = (window.GIVECLOUD_CONFIG && window.GIVECLOUD_CONFIG.API_BASE) || '';
  // Limite d'upload : récupérée sur /api/health au démarrage (1 Go via R2).
  let MAX_OCTETS = 1024 * 1024 * 1024;

  // ── État de l'application ──
  const etat = {
    vue: 'fichiers',          // fichiers | partages | corbeille | parametres
    chemin: '/',
    fichiers: [],
    tri: 'nom',
    recherche: '',
    fichierCourant: null,
    quota: null,
    moi: null,
    editeur: null,            // instance Monaco courante
    lecteur: null,            // lecteur média (vidéo/audio) courant
    texteOriginal: null
  };

  // ── Raccourcis DOM ──
  const $ = function (id) { return document.getElementById(id); };
  const conteneurListe = $('conteneur-liste');
  const filAriane = $('fil-ariane');
  const zoneDepot = $('zone-depot-app');
  const inputUpload = $('input-upload');

  /** Vide un élément (jamais innerHTML). */
  function vider(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // ═════════ Utilitaires ═════════

  function formaterTaille(o) {
    if (!o) return '0 o';
    const unites = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let i = 0;
    let n = o;
    while (n >= 1024 && i < unites.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',')) + ' ' + unites[i];
  }

  function formaterDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
    } catch { return '—'; }
  }

  function texteZoneDepot() {
    return 'Glisse tes fichiers ici (' + formaterTaille(MAX_OCTETS) + ' max par fichier) ou clique sur « Envoyer »';
  }

  function octetsDe(texte) {
    try { return new TextEncoder().encode(texte).length; } catch { return texte.length; }
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

  function credentials() { return API ? 'include' : 'same-origin'; }

  // ── Modales ──
  function ouvrirModale(id) {
    const m = $(id);
    m.classList.add('visible');
    const premier = m.querySelector('input, select, button');
    if (premier) premier.focus();
  }
  function fermerModale(id) { $(id).classList.remove('visible'); }

  document.querySelectorAll('.modale-fond').forEach(function (fond) {
    fond.addEventListener('click', function (e) {
      if (e.target === fond) {
        if (fond.id === 'modale-apercu') { detruireEditeur(); detruireLecteur(); }
        fond.classList.remove('visible');
      }
    });
    fond.querySelectorAll('[data-fermer]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (fond.id === 'modale-apercu') { detruireEditeur(); detruireLecteur(); }
        fond.classList.remove('visible');
      });
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modale-fond.visible').forEach(function (m) {
        if (m.id === 'modale-apercu') { detruireEditeur(); detruireLecteur(); }
        m.classList.remove('visible');
      });
    }
  });

  // ── Confirmation générique ──
  let actionConfirmer = null;
  function demanderConfirmation(titre, message, libelle, action) {
    $('titre-confirmer').textContent = titre;
    $('texte-confirmer').textContent = message;
    $('confirmer-ok').textContent = libelle || 'Confirmer';
    actionConfirmer = action;
    ouvrirModale('modale-confirmer');
  }
  $('confirmer-ok').addEventListener('click', async function () {
    const a = actionConfirmer;
    actionConfirmer = null;
    fermerModale('modale-confirmer');
    if (a) await a();
  });
  $('confirmer-annuler').addEventListener('click', function () {
    actionConfirmer = null;
    fermerModale('modale-confirmer');
  });

  // ═════════ Navigation entre vues ═════════

  function activerVue(vue) {
    etat.vue = vue;
    $('vue-fichiers').hidden = vue !== 'fichiers';
    $('vue-partages').hidden = vue !== 'partages';
    $('vue-corbeille').hidden = vue !== 'corbeille';
    $('vue-parametres').hidden = vue !== 'parametres';
    $('outils-fichiers').style.display = vue === 'fichiers' ? '' : 'none';
    filAriane.style.display = vue === 'fichiers' ? '' : 'none';
    document.querySelectorAll('.sidebar-nav button').forEach(function (b) {
      b.classList.toggle('actif', b.dataset.vue === vue);
    });
    if (vue === 'fichiers') chargerFichiers();
    else if (vue === 'partages') chargerPartages();
    else if (vue === 'corbeille') chargerCorbeille();
    else if (vue === 'parametres') chargerParametres();
  }

  document.querySelectorAll('.sidebar-nav button').forEach(function (b) {
    b.addEventListener('click', function () { activerVue(b.dataset.vue); });
  });

  // ═════════ Fil d'ariane ═════════

  function rendreFilAriane() {
    vider(filAriane);
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
        const cible = cheminPartiel;
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
    } catch { /* jauge inchangée */ }
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

  // ═════════ Classement des fichiers (icône + visionneuse) ═════════

  const EXT_CODE = new Set([
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'json', 'jsonc', 'json5',
    'html', 'htm', 'xml', 'css', 'scss', 'sass', 'less', 'styl', 'md', 'markdown', 'mdx',
    'txt', 'log', 'csv', 'tsv', 'yml', 'yaml', 'ini', 'env', 'conf', 'cfg', 'toml',
    'sql', 'graphql', 'gql', 'graphqls', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'py', 'pyw', 'rb',
    'php', 'pl', 'lua', 'r', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
    'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'm', 'mm', 'dart', 'diff', 'patch',
    'dockerfile', 'makefile', 'cmake', 'meson', 'gradle', 'properties', 'tex', 'bib', 'sty',
    'srt', 'vtt', 'rst', 'adoc', 'asciidoc', 'org', 'wiki', 'rmd',
    'fs', 'fsx', 'fsi', 'ml', 'mli', 'hs', 'lhs', 'erl', 'hrl', 'ex', 'exs',
    'clj', 'cljs', 'cljc', 'edn', 'coffee', 'litcoffee', 'pas', 'pp', 'f', 'f90', 'f95', 'for',
    'asm', 's', 'sol', 'proto', 'thrift', 'hbs', 'handlebars', 'twig', 'liquid', 'mustache',
    'ejs', 'pug', 'jade', 'tcl', 'jl', 'nim', 'cr', 'v', 'sv', 'svh', 'vhd', 'vhdl',
    'abap', 'apex', 'cls', 'd', 'elm', 'flow', 'jsp', 'asp', 'aspx', 'cshtml', 'vbhtml',
    'sas', 'st', 'sml', 'rkt', 'scm', 'lisp', 'el', 'groovy', 'ipynb', 'raml', 'xaml',
    'cake', 'csx', 'fx', 'wxi', 'wxs', 'wxl', 'scheme', 'yaml', 'preset', 'rest'
  ]);

  function extension(nom) {
    const n = String(nom || '').toLowerCase();
    if (n === 'dockerfile' || n === 'makefile') return n;
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(i + 1) : '';
  }

  const EXT_VIDEO = new Set([
    'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'f4v', 'mpg', 'mpeg',
    'mpe', 'm2v', 'ts', 'mts', 'm2ts', '3gp', '3g2', 'ogv', 'vob', 'rm', 'rmvb',
    'asf', 'divx', 'mxf', 'ogm'
  ]);
  const EXT_AUDIO = new Set([
    'mp3', 'wav', 'wave', 'flac', 'aac', 'm4a', 'm4b', 'oga', 'ogg', 'opus', 'wma',
    'aiff', 'aif', 'aifc', 'alac', 'ape', 'wv', 'mpc', 'mka', 'ac3', 'eac3', 'dts',
    'amr', 'au', 'mid', 'midi', 'ra', 'caf', '3ga'
  ]);

  function estTexteOuCode(f) {
    const t = f.type || '';
    if (t.startsWith('text/')) return true;
    if (/^application\/(json|xml|javascript|x-yaml|x-sh|x-httpd-php|x-python)/.test(t)) return true;
    return EXT_CODE.has(extension(f.nom));
  }

  function classerFichier(f) {
    const t = f.type || '';
    const ext = extension(f.nom);
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('audio/')) return 'audio';
    if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
    // Repli par extension quand le MIME est absent (application/octet-stream).
    if (EXT_VIDEO.has(ext)) return 'video';
    if (EXT_AUDIO.has(ext)) return 'audio';
    if (estTexteOuCode(f)) return 'code';
    return 'autre';
  }

  function iconePour(f) {
    if (f.estDossier) return '📁';
    const c = classerFichier(f);
    if (c === 'image') return '🖼';
    if (c === 'video') return '🎬';
    if (c === 'audio') return '🎵';
    if (c === 'pdf') return '📕';
    if (c === 'code') return '⌨';
    return '📎';
  }

  // ── Monaco (chargé à la demande, depuis un CDN) ──
  const CDN_MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';
  let promesseMonaco = null;

  function chargerMonaco() {
    if (window.monaco) return Promise.resolve(window.monaco);
    if (promesseMonaco) return promesseMonaco;
    promesseMonaco = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = CDN_MONACO + '/loader.js';
      s.onload = function () {
        try {
          window.require.config({ paths: { vs: CDN_MONACO } });
          window.require(['vs/editor/editor.main'], function () { resolve(window.monaco); });
        } catch (e) { reject(e); }
      };
      s.onerror = function () { reject(new Error("Impossible de charger l'éditeur.")); };
      document.head.appendChild(s);
    });
    return promesseMonaco;
  }

  // Langages : la table est construite depuis Monaco lui-même (extensions ET noms
  // de fichiers) pour couvrir TOUS les langages qu'il embarque, sans liste figée.
  let tableLangues = null;

  function construireTableLangues() {
    const parExt = new Map();
    const parNom = new Map();
    if (window.monaco && window.monaco.languages) {
      window.monaco.languages.getLanguages().forEach(function (l) {
        (l.extensions || []).forEach(function (e) {
          parExt.set(String(e).replace(/^\./, '').toLowerCase(), l.id);
        });
        (l.filenames || []).forEach(function (n) { parNom.set(String(n).toLowerCase(), l.id); });
        (l.aliases || []).forEach(function (a) { parNom.set(String(a).toLowerCase(), l.id); });
      });
    }
    return { parExt: parExt, parNom: parNom };
  }

  // Repli minimal tant que Monaco n'est pas chargé (icônes, aperçu de dossier…).
  const LANG_REPLI = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', html: 'html', htm: 'html', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss',
    less: 'less', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', ini: 'ini',
    toml: 'ini', sql: 'sql', graphql: 'graphql', sh: 'shell', bash: 'shell', zsh: 'shell',
    bat: 'bat', ps1: 'powershell', py: 'python', rb: 'ruby', php: 'php', lua: 'lua', r: 'r',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp', cs: 'csharp', dart: 'dart', dockerfile: 'dockerfile',
    makefile: 'makefile', txt: 'plaintext', log: 'plaintext', csv: 'plaintext'
  };

  function langueDe(nom) {
    const base = String(nom || '').toLowerCase();
    if (window.monaco && window.monaco.languages) {
      if (!tableLangues) tableLangues = construireTableLangues();
      const parNom = tableLangues.parNom.get(base);
      if (parNom) return parNom;
      const parExt = tableLangues.parExt.get(extension(base));
      if (parExt) return parExt;
    }
    return LANG_REPLI[extension(base)] || 'plaintext';
  }

  function detruireEditeur() {
    if (etat.editeur) {
      try { etat.editeur.dispose(); } catch { /* déjà détruit */ }
      etat.editeur = null;
    }
    etat.texteOriginal = null;
  }

  function detruireLecteur() {
    if (etat.lecteur && typeof etat.lecteur.gcDetruire === 'function') {
      try { etat.lecteur.gcDetruire(); } catch { /* déjà détruit */ }
    }
    etat.lecteur = null;
  }

  // ═════════ Rendu de la liste ═════════

  function afficherVide(message) {
    vider(conteneurListe);
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
    const q = etat.recherche.toLowerCase();
    const fichiers = etat.fichiers.filter(function (f) {
      return !q || f.nom.toLowerCase().includes(q);
    });
    fichiers.sort(function (a, b) {
      if (a.estDossier !== b.estDossier) return a.estDossier ? -1 : 1;
      return 0;
    });

    vider(conteneurListe);
    if (fichiers.length === 0) {
      afficherVide(q ? 'Aucun résultat pour « ' + q + ' ».' : 'Ce dossier est vide. Dépose un fichier pour commencer.');
      return;
    }

    const table = document.createElement('table');
    table.className = 'tableau-fichiers';
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
    const tbody = document.createElement('tbody');
    fichiers.forEach(function (f) { tbody.appendChild(ligneFichier(f)); });
    table.appendChild(tbody);
    conteneurListe.appendChild(table);
  }

  function ligneFichier(f) {
    const tr = document.createElement('tr');

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
      else ouvrirFichier(f);
    });
    wrap.appendChild(ico);
    wrap.appendChild(boutonNom);
    tdNom.appendChild(wrap);
    tr.appendChild(tdNom);

    const tdTaille = document.createElement('td');
    tdTaille.textContent = f.estDossier ? '—' : formaterTaille(f.taille);
    tr.appendChild(tdTaille);

    const tdType = document.createElement('td');
    tdType.className = 'col-type';
    tdType.textContent = f.estDossier ? 'dossier' : (f.type.split('/').pop() || 'inconnu');
    tr.appendChild(tdType);

    const tdDate = document.createElement('td');
    tdDate.className = 'col-date';
    tdDate.textContent = formaterDate(f.creeLe);
    tr.appendChild(tdDate);

    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'actions-ligne';

    if (!f.estDossier) {
      actions.appendChild(btnAction('👀', 'Ouvrir', function () { ouvrirFichier(f); }));
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

  // ═════════ Upload ═════════

  function uploaderFichiers(fichiers) {
    const liste = Array.from(fichiers);
    if (liste.length === 0) return;
    let succes = 0;
    let reste = liste.length;

    function finir() {
      reste--;
      if (reste === 0) termineUpload(succes, liste.length);
    }

    liste.forEach(function (f) {
      if (f.size > MAX_OCTETS) {
        window.GC_toast('« ' + f.name + ' » dépasse ' + formaterTaille(MAX_OCTETS) + ' — ignoré.', 'erreur');
        finir();
        return;
      }
      envoyerUnFichier(f)
        .then(function () { succes++; })
        .catch(function (err) {
          window.GC_toast((err && err.message) || ('Échec de l\'envoi de ' + f.name), 'erreur');
        })
        .then(finir);
    });
  }

  /**
   * Envoi en 3 temps : 1) le serveur autorise (URL R2 pré-signée),
   * 2) le navigateur envoie les octets DIRECTEMENT à R2 (avec progression),
   * 3) le serveur clôture et crée l'entrée. Aucun octet ne passe par Vercel.
   */
  async function envoyerUnFichier(f) {
    const autorisation = await api('/api/files/upload', {
      method: 'POST',
      body: { nom: f.name, chemin: etat.chemin, taille: f.size, type: f.type }
    });
    await envoyerVersR2(autorisation.uploadUrl, f);
    await api('/api/files/finalize', {
      method: 'POST',
      body: { cle: autorisation.cle, nom: f.name, chemin: etat.chemin, type: f.type }
    });
  }

  function envoyerVersR2(url, f) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      if (f.type) xhr.setRequestHeader('Content-Type', f.type);
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable && zoneDepot) {
          zoneDepot.textContent = 'Envoi de ' + f.name + '… ' + Math.round((e.loaded / e.total) * 100) + '%';
        }
      });
      xhr.addEventListener('load', function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('Échec de l\'envoi vers le stockage (' + xhr.status + ').'));
      });
      xhr.addEventListener('error', function () {
        reject(new Error('Erreur réseau lors de l\'envoi de ' + f.name));
      });
      xhr.send(f);
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

  ['dragenter', 'dragover'].forEach(function (ev) {
    zoneDepot.addEventListener(ev, function (e) { e.preventDefault(); zoneDepot.classList.add('survol'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zoneDepot.addEventListener(ev, function (e) { e.preventDefault(); zoneDepot.classList.remove('survol'); });
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
    demanderConfirmation(
      'Mettre à la corbeille ?',
      '« ' + f.nom + ' » sera purgé définitivement après 30 jours. Tu peux le restaurer d\'ici là.',
      'Mettre à la corbeille',
      async function () {
        try {
          await api('/api/files/' + f.id, { method: 'DELETE' });
          window.GC_toast('Envoyé à la corbeille.', 'succes');
          chargerFichiers();
        } catch (err) {
          window.GC_toast(err.message, 'erreur');
        }
      }
    );
  }

  // ═════════ Téléchargement ═════════

  function telecharger(f) {
    const lien = document.createElement('a');
    lien.href = API + '/api/files/' + f.id + '/download';
    lien.rel = 'noopener';
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
  }

  // ═════════ Visionneuse universelle + éditeur de code ═════════

  function ouvrirFichier(f) {
    etat.fichierCourant = f;
    $('titre-apercu').textContent = f.nom;
    const zone = $('contenu-apercu');
    vider(zone);
    detruireEditeur();
    detruireLecteur();
    $('apercu-enregistrer').hidden = true;
    $('apercu-enregistrer').disabled = true;
    $('pied-apercu').hidden = true;
    $('pied-apercu').textContent = '';
    $('apercu-telecharger').href = API + '/api/files/' + f.id + '/download';

    const url = API + '/api/files/' + f.id + '/content';
    const kind = classerFichier(f);

    if (kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Aperçu de ' + f.nom;
      zone.appendChild(img);
    } else if ((kind === 'video' || kind === 'audio') && window.GC_lecteur) {
      etat.lecteur = window.GC_lecteur.creer(kind, url, f.nom);
      zone.appendChild(etat.lecteur);
    } else if (kind === 'video') {
      const v = document.createElement('video');
      v.controls = true;
      v.src = url;
      v.className = 'media-apercu';
      zone.appendChild(v);
    } else if (kind === 'audio') {
      const a = document.createElement('audio');
      a.controls = true;
      a.src = url;
      a.className = 'audio-apercu';
      zone.appendChild(a);
    } else if (kind === 'pdf') {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.title = 'Aperçu PDF de ' + f.nom;
      zone.appendChild(iframe);
    } else if (kind === 'code') {
      ouvrirEditeur(f, url);
    } else {
      const p = document.createElement('p');
      p.className = 'apercu-indispo';
      p.textContent = "Aperçu non disponible pour ce type de fichier. Utilise « Télécharger ».";
      zone.appendChild(p);
    }
    ouvrirModale('modale-apercu');
  }

  async function ouvrirEditeur(f, url) {
    const zone = $('contenu-apercu');
    zone.textContent = "Chargement de l'éditeur…";
    try {
      const texte = await fetch(url, { credentials: credentials() }).then(function (r) {
        if (!r.ok) throw new Error('Lecture impossible.');
        return r.text();
      });
      await chargerMonaco();
      vider(zone);
      const hote = document.createElement('div');
      hote.className = 'monaco-hote';
      zone.appendChild(hote);
      const sombre = document.documentElement.getAttribute('data-theme') === 'sombre';
      etat.editeur = window.monaco.editor.create(hote, {
        value: texte,
        language: langueDe(f.nom),
        theme: sombre ? 'vs-dark' : 'vs-light',
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        tabSize: 2,
        renderWhitespace: 'selection'
      });
      etat.texteOriginal = texte;
      const taille = octetsDe(texte);
      const btn = $('apercu-enregistrer');
      const trop = taille > MAX_OCTETS;
      btn.hidden = trop;
      btn.disabled = true;
      const pied = $('pied-apercu');
      pied.hidden = false;
      pied.textContent = 'Langage : ' + langueDe(f.nom) + ' · ' + formaterTaille(taille) +
        (trop ? ' — trop volumineux pour être édité en ligne.' : '');
      etat.editeur.onDidChangeModelContent(function () {
        btn.disabled = etat.editeur.getValue() === etat.texteOriginal;
      });
    } catch (err) {
      zone.textContent = err.message || 'Aperçu indisponible.';
    }
  }

  $('apercu-enregistrer').addEventListener('click', async function () {
    if (!etat.editeur || !etat.fichierCourant) return;
    const btn = $('apercu-enregistrer');
    btn.disabled = true;
    const texte = etat.editeur.getValue();
    try {
      const r = await fetch(API + '/api/files/' + etat.fichierCourant.id + '/content', {
        method: 'PUT',
        credentials: credentials(),
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: texte
      });
      const data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data.error || 'Enregistrement impossible.');
      etat.texteOriginal = texte;
      window.GC_toast('Fichier enregistré.', 'succes');
      chargerFichiers();
    } catch (err) {
      btn.disabled = false;
      window.GC_toast(err.message, 'erreur');
    }
  });

  $('apercu-partager').addEventListener('click', function () {
    if (etat.fichierCourant) ouvrirPartage(etat.fichierCourant);
  });

  // ═════════ Partage ═════════

  function libelleExpiration(p) {
    if (p.expire) return 'Expiré / révoqué' + (p.expireLe ? ' — ' + formaterDate(p.expireLe) : '');
    if (!p.expireLe) return "N'expire jamais";
    return 'Expire le ' + formaterDate(p.expireLe);
  }

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
    vider(zone);
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
        texte.textContent = libelleExpiration(p);
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
    const valeur = $('input-expiration').value;
    const heures = valeur === 'jamais' ? 'jamais' : Number(valeur);
    try {
      const data = await api('/api/shares', {
        method: 'POST',
        body: { fileId: etat.fichierCourant.id, heures: heures }
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
    vider(zone);
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
      tdExpire.textContent = p.expire ? 'inactif' : (p.expireLe ? formaterDate(p.expireLe) : "n'expire jamais");
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
    vider(zone);
    $('btn-vider-corbeille').disabled = fichiers.length === 0;
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
      const groupe = document.createElement('div');
      groupe.className = 'actions-ligne';

      const btnRestaurer = document.createElement('button');
      btnRestaurer.type = 'button';
      btnRestaurer.className = 'btn btn-bleu btn-petit';
      btnRestaurer.textContent = 'Restaurer';
      btnRestaurer.addEventListener('click', async function () {
        try {
          await api('/api/files/' + f.id + '/restore', { method: 'POST' });
          window.GC_toast('Restauré.', 'succes');
          chargerCorbeille();
          chargerQuota();
        } catch (err) {
          window.GC_toast(err.message, 'erreur');
        }
      });

      const btnDefinitif = document.createElement('button');
      btnDefinitif.type = 'button';
      btnDefinitif.className = 'btn btn-danger btn-petit';
      btnDefinitif.textContent = 'Supprimer définitivement';
      btnDefinitif.addEventListener('click', function () {
        demanderConfirmation(
          'Supprimer définitivement ?',
          '« ' + f.nom + ' » sera effacé pour de bon. Cette action est irréversible.',
          'Supprimer pour de bon',
          async function () {
            try {
              await api('/api/files/' + f.id + '?definitif=1', { method: 'DELETE' });
              window.GC_toast('Supprimé définitivement.', 'succes');
              chargerCorbeille();
              chargerQuota();
            } catch (err) {
              window.GC_toast(err.message, 'erreur');
            }
          }
        );
      });

      groupe.appendChild(btnRestaurer);
      groupe.appendChild(btnDefinitif);
      tdAction.appendChild(groupe);
      tr.appendChild(tdNom);
      tr.appendChild(tdDate);
      tr.appendChild(tdAction);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    zone.appendChild(table);
  }

  $('btn-vider-corbeille').addEventListener('click', function () {
    demanderConfirmation(
      'Vider la corbeille ?',
      'Tous les éléments de la corbeille seront effacés définitivement. Action irréversible.',
      'Tout supprimer',
      async function () {
        try {
          const r = await api('/api/trash/vider', { method: 'POST' });
          window.GC_toast((r.supprimes || 0) + ' élément(s) supprimé(s) définitivement.', 'succes');
          chargerCorbeille();
          chargerQuota();
        } catch (err) {
          window.GC_toast(err.message, 'erreur');
        }
      }
    );
  });

  // ═════════ Paramètres : profil ═════════

  async function chargerParametres() {
    rafraichirControlesApparence();
    try {
      const me = await api('/api/auth/me');
      etat.moi = me;
      $('param-email').value = me.email;
      const quota = etat.quota || await api('/api/quota');
      etat.quota = quota;
      const ul = $('meta-compte');
      vider(ul);
      [
        ['Compte créé le', formaterDate(me.createdAt)],
        ['E-mail', me.email],
        ['Espace utilisé', formaterTaille(quota.utiliseOctets) + ' / ' + formaterTaille(quota.quotaOctets) + ' (' + quota.pourcentage + ' %)']
      ].forEach(function (paire) {
        const li = document.createElement('li');
        const fort = document.createElement('strong');
        fort.textContent = paire[0] + ' : ';
        li.appendChild(fort);
        li.appendChild(document.createTextNode(paire[1]));
        ul.appendChild(li);
      });
    } catch (err) {
      if (err.message !== 'SESSION_EXPIREE') window.GC_toast(err.message, 'erreur');
    }
  }

  $('btn-maj-email').addEventListener('click', async function () {
    const email = $('param-email').value.trim();
    if (!email) return;
    try {
      const r = await api('/api/auth/me', { method: 'PATCH', body: { email: email } });
      window.GC_toast('E-mail mis à jour.', 'succes');
      $('email-user').textContent = r.email;
      chargerParametres();
    } catch (err) {
      window.GC_toast(err.message, 'erreur');
    }
  });

  $('btn-maj-pass').addEventListener('click', async function () {
    const actuel = $('param-pass-actuel').value;
    const nouveau = $('param-pass-nouveau').value;
    if (!actuel || !nouveau) {
      window.GC_toast('Renseigne le mot de passe actuel et le nouveau.', 'erreur');
      return;
    }
    try {
      await api('/api/auth/password', { method: 'POST', body: { actuel: actuel, nouveau: nouveau } });
      $('param-pass-actuel').value = '';
      $('param-pass-nouveau').value = '';
      window.GC_toast('Mot de passe changé.', 'succes');
    } catch (err) {
      window.GC_toast(err.message, 'erreur');
    }
  });

  // ═════════ Paramètres : apparence ═════════

  function rafraichirControlesApparence() {
    const o = window.GC_apparence.lire();
    $('param-mode').value = o.mode;
    $('param-accent').value = o.accent;
    $('param-accent-hex').value = o.accent;
    $('param-fond').value = o.fond;
    $('param-radius').value = o.radius;
    $('param-radius-val').textContent = o.radius;
    construireNuancier();
    majApercuApparence();
  }

  function appliquerApparence(modif) {
    window.GC_apparence.appliquer(modif);
    rafraichirControlesApparence();
    if (etat.editeur) {
      try {
        etat.editeur.updateOptions({ theme: document.documentElement.getAttribute('data-theme') === 'sombre' ? 'vs-dark' : 'vs-light' });
      } catch { /* éditeur fermé */ }
    }
  }

  function construireNuancier() {
    const zone = $('nuancier');
    vider(zone);
    const accent = window.GC_apparence.lire().accent.toLowerCase();
    window.GC_apparence.presets.forEach(function (c) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pastille-couleur' + (c.toLowerCase() === accent ? ' actif' : '');
      b.style.background = c;
      b.title = c;
      b.setAttribute('aria-label', 'Couleur ' + c);
      b.addEventListener('click', function () { appliquerApparence({ accent: c }); });
      zone.appendChild(b);
    });
  }

  function majApercuApparence() {
    const o = window.GC_apparence.lire();
    const zone = $('apercu-apparence');
    if (!zone) return;
    const pastille = zone.querySelector('.pastille');
    if (pastille) pastille.style.background = o.accent;
    const lien = zone.querySelector('.lien-demo');
    if (lien) lien.style.color = o.accent;
  }

  $('param-mode').addEventListener('change', function (e) { appliquerApparence({ mode: e.target.value }); });
  $('param-fond').addEventListener('change', function (e) { appliquerApparence({ fond: e.target.value }); });
  $('param-radius').addEventListener('input', function (e) {
    $('param-radius-val').textContent = e.target.value;
    appliquerApparence({ radius: Number(e.target.value) });
  });
  $('param-accent').addEventListener('input', function (e) { appliquerApparence({ accent: e.target.value }); });
  $('param-accent-hex').addEventListener('change', function (e) {
    let v = e.target.value.trim();
    if (v && v[0] !== '#') v = '#' + v;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) appliquerApparence({ accent: v });
    else { e.target.value = window.GC_apparence.lire().accent; window.GC_toast('Couleur invalide (ex. #0000f2).', 'erreur'); }
  });
  $('btn-reset-apparence').addEventListener('click', function () {
    window.GC_apparence.reinitialiser();
    rafraichirControlesApparence();
    window.GC_toast('Design réinitialisé.', 'succes');
  });

  // ═════════ Déconnexion ═════════

  async function deconnecter() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* on redirige quand même */ }
    window.location.href = 'login.html';
  }
  $('btn-deconnexion').addEventListener('click', deconnecter);
  const btnDeconnexionMobile = $('btn-deconnexion-mobile');
  if (btnDeconnexionMobile) btnDeconnexionMobile.addEventListener('click', deconnecter);

  // ═════════ Démarrage ═════════

  (async function demarrer() {
    try {
      const sante = await fetch(API + '/api/health', { credentials: credentials() })
        .then(function (r) { return r.json(); });
      if (sante && sante.maxFichierOctets) MAX_OCTETS = sante.maxFichierOctets;
    } catch { /* valeur par défaut */ }
    if (zoneDepot) zoneDepot.textContent = texteZoneDepot();
    try {
      const me = await api('/api/auth/me');
      etat.moi = me;
      $('email-user').textContent = me.email;
    } catch { /* redirection login déjà lancée */ }
    rendreFilAriane();
    activerVue('fichiers');
  })();
})();
