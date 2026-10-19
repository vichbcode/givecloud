# GiveCloud

Un cloud de stockage multi-utilisateurs qui utilise **Airtable** comme base de données
et stockage de pièces jointes. Front 100 % statique (HTML/CSS/JS vanilla), API sécurisée
en **fonction serverless Vercel**. Couleur principale : le bleu électrique `#0000f2`.

```
Navigateur (front statique) ──► Vercel (statique + API serverless) ──► Airtable
```

**Pourquoi cette architecture est obligatoire ?**
1. Le token Airtable a un accès complet à la base : s'il était dans le front, n'importe
   qui pourrait le voler (code source, onglet Réseau) et lire/effacer toute la base.
2. Le front ne peut pas faire de hachage de mot de passe fiable, de rate limiting, ni
   de validation serveur : tout ça vit dans la fonction serveur, où le code est secret.
3. Airtable ne peut pas servir de backend d'authentification (pas de comptes, pas de
   sessions) : l'API est le cerveau, Airtable n'est que le disque dur.

---

## Arborescence

```
GiveCloud/
├── .gitignore                 # exclut tous les secrets
├── README.md                  # ce guide
├── vercel.json                # config Vercel (statique frontend/ + fonction api/)
├── api/
│   └── index.js               # fonction serverless : adapte req/res → lib/app.js
├── lib/
│   └── app.js                 # TOUTE l'API : auth, files, shares, proxy Airtable
├── frontend/                  # front statique servi par Vercel
│   ├── index.html             # page vitrine
│   ├── login.html             # connexion / inscription
│   ├── app.html               # le cloud (sidebar bleue, fichiers, quota)
│   ├── css/
│   │   └── style.css          # design system bleu, mode sombre, responsive
│   └── js/
│       ├── config.js          # URL de l'API (vide = même origine)
│       ├── theme.js           # apparence (mode clair/sombre, accent, arrondis, fond) + toasts
│       ├── landing.js         # animations vitrine, onglets, thème
│       ├── auth.js            # page login
│       └── app.js             # logique du cloud (upload, liste, dossiers, visionneuse, éditeur, paramètres…)
└── worker/                    # ALTERNATIVE Cloudflare (optionnelle, même logique)
    ├── wrangler.toml
    └── src/index.js
```

> **Hébergement** : le déploiement principal est **GitHub (code) + Vercel (site + API)**.
> Le dossier `worker/` est une alternative si tu préfères Cloudflare Workers ;
> la logique métier y est dupliquée dans `worker/src/index.js`.

---

## Chiffres Airtable à connaître (vérifiés sur la doc officielle, oct. 2026)

| Limite | Valeur | Conséquence dans GiveCloud |
|---|---|---|
| Upload pièce jointe par l'API | **5 Mo max** par fichier | Bloqué côté front ET côté serveur (413) — **3 Mo effectifs sur Vercel** (limite de 4,5 Mo du corps de requête, base64 inclus) |
| Rate limit API | **5 requêtes/s par base** (50/s par token toutes bases) | L'API retry automatiquement sur 429 (back-off) |
| Appels API — plan gratuit | **1 000 / mois par workspace** | Dépassé → 30 jours de grâce, puis 429 bloquants jusqu'au 1er du mois suivant |
| Enregistrements — plan gratuit | **1 000 / base** (cumulé entre tables) | plein → plus d'ajout possible, jamais de suppression auto, message d'erreur généré par Airtable (422) |
| Stockage pièces jointes — plan gratuit | **1 Go / base** | plein → plus d'upload possible, données jamais supprimées, il faut upgrader |
| Pagination API | 100 enregistrements / page | l'API pagine automatiquement |

---

# GUIDE PAS À PAS — ce que TU dois faire à la main

## Étape 1 — Créer le compte Airtable, la base et les tables

