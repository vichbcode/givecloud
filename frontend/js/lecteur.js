// ═══════════════════════════════════════════════════════════════
// GiveCloud — lecteur multimédia « type VLC »
//   • vidéo ET audio avec contrôles complets (lecture, avance, volume,
//     vitesse, image-dans-l'image, plein écran, raccourcis clavier) ;
//   • lecture native d'abord ; si le navigateur ne sait pas décoder le
//     codec (AC3, DTS, HEVC, MKV…), conversion à la volée via ffmpeg.wasm
//     (chargé à la demande depuis le CDN) puis lecture du résultat ;
//   • système de sous-titres : ajout d'un fichier .srt/.vtt/.ass, décalage
//     réglable, affichage synchronisé.
// Règle d'or : AUCUNE donnée utilisateur en innerHTML.
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm';
  const FFMPEG_JS = CDN + '/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';
  const FFMPEG_UTIL = CDN + '/@ffmpeg/util@0.12.1/dist/umd/index.js';
  const CORE_JS = CDN + '/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js';
  const CORE_WASM = CDN + '/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm';

  // ── Utilitaires DOM sûrs ──
  function el(tag, classe, texte) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texte !== undefined) e.textContent = texte;
    return e;
  }
  function vider(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function formaterTemps(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const h = Math.floor(m / 60);
    const mm = h > 0 ? String(m % 60).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }

  // ── Chargement dynamique de scripts (CDN autorisé par la CSP) ──
  function chargerScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Chargement impossible (' + src + ').')); };
      document.head.appendChild(s);
    });
  }

  // ── ffmpeg.wasm : conversion à la volée des codecs non lus nativement ──
  let promesseFfmpeg = null;
  function chargerFfmpeg() {
    if (promesseFfmpeg) return promesseFfmpeg;
    promesseFfmpeg = (async function () {
      await chargerScript(FFMPEG_UTIL);
      await chargerScript(FFMPEG_JS);
      const util = window.FFmpegUtil;
      const FFmpeg = window.FFmpegWASM.FFmpeg;
      const ff = new FFmpeg();
      await ff.load({
        coreURL: await util.toBlobURL(CORE_JS, 'text/javascript'),
        wasmURL: await util.toBlobURL(CORE_WASM, 'application/wasm')
      });
      return ff;
    })();
    // En cas d'échec, on autorise une nouvelle tentative à la prochaine ouverture.
    promesseFfmpeg.catch(function () { promesseFfmpeg = null; });
    return promesseFfmpeg;
  }

  // ── Sous-titres : analyse .srt / .vtt / .ass (best effort) ──
  function analyserTimestamp(s) {
    const m = String(s).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return NaN;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) +
      parseInt(String(m[4]).padEnd(3, '0'), 10) / 1000;
  }

  function analyserSousTitres(texte) {
    const t = String(texte).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    const cues = [];
    // Format ASS/SSA : "Dialogue: 0,0:00:01.00,0:00:03.00,Style,,,,".
    if (/^\s*\[Script Info\]/im.test(t) || /^\s*Dialogue:/im.test(t)) {
      t.split('\n').forEach(function (ligne) {
        const m = ligne.match(/^\s*Dialogue:[^,]*,\s*([^,]+),\s*([^,]+),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/);
        if (!m) return;
        const debut = analyserTimestamp(m[1]);
        const fin = analyserTimestamp(m[2]);
        if (isNaN(debut) || isNaN(fin)) return;
        const txt = m[8].replace(/\\N/gi, '\n').replace(/\{[^}]*\}/g, '');
        cues.push({ debut: debut, fin: fin, texte: txt });
      });
      cues.sort(function (a, b) { return a.debut - b.debut; });
      return cues;
    }
    // Formats SRT / VTT.
    t.split(/\n{2,}/).forEach(function (bloc) {
      const lignes = bloc.split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lignes.length) return;
      let i = /^\d+$/.test(lignes[0].trim()) ? 1 : 0;
      if (lignes[i] && /^WEBVTT/i.test(lignes[i].trim())) return;
      const ligneTemps = lignes[i];
      if (!ligneTemps || ligneTemps.indexOf('-->') === -1) return;
      const parts = ligneTemps.split('-->');
      const debut = analyserTimestamp(parts[0]);
      const fin = analyserTimestamp(parts[1]);
      if (isNaN(debut) || isNaN(fin)) return;
      cues.push({ debut: debut, fin: fin, texte: lignes.slice(i + 1).join('\n') });
    });
    cues.sort(function (a, b) { return a.debut - b.debut; });
    return cues;
  }

  function afficherSousTitre(cible, texte) {
    vider(cible);
    const lignes = String(texte).split('\n');
    lignes.forEach(function (l, idx) {
      const propre = l.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '');
      if (idx > 0) cible.appendChild(document.createElement('br'));
      cible.appendChild(document.createTextNode(propre));
    });
  }

  // ═════════ Création d'un lecteur ═════════
  // type : 'video' | 'audio' ; url : source (route /content) ; nom : nom du fichier.
  function creer(type, url, nom) {
    const estVideo = type === 'video';
    const racine = el('div', 'gc-lecteur ' + (estVideo ? 'gc-lecteur-video' : 'gc-lecteur-audio'));
    racine.tabIndex = 0;

    const media = document.createElement(estVideo ? 'video' : 'audio');
    media.className = 'gc-media';
    media.setAttribute('playsinline', '');
    media.preload = 'metadata';
    media.src = url;

    if (!estVideo) {
      const visuel = el('div', 'gc-audio-visuel');
      visuel.appendChild(el('span', 'gc-audio-ico', '🎵'));
      visuel.appendChild(el('span', 'gc-audio-nom', nom || ''));
      racine.appendChild(visuel);
    }
    racine.appendChild(media);

    const calque = el('div', 'gc-sous-titres');
    calque.setAttribute('aria-live', 'off');
    racine.appendChild(calque);

    const etat = el('div', 'gc-etat');
    etat.hidden = true;
    racine.appendChild(etat);

    // ── Barre de contrôle ──
    const barre = el('div', 'gc-barre');
    racine.appendChild(barre);

    function bouton(sym, titre) {
      const b = el('button', 'gc-btn', sym);
      b.type = 'button';
      b.title = titre;
      b.setAttribute('aria-label', titre);
      return b;
    }

    const btnPlay = bouton('▶', 'Lecture / pause');
    const temps = el('span', 'gc-temps', '0:00 / 0:00');

    const seek = el('input', 'gc-seek');
    seek.type = 'range';
    seek.min = '0';
    seek.max = '1000';
    seek.value = '0';
    seek.step = '1';
    seek.setAttribute('aria-label', 'Position de lecture');
    seek.disabled = true;

    const volume = el('input', 'gc-volume-range');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.02';
    volume.value = '1';
    volume.setAttribute('aria-label', 'Volume');

    const btnVolume = bouton('🔊', 'Couper / réactiver le son');

    const vitesse = el('select', 'gc-vitesse');
    vitesse.setAttribute('aria-label', 'Vitesse de lecture');
    [['0.25', '0.25×'], ['0.5', '0.5×'], ['0.75', '0.75×'], ['1', '1×'],
     ['1.25', '1.25×'], ['1.5', '1.5×'], ['1.75', '1.75×'], ['2', '2×']].forEach(function (v) {
      const o = el('option', null, v[1]);
      o.value = v[0];
      if (v[0] === '1') o.selected = true;
      vitesse.appendChild(o);
    });

    const btnSt = bouton('CC', 'Sous-titres');

    let btnPip = null;
    if (estVideo && document.pictureInPictureEnabled) {
      btnPip = bouton('⧉', 'Image dans l’image');
    }
    const btnFull = bouton('⛶', 'Plein écran');

    barre.appendChild(btnPlay);
    barre.appendChild(temps);
    barre.appendChild(seek);
    barre.appendChild(btnVolume);
    barre.appendChild(volume);
    barre.appendChild(vitesse);
    barre.appendChild(btnSt);
    if (btnPip) barre.appendChild(btnPip);
    barre.appendChild(btnFull);

    // ── Panneau sous-titres ──
    const panneau = el('div', 'gc-panneau');
    panneau.hidden = true;
    const champSt = el('label', 'gc-panneau-titre', 'Sous-titres');
    const inputSt = document.createElement('input');
    inputSt.type = 'file';
    inputSt.accept = '.srt,.vtt,.ass,.ssa,.sub,text/vtt';
    inputSt.className = 'sr-only';
    const btnStFichier = el('button', 'btn btn-bleu btn-petit', 'Ajouter un fichier (.srt, .vtt)');
    btnStFichier.type = 'button';
    const ligneSt = el('div', 'gc-panneau-ligne');
    const btnStToggle = el('button', 'btn btn-contour btn-petit', 'Désactiver');
    btnStToggle.type = 'button';
    btnStToggle.disabled = true;
    const infoSt = el('span', 'gc-st-info', 'Aucun sous-titre chargé.');
    const offsetWrap = el('div', 'gc-panneau-ligne');
    const offsetLabel = el('span', 'gc-st-info', 'Décalage :');
    const offsetMoins = el('button', 'gc-btn', '−');
    offsetMoins.type = 'button';
    offsetMoins.title = 'Avancer les sous-titres de 0,5 s';
    const offsetValeur = el('span', 'gc-st-info', '0,0 s');
    const offsetPlus = el('button', 'gc-btn', '+');
    offsetPlus.type = 'button';
    offsetPlus.title = 'Retarder les sous-titres de 0,5 s';

    panneau.appendChild(champSt);
    panneau.appendChild(btnStFichier);
    panneau.appendChild(inputSt);
    ligneSt.appendChild(btnStToggle);
    ligneSt.appendChild(infoSt);
    panneau.appendChild(ligneSt);
    offsetWrap.appendChild(offsetLabel);
    offsetWrap.appendChild(offsetMoins);
    offsetWrap.appendChild(offsetValeur);
    offsetWrap.appendChild(offsetPlus);
    panneau.appendChild(offsetWrap);
    racine.appendChild(panneau);

    // ── État du lecteur ──
    const st = { cues: [], actif: false, offset: 0, nom: null };
    let urlObjet = null;      // URL blob de la conversion
    let converti = false;

    function majBoutonPlay() {
      btnPlay.textContent = media.paused ? '▶' : '❚❚';
    }

    function majTemps() {
      temps.textContent = formaterTemps(media.currentTime) + ' / ' + formaterTemps(media.duration);
      if (isFinite(media.duration) && media.duration > 0) {
        seek.disabled = false;
        seek.value = String(Math.round((media.currentTime / media.duration) * 1000));
      }
    }

    function majSousTitreAffiche() {
      if (!st.actif || !st.cues.length) { vider(calque); return; }
      const t = media.currentTime - st.offset;
      let cue = null;
      for (let i = 0; i < st.cues.length; i++) {
        const c = st.cues[i];
        if (c.debut > t) break;
        if (t >= c.debut && t <= c.fin) { cue = c; break; }
      }
      if (cue) afficherSousTitre(calque, cue.texte);
      else vider(calque);
    }

    // ── Conversion à la volée (codecs non lus nativement) ──
    async function convertir() {
      if (converti) return;
      converti = true;
      etat.hidden = false;
      etat.textContent = 'Préparation du convertisseur…';
      btnPlay.disabled = true;
      try {
        const ff = await chargerFfmpeg();
        const extension = (String(nom || 'fichier').split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
        const entree = 'entree.' + extension;
        const sortie = estVideo ? 'sortie.mp4' : 'sortie.m4a';

        etat.textContent = 'Téléchargement du fichier…';
        const octets = new Uint8Array(await (await fetch(url, { credentials: 'same-origin' })).arrayBuffer());
        await ff.writeFile(entree, octets);

        const prog = function (p) {
          etat.textContent = 'Conversion en cours… ' + Math.round(Math.max(0, Math.min(1, p)) * 100) + ' %';
        };
        ff.on('progress', prog);
        etat.textContent = 'Conversion en cours…';
        const args = estVideo
          ? ['-i', entree, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
             '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', sortie]
          : ['-i', entree, '-vn', '-c:a', 'aac', '-b:a', '192k', sortie];
        await ff.exec(args);
        ff.off('progress', prog);

        const data = await ff.readFile(sortie);
        const blob = new Blob([data], { type: estVideo ? 'video/mp4' : 'audio/mp4' });
        urlObjet = URL.createObjectURL(blob);
        media.src = urlObjet;
        etat.hidden = true;
        btnPlay.disabled = false;
        try { await ff.deleteFile(entree); } catch (e) { /* ignore */ }
        try { await ff.deleteFile(sortie); } catch (e) { /* ignore */ }
        media.play().catch(function () {});
      } catch (err) {
        etat.textContent = 'Lecture impossible : ' + (err && err.message ? err.message : 'codec non pris en charge') +
          '.';
        btnPlay.disabled = false;
      }
    }

    function proposerConversion() {
      if (converti) return;
      etat.hidden = false;
      vider(etat);
      etat.appendChild(document.createTextNode('Ce format n’est pas lu directement par le navigateur. '));
      const b = el('button', 'btn btn-bleu btn-petit', 'Convertir pour lire');
      b.type = 'button';
      b.addEventListener('click', convertir);
      etat.appendChild(b);
    }

    // ── Événements média ──
    media.addEventListener('loadedmetadata', majTemps);
    media.addEventListener('durationchange', majTemps);
    media.addEventListener('timeupdate', function () { majTemps(); majSousTitreAffiche(); });
    media.addEventListener('play', majBoutonPlay);
    media.addEventListener('pause', majBoutonPlay);
    media.addEventListener('ended', majBoutonPlay);
    media.addEventListener('error', proposerConversion);
    media.addEventListener('volumechange', function () {
      btnVolume.textContent = media.muted || media.volume === 0 ? '🔇' : '🔊';
    });

    btnPlay.addEventListener('click', function () {
      if (media.paused) media.play().catch(function () { proposerConversion(); });
      else media.pause();
    });

    seek.addEventListener('input', function () {
      if (isFinite(media.duration)) media.currentTime = (Number(seek.value) / 1000) * media.duration;
    });

    volume.addEventListener('input', function () {
      media.volume = Number(volume.value);
      media.muted = media.volume === 0;
    });

    btnVolume.addEventListener('click', function () {
      media.muted = !media.muted;
      if (!media.muted && media.volume === 0) { media.volume = 1; volume.value = '1'; }
    });

    vitesse.addEventListener('change', function () { media.playbackRate = Number(vitesse.value); });

    if (btnPip) {
      btnPip.addEventListener('click', function () {
        try {
          if (document.pictureInPictureElement) document.exitPictureInPicture();
          else media.requestPictureInPicture();
        } catch (e) { /* non supporté */ }
      });
    }

    btnFull.addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (racine.requestFullscreen) racine.requestFullscreen();
    });

    // ── Sous-titres : interactions ──
    btnSt.addEventListener('click', function () {
      panneau.hidden = !panneau.hidden;
    });

    function majInfoSt() {
      if (st.cues.length) {
        infoSt.textContent = (st.nom || 'Sous-titres') + ' — ' + st.cues.length + ' réplique(s)';
        btnStToggle.disabled = false;
        btnStToggle.textContent = st.actif ? 'Désactiver' : 'Activer';
      } else {
        infoSt.textContent = 'Aucun sous-titre chargé.';
        btnStToggle.disabled = true;
      }
    }

    btnStFichier.addEventListener('click', function () { inputSt.click(); });

    inputSt.addEventListener('change', async function () {
      const f = inputSt.files && inputSt.files[0];
      inputSt.value = '';
      if (!f) return;
      try {
        const texte = await f.text();
        const cues = analyserSousTitres(texte);
        if (!cues.length) {
          infoSt.textContent = 'Aucune piste reconnue dans ce fichier.';
          return;
        }
        st.cues = cues;
        st.nom = f.name;
        st.actif = true;
        st.offset = 0;
        offsetValeur.textContent = '0,0 s';
        majInfoSt();
        majSousTitreAffiche();
      } catch (err) {
        infoSt.textContent = 'Lecture du fichier impossible.';
      }
    });

    btnStToggle.addEventListener('click', function () {
      st.actif = !st.actif;
      majInfoSt();
      majSousTitreAffiche();
    });

    function majOffset() {
      offsetValeur.textContent = (st.offset > 0 ? '+' : '') + st.offset.toFixed(1).replace('.', ',') + ' s';
      majSousTitreAffiche();
    }
    offsetMoins.addEventListener('click', function () { st.offset -= 0.5; majOffset(); });
    offsetPlus.addEventListener('click', function () { st.offset += 0.5; majOffset(); });

    // ── Raccourcis clavier ──
    racine.addEventListener('keydown', function (e) {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); btnPlay.click(); break;
        case 'ArrowRight': media.currentTime = Math.min((media.duration || 0), media.currentTime + 5); break;
        case 'ArrowLeft': media.currentTime = Math.max(0, media.currentTime - 5); break;
        case 'ArrowUp': e.preventDefault(); media.volume = Math.min(1, media.volume + 0.05); volume.value = String(media.volume); break;
        case 'ArrowDown': e.preventDefault(); media.volume = Math.max(0, media.volume - 0.05); volume.value = String(media.volume); break;
        case 'm': media.muted = !media.muted; break;
        case 'f': btnFull.click(); break;
        case 'c': st.actif = !st.actif; majInfoSt(); majSousTitreAffiche(); break;
      }
    });

    racine.gcDetruire = function () {
      try { media.pause(); } catch (e) { /* ignore */ }
      try { media.removeAttribute('src'); media.load(); } catch (e) { /* ignore */ }
      if (urlObjet) { URL.revokeObjectURL(urlObjet); urlObjet = null; }
    };

    return racine;
  }

  window.GC_lecteur = { creer: creer, analyserSousTitres: analyserSousTitres };
})();
