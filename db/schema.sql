-- ═══════════════════════════════════════════════════════════════
-- GiveCloud — schéma de base de données (Cloudflare D1 / SQLite)
-- ═══════════════════════════════════════════════════════════════
-- À appliquer une seule fois sur la base D1 :
--   npx wrangler d1 execute givecloud --remote --file=./db/schema.sql
--   (ou via le tableau de bord Cloudflare → D1 → Console → coller le SQL)
--
-- Les identifiants sont des chaînes "rec" + hexadécimal (compatibles avec
-- le format utilisé côté application). Les horodatages sont en ISO-8601 (UTC).
-- ═══════════════════════════════════════════════════════════════

-- Comptes utilisateurs -------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,          -- stocké en minuscules
  password_hash TEXT NOT NULL,                 -- PBKDF2-SHA256 (base64)
  salt          TEXT NOT NULL,                 -- sel unique (base64)
  iterations    INTEGER NOT NULL,              -- itérations PBKDF2
  quota_mo      INTEGER NOT NULL DEFAULT 20480,-- quota en Mo (20 Go)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Fichiers et dossiers -------------------------------------------------
-- Un dossier est une ligne dont "type" = 'application/x-givecloud-dossier'
-- et dont r2_key est NULL. Les vrais fichiers ont r2_key = clé de l'objet R2.
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,                   -- proprietaire (users.id)
  nom         TEXT NOT NULL,
  chemin      TEXT NOT NULL DEFAULT '/',       -- dossier parent
  taille      INTEGER NOT NULL DEFAULT 0,      -- octets
  type        TEXT NOT NULL,                   -- type MIME
  r2_key      TEXT,                            -- clé R2 (NULL pour un dossier)
  supprime_le TEXT,                            -- NULL = actif ; sinon corbeille
  cree_le     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_owner        ON files (owner_id);
CREATE INDEX IF NOT EXISTS idx_files_owner_chemin ON files (owner_id, chemin);
CREATE INDEX IF NOT EXISTS idx_files_owner_key    ON files (owner_id, r2_key);

-- Liens de partage -----------------------------------------------------
CREATE TABLE IF NOT EXISTS shares (
  id        TEXT PRIMARY KEY,
  token     TEXT NOT NULL UNIQUE,              -- 48 caractères hex
  file_id   TEXT NOT NULL,                     -- fichier partagé (files.id)
  expire_le TEXT,                              -- NULL = sans expiration
  revoque   INTEGER NOT NULL DEFAULT 0,        -- 0/1
  cree_le   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares (token);
CREATE INDEX IF NOT EXISTS idx_shares_file  ON shares (file_id);