1. Va sur <https://airtable.com/signup> et crée un compte gratuit.
2. Crée un workspace nommé **GiveCloud**.
3. Dans ce workspace : **+ Add another base → Start from scratch**, nomme-la **GiveCloud**.
4. La base contient une table `Table1`. Renomme-la : clic droit sur l'onglet →
   **Rename** → `Users`. Supprime toutes les colonnes sauf la première (champ principal) :

   | Champ principal (ouvre le premier) | Nom exact | Type exact | Réglages |
   |---|---|---|---|
   | ✔ (colonne A) | `email` | Single line text | — |
   | + | `passwordHash` | Single line text | — |
   | + | `salt` | Single line text | — |
   | + | `iterations` | Number | Format: Integer |
   | + | `createdAt` | Created time | — (rempli automatiquement) |
   | + | `quotaMo` | Number | Format: Integer, Default: `23552` (23 Go) |

5. Clique sur **+ Add or import → Create empty table**, nomme-la `Files` :

   | Champ | Nom exact | Type exact | Réglages |
   |---|---|---|---|
   | ✔ (principal) | `nom` | Single line text | — |
   | + | `chemin` | Single line text | — |
   | + | `taille` | Number | Format: Integer (octets) |
   | + | `type` | Single line text | — |
   | + | `proprietaire` | Single line text | — (ID du record Users) |
   | + | `fichier` | Attachment | — |
   | + | `supprimeLe` | Date | Include time: **oui** (vide = fichier actif) |

6. Ajoute une 3ᵉ table **+ Add or import → Create empty table**, nomme-la `Shares` :

   | Champ | Nom exact | Type exact | Réglages |
   |---|---|---|---|
   | ✔ (principal) | `token` | Single line text | — |
   | + | `fichier` | Single line text | — (ID du record Files) |
   | + | `expireLe` | Date | Include time: **oui** |
   | + | `revoque` | Checkbox | — |

7. **Si tout va bien** : tu vois 3 onglets `Users`, `Files`, `Shares`, tables vides,
   aucun message d'erreur. **Si un type est grisant/invalide** : vérifie le type dans
   le menu déroulant du champ (clic sur le nom de la colonne → Change field type).

> Les noms de champs sont **sensibles à la casse** : `passwordHash` et pas `passwordhash`.
> Le code du Worker utilise ces noms exacts (modifiables dans `wrangler.toml`).

## Étape 2 — Token personnel Airtable + ID de la base

1. Va sur <https://airtable.com/create/tokens> → **Create personal access token**.
2. Nom : `givecloud-worker`.
3. **Scopes** → Add a scope → cherche et coche **exactement** :
   - `data.records:read`
   - `data.records:write`
   (inutile d'en ajouter d'autres — c'est le principe des permissions minimales ;
   le Worker lit/écrit les records et upload les pièces jointes, rien de plus).
