# GiveCloud

Un cloud de stockage multi-utilisateurs. Front 100 % statique (HTML/CSS/JS vanilla),
API sécurisée en **fonction serverless Vercel**, métadonnées en **Cloudflare D1** (base
SQL), fichiers en **Cloudflare R2** (stockage objet S3, egress gratuit). Couleur
principale : le bleu électrique `#0000f2`.

```
                    ┌──► Vercel (front statique + API serverless : auth, métadonnées)
Navigateur ─────────┤
                    └──► Cloudflare R2 (upload / téléchargement DIRECT, URL signées)

Vercel (API) ───► Cloudflare D1 (SQL : users, files, shares)
```

**Pourquoi cette architecture ?**
1. Les identifiants R2/D1 ont un accès complet aux données : ils vivent uniquement dans
   les variables d'environnement Vercel, jamais dans le front (code source, onglet Réseau).
2. Le hachage de mot de passe (PBKDF2-SHA256, 210 000 itérations), le rate limiting et la
   validation serveur exigent du CPU. L'API reste donc sur **Vercel** (Node) : les
   Cloudflare Workers gratuits plafonnent à **10 ms de CPU** par requête, ce qui casserait
   l'authentification.
3. Les octets des fichiers ne transitent **jamais** par Vercel : le serveur signe une URL,
   le navigateur envoie/lit directement sur R2. Pas de limite de taille serverless, pas de
   bande passante consommée.

---

## Arborescence

```
GiveCloud/
├── .gitignore                 # exclut tous les secrets
├── README.md                  # ce guide
├── vercel.json                # config Vercel (statique frontend/ + fonction api/ + en-têtes)
├── db/
│   └── schema.sql             # schéma D1 (tables users, files, shares + index)
├── api/
│   └── index.js               # fonction serverless : adapte req/res → lib/app.js
├── lib/
│   ├── app.js                 # TOUTE l'API : auth, fichiers, dossiers, corbeille, partages
│   ├── db.js                  # client D1 (API REST) + ORM + requêtes métier
│   └── r2.js                  # signature SigV4 R2 (URLs pré-signées, sans npm)
├── frontend/                  # front statique servi par Vercel
│   ├── index.html             # page vitrine
│   ├── login.html             # connexion / inscription
│   ├── app.html               # le cloud (sidebar bleue, fichiers, quota)
│   ├── css/
│   │   └── style.css          # design system bleu, mode sombre, responsive
│   └── js/
│       ├── config.js          # URL de l'API (vide = même origine)
│       ├── theme.js           # apparence (clair/sombre, accent, arrondis, fond) + toasts
│       ├── lecteur.js         # lecteur média type VLC (vidéo/audio, sous-titres, ffmpeg.wasm)
│       ├── landing.js         # animations vitrine, onglets, thème
│       ├── auth.js            # page login
│       └── app.js             # logique du cloud (upload direct R2, liste, dossiers, visionneuse…)
└── worker/                    # ANCIENNE version Cloudflare Workers (Airtable) — obsolète, conservée pour référence
    ├── wrangler.toml
    └── src/index.js
```

> **Hébergement** : déploiement **GitHub (code) + Vercel (site + API) + Cloudflare (D1 + R2)**.
> Le dossier `worker/` est l'ancienne implémentation (Airtable) — plus synchronisée, à ignorer.

---

## Chiffres Cloudflare / Vercel à connaître (plans gratuits, oct. 2026)

| Service | Limite | Conséquence dans GiveCloud |
|---|---|---|
| **R2** — stockage | **10 Go** gratuits puis 0,015 $/Go/mois | Les fichiers vivent ici. Au-delà de 10 Go, facturation à l'usage réel. |
| **R2** — egress | **0 $** (gratuit, toujours) | Téléchargement/streaming illimité en coût — c'est l'avantage clé vs Drive/S3. |
| **R2** — opérations | **1 M Class A** (écritures) + **10 M Class B** (lectures)/mois | Très large pour un usage perso/associatif. |
| **D1** — stockage | **5 Go** | Les métadonnées (noms, chemins, tailles) sont minuscules : jamais un problème. |
| **D1** — débit | **5 M lignes lues/jour**, **100 k lignes écrites/jour** | Suffisant pour des milliers d'utilisateurs. |
| **Vercel** — fonctions | Hobby : durée limitée, corps de requête ~4,5 Mo | **Aucun octet de fichier n'y passe** (upload direct R2) ⇒ la limite ne s'applique pas. |
| **Cloudflare Workers** | **10 ms CPU** (gratuit) | L'API n'y tourne **pas** (PBKDF2 trop coûteux) — Vercel uniquement. |

> **Quota par utilisateur** : `20480 Mo` (20 Go) par défaut, **fichier max 1 Go**.
> Ce sont des conventions appliquées par le serveur (compteur en base D1) ; le stockage
> physique réel est celui de R2, partagé par tous les comptes.

---

# GUIDE PAS À PAS — ce que TU dois faire à la main

## Étape 1 — R2 : le bucket de stockage + CORS

1. Crée un compte sur <https://dash.cloudflare.com/sign-up> (gratuit).
2. Menu **R2** → **Create bucket**. Nom : `givecloud`. Région : *Automatic*.
   - ⚠️ L'activation de R2 demande en général d'ajouter une **carte bancaire**.
     Le plan gratuit couvre 10 Go : tant que tu restes dessous, **rien n'est débité**.
3. Note ton **Account ID** : barre latérale → **R2** → *Account details* (ou dans l'URL du dashboard).
4. **CORS** (indispensable : upload/lecture directe depuis le navigateur) : bucket
   `givecloud` → onglet **Settings** → *CORS Policy* → **Add CORS policy** → colle :

   ```json
   [
     {
       "AllowedOrigins": ["https://ton-projet.vercel.app"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["Content-Type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Remplace `ton-projet.vercel.app` par ton domaine final (tu peux aussi mettre `"*"`
   pendant les tests, mais **restreins-le ensuite**).

5. **Clé d'accès S3** (pour signer les URLs) : **R2** → **Manage R2 API Tokens** →
   **Create API token** → nom `givecloud-api` → permissions **Object Read & Write** →
   (optionnel) limite au bucket `givecloud` → **Create**.
   **Copie immédiatement** : *Access Key ID* et *Secret Access Key* (affichés une seule fois).

## Étape 2 — D1 : la base de données

1. Menu **Workers & Pages** → onglet **D1** → **Create database**. Nom : `givecloud`.
2. **Applique le schéma** (crée les tables). Deux options :

   **A. Tableau de bord** : ouvre la base → onglet **Console** → colle le contenu de
   `db/schema.sql` puis exécute.

   **B. Ligne de commande** (recommandé) :
   ```powershell
   npx wrangler d1 execute givecloud --remote --file=./db/schema.sql
   ```

3. Note le **Database ID** : base `givecloud` → visible dans *Settings* (UUID du type
   `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

## Étape 3 — Token API Cloudflare (accès D1 depuis Vercel)

L'API Vercel lit/écrit D1 via l'API REST Cloudflare ; il faut un token dédié.

1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Custom token**.
2. **Permissions** → ajoute : **Account** → **D1** → **Edit**.
3. **Account resources** → **Include** → **ton compte**.
4. **Create Token** → copie la valeur (affichée une seule fois).

## Étape 4 — Node.js, GitHub

1. Installe **Node.js LTS** (≥ 20) : <https://nodejs.org> → version LTS. Vérifie :
   ```powershell
   node -v    # v20.x, v22.x ou v24.x
   npm -v
   ```
2. Installe **Git** : <https://git-scm.com/download/win> (options par défaut).
3. Sur GitHub : **+ → New repository** → nom `givecloud` → **Private** → **Create**.
4. Depuis la racine du projet :
   ```powershell
   git remote add origin https://github.com/<ton-pseudo>/givecloud.git
   git branch -M main
   git push -u origin main
   ```
   **Si le push échoue** : crée un **Personal Access Token** GitHub (Settings → Developer
   settings → Tokens) ou utilise **GitHub Desktop**.

## Étape 5 — Vercel : import + variables d'environnement

1. Compte sur <https://vercel.com> → **Continue with GitHub** (autorise le repo `givecloud`).
2. **Add New… → Project** → importe `givecloud`.
3. **Ne change rien** : Framework Preset **Other**, Build Command *(vide)*,
   Output Directory `frontend` (déjà lu dans `vercel.json`).
4. **AVANT de cliquer Deploy** → *Environment Variables* :

   | Nom | Valeur | Où la trouver |
   |---|---|---|
   | `CLOUDFLARE_ACCOUNT_ID` | ton Account ID | étape 1.3 |
   | `CLOUDFLARE_API_TOKEN` | token D1 Edit | étape 3 |
   | `D1_DATABASE_ID` | UUID de la base | étape 2.3 |
   | `R2_BUCKET` | `givecloud` | étape 1.2 |
   | `R2_ACCESS_KEY_ID` | Access Key ID | étape 1.5 |
   | `R2_SECRET_ACCESS_KEY` | Secret Access Key | étape 1.5 |
   | `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | à générer |

   *(Optionnelles : `R2_ACCOUNT_ID` si ton compte R2 diffère du compte Cloudflare,
   `QUOTA_MO_DEFAULT` — quota par défaut en Mo.)*

5. **Deploy**. **Si tout va bien** : ~30 s plus tard, ouvre
   `https://ton-projet.vercel.app/api/health` → `{"ok":true,"service":"givecloud-api",...}`.
   **Si « Configuration serveur incomplète »** : une variable manque → vérifie les noms
   (majuscules), ajoute-la, puis **Redeploy**.

## Étape 6 — Mise à jour automatique

Chaque `git push` sur `main` redéploie le site **et** l'API. Front et API sont sur la
**même origine** (`*.vercel.app`) → cookies `SameSite=Strict` OK, pas de CORS.
**Si le front charge mais la page est vide** : F12 → *Console* → vérifie que
`frontend/js/config.js` contient bien `API_BASE: ''`.

**Domaine custom (optionnel)** : Vercel → Settings → Domains → ajoute ton domaine ;
pense à **mettre à jour le CORS R2** avec ce nouveau domaine.

## Étape 7 — Tests de sécurité à faire TOI-MÊME

Ouvre les DevTools (F12) pendant tous les tests.

1. **Anti-IDOR** : crée 2 comptes (A et B). En A, upload un fichier, note son ID
   (`GET /api/files`). En B, ouvre `fetch('/api/files/<ID_A>/download')` dans la console
   → **404/403**, jamais le fichier. Idem avec un lien de partage révoqué/supprimé.
2. **Secrets absents du front** : onglets *Sources* + *Réseau* → aucun `r2.cloudflarestorage.com`
   en tant qu'appel authentifié côté serveur, aucune clé, aucun token. Les URLs R2 visibles
   sont **pré-signées et éphémères** (c'est normal et attendu).
3. **Cookie HttpOnly** : *Application* → *Cookies* → `gc_session` doit être **HttpOnly** ✓,
   **Secure** ✓, **SameSite=Strict**. `document.cookie` dans la console → chaîne vide.
4. **Brute-force** : rate-limit 5 essais / 10 min sur login/register — échoue 6 fois →
   `429 Trop de tentatives.` (message générique).
5. **Upload dangereux** : `.exe`, `.bat`, `.ps1`, `.dll` → 415 bloqué côté front **et**
   serveur. Le **code** (`.js`, `.py`, `.html`…) est autorisé : jamais exécuté
   (téléchargement en `attachment`, aperçu sous CSP `sandbox`).
6. **Taille** : un fichier > 1 Go → refusé. Vérifie aussi la validation serveur via `curl`.
7. **Quota** : remplis jusqu'au quota ou modifie-le en base → l'API refuse (413/507).
8. **XSS** : renomme un fichier `<img src=x onerror=alert(1)>` → affiché en texte brut.
9. **HSTS / en-têtes** : `curl -I https://ton-projet.vercel.app/` →
   `strict-transport-security`, `x-content-type-options: nosniff`, `referrer-policy`.
10. **Corbeille** : supprime → corbeille (`supprimeLe`), restaure ; « Supprimer
    définitivement » supprime aussi l'**objet R2** (plus seulement la ligne D1).
11. **Partage** : lien 1 h en navigation privée → marche ; « Révoquer » → lien mort ;
    lien « **Jamais** » → ne doit jamais expirer.
12. **Profil** : change d'e-mail (session re-signée) ; change de mot de passe
    (ancien refusé, nouveau accepté, sel + hash neufs).
13. **Éditeur** : modifie un `.js`/`.txt`, « Enregistrer » → recharge (contenu + taille à jour).

---

# Checklist de sécurité

- [x] Secrets R2/D1/token uniquement en variables d'environnement Vercel, jamais dans le front ni Git
- [x] `.gitignore` couvre `.env`, `.dev.vars`, `.vercel/`, secrets
- [x] Mots de passe hachés PBKDF2-SHA256, 210 000 itérations, sel unique 16 octets
- [x] Changement de mot de passe : ancien vérifié, sel + hash régénérés
- [x] Changement d'e-mail : unicité revérifiée, cookie JWT re-signé
- [x] Comparaison de hashs à temps constant
- [x] Session : JWT signé HMAC-SHA256 en cookie `HttpOnly; Secure; SameSite=Strict` (7 jours)
- [x] Aucun jeton en localStorage ni dans le DOM
- [x] Vérification propriétaire sur CHAQUE route fichier (anti-IDOR)
- [x] Rate limiting login/register : 5 essais / 10 min / IP + messages génériques
- [x] CORS limité à `ALLOWED_ORIGIN` (vide = même origine) ; CORS R2 restreint au domaine du site
- [x] En-têtes : X-Content-Type-Options, Referrer-Policy, HSTS, X-Frame-Options,
      Permissions-Policy sur toutes les pages (via vercel.json) + toutes les réponses API
- [x] Validation serveur : taille ≤ 1 Go par fichier, extension bloquée (exécutables natifs)
- [x] Requêtes D1 **préparées** (liaison de paramètres) — aucune concaténation SQL
- [x] URLs R2 **pré-signées** à durée courte (upload 1 h, download 5 min), jamais stockées
- [x] Téléchargement forcé en `Content-Disposition: attachment` (via R2 `response-content-disposition`)
- [x] Aperçu / visionneuse / éditeur servis en `inline` sous CSP `sandbox`
      + `X-Content-Type-Options: nosniff` (aucune exécution possible)
- [x] Retry automatique sur 429/5xx D1 (back-off, 3 essais)
- [x] Purge de la corbeille après 30 jours ; suppression définitive (ligne D1 **et** objet R2)
- [x] Rate limiting dédié sur le changement de mot de passe (5 essais / 10 min / IP)
- [x] Front : `textContent` uniquement pour les données utilisateur (anti-XSS)
- [x] Lecteur média : médias `inline` sous CSP `sandbox` ; conversion via ffmpeg.wasm (CDN)
- [x] CSP stricte en `<meta>` sur les pages HTML (`media-src 'self' blob:` pour le lecteur)

# Limites honnêtes de la solution

1. **Stockage réel partagé** : le quota « 20 Go/utilisateur » est une convention interne
   (compteur en D1). Le stockage physique est celui du bucket R2, partagé par tous les
   comptes. 50 comptes × 15 Go = 750 Go : **impossible à 0 €** (R2 gratuit = 10 Go).
   « Quota par utilisateur » ≠ « coût » : R2 facture les Go réellement stockés.
2. **R2 exige une carte bancaire à l'activation** (jamais débitée sous 10 Go) ; au-delà,
   facturation à l'usage (0,015 $/Go/mois, egress gratuit).
3. **Rate limiting en mémoire** : les compteurs vivent dans l'instance Vercel et repartent
   à zéro au cold start. Un attaquant patient peut contourner. Solution pro : Upstash Redis / Vercel KV.
4. **JWT sans révocation** : un jeton volé reste valide jusqu'à 7 jours (sauf rotation de
   `SESSION_SECRET`). Solution pro : liste de révocation en base.
5. **D1 = base SQL distante** : chaque page de liste fait 1 requête REST D1 (latence
   ~50-150 ms). Très correct, mais pas gratuit-infini : 100 k écritures/jour en gratuit.
6. **Upload direct mais signé** : le serveur doit être joignable pour obtenir l'URL
   pré-signée (`POST /api/files/upload`) **avant** l'envoi vers R2, puis pour clôturer
   (`POST /api/files/finalize`). Si la clôture échoue, l'objet R2 orphelin n'apparaît pas
   dans la liste.
7. **Pas de zéro-knowledge** : les fichiers sont chez Cloudflare, protégés par leur sécurité
   (TLS en transit, chiffrement au repos). GiveCloud ne peut pas promettre le chiffrement
   de bout en bout.
8. **Suppression = corbeille logique puis purge** : la ligne D1 reçoit `supprimeLe` pendant
   30 jours ; l'objet R2 est supprimé lors de la purge (ou immédiatement sur « définitive »
   / « vider la corbeille »).
9. **Plan Vercel Hobby** : fonctions limitées (durée, instances) — largement suffisant pour
   un usage perso, à upgrader pour un vrai service. **Aucun fichier ne traverse Vercel**.
10. **Lecteur de codecs exotiques (AC3, DTS, HEVC, MKV…)** : lecture native d'abord, sinon
    conversion à la volée via **ffmpeg.wasm** (CDN, ~30 Mo la 1ʳᵉ fois, mis en cache).
    Lent et gourmand en mémoire, surtout avec de gros fichiers — ce n'est pas VLC.