4. **Access** → **+ Add a base** → **Select specific base** → **GiveCloud**
   (jamais « All workspaces » : le token ne doit voir qu'une seule base).
5. **Create token** → cople-le **immédiatement** (affiché une seule fois) dans un
   gestionnaire de mots de passe. Ce token ne doit JAMAIS être commité ni collé dans le front.
6. Récupère l'**ID de la base** : ouvre ta base GiveCloud → regarde l'URL du navigateur :
   `https://airtable.com/appABC123XYZ...` → l'ID est la partie qui commence par **`app`**
   (ex. `appABC123XYZ`). Copie-le aussi.
7. *(Facultatif)* Les **IDs de tables** (`tbl...`) ne sont pas nécessaires : le Worker
   utilise les **noms** de tables (`Users`, `Files`, `Shares`).

**Si ça échoue au moment des tests** : token invalide → 401 dans les logs du Worker ;
base incorrecte → 404 `MODEL_NOT_FOUND`. Vérifie scope et base assignée dans
<https://airtable.com/create/tokens>.

## Étape 3 — Node.js, GitHub

1. Installe **Node.js LTS** (≥ 20) : <https://nodejs.org> → version LTS. Vérifie :
   ```powershell
   node -v    # doit afficher v20.x ou v22.x
   npm -v
   ```
2. Installe **Git** : <https://git-scm.com/download/win> (options par défaut).
   Vérifie : `git --version`
3. Crée un compte sur <https://github.com> (gratuit).
4. Prépare le dépôt local (depuis la racine du projet, le dossier `GiveCloud`) :
   ```powershell
   cd "D:\00 GiveCloud"
   git init
   git add .
   git commit -m "GiveCloud — cloud Airtable + API Vercel"
   ```
   **Si tout va bien** : `git status` affiche « nothing to commit » et le
   `.gitignore` a bien exclu tout fichier sensible (vérifie qu'aucun `.env`,
   `.dev.vars` n'est listé par `git ls-files`).
5. Sur GitHub : **+ → New repository** → nom `givecloud` → **Private** (recommandé)
   → **Create repository**, puis colle les 3 commandes affichées :
   ```powershell
   git remote add origin https://github.com/<ton-pseudo>/givecloud.git
   git branch -M main
   git push -u origin main
   ```
**Si le push échoue** : GitHub te demande un mot de passe → utilise un
**Personal Access Token** (github.com → Settings → Developer settings → Tokens)
ou installe **GitHub Desktop** qui gère l'authentification pour toi.

## Étape 4 — Compte Vercel + import du projet

1. Crée un compte sur <https://vercel.com> (gratuit) → **Continue with GitHub**
   (autorise l'accès au repo `givecloud`).
2. Dashboard → **Add New… → Project** → dans *Import Git Repository*, sélectionne
   `givecloud` → **Import**.
3. Dans l'écran de configuration, **ne change rien** :
   - Framework Preset : **Other**
   - Build Command : *(vide)*
   - Output Directory : `frontend` (déjà lu depuis `vercel.json`)
4. **AVANT de cliquer Deploy** : ajoute les variables d'environnement
   (onglet *Environment Variables*) :

   | Nom | Valeur |
   |---|---|
   | `AIRTABLE_TOKEN` | le token pat de l'étape 2 |
   | `BASE_ID` | `appXXXXXXXX` |
   | `SESSION_SECRET` | généré par : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

   (Optionnelles : `QUOTA_MO_DEFAULT=23552` — quota par défaut d'un nouveau
   compte, en Mo (23 Go). Les noms de tables ont des valeurs par défaut
   `Users` / `Files` / `Shares`.)
5. Clique **Deploy**.
   **Si tout va bien** : après ~30 s, Vercel affiche « Congratulations! » et te
   donne une URL du type `https://givecloud-xxxx.vercel.app`. Ouvre
   `https://givecloud-xxxx.vercel.app/api/health` → `{"ok":true,"service":"givecloud-api",...}`.
   **Si erreur « Configuration serveur incomplète »** : une des 3 variables manque
   → reviens dans Settings → Environment Variables, vérifie les noms (majuscules),
   puis **Redeploy**.
   **Si erreur de build** : onglet Deployments → clic sur le déploiement raté →
   *Building Logs* → l'erreur s'affiche ; en principe tout est validé dans ce dépôt.
6. **Ne commite JAMAIS les valeurs** : elles vivent uniquement dans Vercel
   (Settings → Environment Variables). Le `.gitignore` protège déjà les fichiers locaux.

## Étape 5 — Mise à jour automatique

À chaque `git push` sur `main`, Vercel redéploie automatiquement le site **et**
l'API. Ouvre l'URL Vercel : la vitrine apparaît, « Commencer » mène à l'inscription.
Front et API sont sur la **même origine** (`*.vercel.app`) → cookies
`SameSite=Strict` fonctionnent, pas de CORS, pas de configuration `API_BASE`.

**Si le front charge mais la page est vide** : F12 → onglet *Console* →
une erreur CSP ou 404 ? Vérifie que `frontend/js/config.js` contient bien
`API_BASE: ''`.

**Domaine custom (optionnel)** : Vercel → Project → Settings → Domains →
ajoute ton domaine, puis suis le CNAME/ALIAS chez ton registrar.

## Étape 6 — Tests de sécurité à faire TOI-MÊME

Ouvre les DevTools (F12) pendant tous les tests.

1. **Anti-IDOR** : crée 2 comptes (A et B). Connecte-toi en A, upload un fichier, copie
   son ID (visible dans la réponse `GET /api/files` → onglet Réseau). Déconnecte-toi,
   connecte-toi en B, ouvre `fetch('/api/files/<ID_A>/download')` dans
   la console → tu dois recevoir **404/403**, jamais le fichier.
   Idem avec l'URL de partage d'un fichier supprimé/ révoqué.
2. **Token Airtable absent du front** : F12 → onglet *Sources* + *Réseau* : aucun `pat`,
   aucune URL `api.airtable.com`, aucun `app...` n'apparaît. Teste aussi `curl` sur le
   serveur avec une route inexistante : le message d'erreur ne reflète jamais l'airtable token.
3. **Cookie HttpOnly** : F12 → *Application* → *Cookies* → le cookie `gc_session` doit
   afficher **HttpOnly** ✔, **Secure** ✔, **SameSite=Strict**. Dans la console,
   `document.cookie` doit renvoyer **une chaîne vide** (le jeton n'est jamais lisible en JS).
4. **Brute-force** : rate-limit 5 tentatives / 10 min sur login/register — échoue 6 fois
   volontairement → 429 "Trop de tentatives." avec le même message d'erreur générique.
   (Attention : en serverless, chaque instance a sa limite — testée plusieurs fois
   d'affilée, tu tomberas sur la même instance et le 429 arrivera.)
5. **Upload dangereux** : essaie d'envoyer un `.exe`, un `.bat`, un `.ps1`, un `.dll`
   → 415 bloqué, côté front ET côté serveur (testé aussi via `fetch` en curl pour
   contourner le front). Les fichiers de **code** (`.js`, `.py`, `.html`…) sont
   autorisés : ils ne sont jamais exécutés (téléchargement en `attachment`, aperçu
   servi en `inline` mais sous CSP `sandbox`), et uniquement éditables dans Monaco.
6. **Taille** : essaie un fichier de 4 Mo → 413 côté front (barre d'erreur) et côté
   serveur (teste avec curl pour prouver la validation serveur).
7. **XSS** : renomme un fichier en `<img src=x onerror=alert(1)>` → le nom s'affiche
   en texte brut dans la liste (aucune exécution). Vérifie aussi le partage.
8. **HSTS / en-têtes** : `curl -I https://ton-projet.vercel.app/` → présences de
   `strict-transport-security`, `x-content-type-options: nosniff`,
   `referrer-policy`.
9. **Corbeille** : supprime un fichier → il part dans la corbeille (champ `supprimeLe`),
   restaure-le, vérifie qu'aucun autre utilisateur ne le voit.
10. **Partage** : crée un lien avec expiration 1 h, ouvre-le en navigation privée
    (sans cookies) → il fonctionne ; clique "Révoquer" → rechargement en navigation
    privée → lien mort. Crée un lien « **Jamais** » → il ne doit jamais expirer.
11. **Profil** : change ton e-mail dans Paramètres → la session reste valide (cookie
    re-signé) ; re-connecte-toi avec le nouvel e-mail. Change ton mot de passe → un
    ancien mot de passe doit être refusé, et le nouveau accepté (sel + hash neufs).
12. **Corbeille — suppression définitive** : supprime un fichier, puis dans la corbeille
    clique « Supprimer définitivement » (ou « Vider la corbeille ») → le record disparaît
    réellement d'Airtable (et non plus seulement masqué).
13. **Éditeur** : ouvre un `.js`/`.txt`, modifie le contenu, clique « Enregistrer » →
    recharge le fichier (l'éditeur affiche la nouvelle version, la taille est mise à jour).

---

# Checklist de sécurité

- [x] Token Airtable uniquement en variables d'environnement Vercel, jamais dans le front ni Git
- [x] `.gitignore` couvre `.env`, `.dev.vars`, `.vercel/`, secrets
- [x] Mots de passe hachés PBKDF2-SHA256, 210 000 itérations, sel unique 16 octets
- [x] Changement de mot de passe : ancien vérifié, sel + hash régénérés
- [x] Changement d'e-mail : unicité revérifiée, cookie JWT re-signé
- [x] Comparaison de hashs à temps constant
- [x] Session : JWT signé HMAC-SHA256 en cookie `HttpOnly; Secure; SameSite=Strict` (7 jours)
- [x] Aucun jeton en localStorage ni dans le DOM
- [x] Vérification propriétaire sur CHAQUE route fichier (anti-IDOR)
- [x] Rate limiting login/register : 5 essais / 10 min / IP + messages génériques
- [x] CORS limité à `ALLOWED_ORIGIN` (vide = même origine)
- [x] En-têtes : X-Content-Type-Options, Referrer-Policy, HSTS, X-Frame-Options,
      Permissions-Policy sur toutes les pages (via vercel.json) + toutes les réponses API
- [x] Validation serveur : taille ≤ 3 Mo (plafond Vercel), extension bloquée
      (exécutables natifs uniquement — le code éditable est autorisé)
- [x] Téléchargement toujours servi avec `Content-Disposition: attachment`
- [x] Aperçu / visionneuse / éditeur servis en `inline` sous CSP `sandbox`
      + `X-Content-Type-Options: nosniff` (aucune exécution possible)
- [x] URLs d'attachments Airtable régénérées à chaque téléchargement, jamais stockées
- [x] Retry automatique sur 429 (back-off exponentiel, 4 essais)
- [x] Purge de la corbeille après 30 jours ; suppression définitive sur demande
- [x] Rate limiting dédié sur le changement de mot de passe (5 essais / 10 min / IP)
- [x] Front : `textContent` uniquement pour les données utilisateur (anti-XSS),
      `innerHTML` interdit sur données dynamiques
- [x] CSP stricte en `<meta>` sur les pages HTML

# Limites honnêtes de la solution

1. **Upload plafonné à 3 Mo sur Vercel** : Airtable accepte 5 Mo, mais les
   fonctions serverless Vercel limitent le corps de requête à ~4,5 Mo (base64
   inclus ⇒ +33 %). Le front affiche la vraie limite récupérée sur `/api/health`.
2. **Rate limiting en mémoire** : les compteurs vivent dans l'instance serverless
   et repartent à zéro au cold start ou quand Vercel en lance une nouvelle. Un
   attaquant patient peut contourner. Solution pro : Upstash Redis ou Vercel KV.
3. **JWT sans révocation** : un jeton volé reste valide jusqu'à 7 jours (sauf si on
   change `SESSION_SECRET`, ce qui déconnecte tout le monde). Solution pro : liste
   de révocation en base.
4. **Plan gratuit Airtable = 1 000 appels API/mois** : très vite atteint en usage
   réel (chaque page de liste = 1+ appel). 30 jours de grâce puis blocage total.
   En pratique il faut un plan Team (100 000 appels/mois) pour un usage sérieux.
5. **1 Go de stockage et 1 000 enregistrements/base** en gratuit : ~ quelques centaines
   de fichiers max, partagés par tous les utilisateurs. Les quotas par utilisateur
   (23 Go par défaut) sont une convention interne, **pas** une isolation physique : le
   stockage réel reste celui d'Airtable (1 Go en gratuit).
6. **Proxy de téléchargement** : le serveur streamme les fichiers (3 Mo max), ce qui
   compte dans la bande passante et la durée d'exécution de la fonction Vercel
   (maxDuration = 30 s configuré).
7. **Pas de chiffrement au repos côté Airtable** : les fichiers sont chez Airtable,
   protégés par leur sécurité à eux (TLS en transit, chiffrement chez eux au repos).
   GiveCloud ne peut pas promettre le zéro-knowledge.
8. **Suppression = corbeille logique** : le fichier reste dans Airtable (champ
   `supprimeLe`) pendant 30 jours ; la purge physique est faite par le serveur
   à ta première liste suivante. Tant que personne ne visite, rien n'est purgé.
9. **Plan Hobby Vercel** : fonctions serverless limitées (durée, instances) —
   très largement suffisant pour un usage perso, à upgrader pour un vrai service.
10. **Fichiers de 1 Go impossibles avec Airtable** : l'API d'Airtable plafonne chaque
    pièce jointe à 5 Mo, et Vercel limite le corps de requête à ~4,5 Mo. Les limites
    demandées « 1 Go par fichier » et « 23 Go par utilisateur » ne peuvent donc être
    que des conventions affichées, pas des capacités réelles. Pour du vrai gros stockage
    il faudrait un stockage objet (Cloudflare R2, Vercel Blob, AWS S3) à la place des
    pièces jointes Airtable — c'est une refonte de la couche d'upload.
