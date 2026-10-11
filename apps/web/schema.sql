-- Investor CRM — D1 schema.
--
-- Every row that could belong to a company carries a company_id, and every
-- query in store.js filters on it. That scoping is the tenant boundary: one
-- deploy can serve several founders, and there is no second line of defence if
-- a query forgets it. The composite indexes exist so that filtering stays cheap
-- as tenants and investors accumulate.
--
-- Apply:  npx wrangler d1 execute fundraise-crm-db --remote --file=schema.sql
--
-- Re-running this file is safe — every statement is IF NOT EXISTS. But note
-- that CREATE TABLE IF NOT EXISTS does NOT add columns to a table that already
-- exists, so an instance created before a column was introduced needs the
-- matching ALTER. The ones added since the first release:
--
--   ALTER TABLE companies ADD COLUMN score_status  TEXT    NOT NULL DEFAULT 'idle';
--   ALTER TABLE companies ADD COLUMN score_error   TEXT    NOT NULL DEFAULT '';
--   ALTER TABLE companies ADD COLUMN score_done    INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE companies ADD COLUMN score_started INTEGER NOT NULL DEFAULT 0;
--
-- Run them with:
--   npx wrangler d1 execute fundraise-crm-db --remote --command "<statement>"

-- A tenant. One founder (or founding team) raising one round.
CREATE TABLE IF NOT EXISTS companies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  -- Deck analysis lands here as JSON: one_liner, stage, raising, traction,
  -- categories, keywords, ideal_investor. Written by Claude, editable by hand.
  profile     TEXT NOT NULL DEFAULT '{}',
  -- Categories the founder confirmed during onboarding. Drives discovery.
  categories  TEXT NOT NULL DEFAULT '[]',
  deck_name   TEXT NOT NULL DEFAULT '',
  deck_pages  INTEGER NOT NULL DEFAULT 0,
  -- empty | analyzing | ready | failed — gates the onboarding UI.
  deck_status TEXT NOT NULL DEFAULT 'empty',
  deck_error  TEXT NOT NULL DEFAULT '',
  -- The company's own site, if they gave one. Pre-product founders often have a
  -- URL and no deck, and a live site is frequently more current than a deck, so
  -- either one alone is enough to produce a profile. Kept so it round-trips into
  -- re-analysis and the founder can see what we read.
  site_url    TEXT NOT NULL DEFAULT '',
  -- idle | searching | ready | failed. Discovery runs 5-15 minutes (web search
  -- over 12-20 firms), far too long to hold an HTTP response open, so it runs in
  -- ctx.waitUntil exactly like deck analysis and the client polls this instead.
  discover_status TEXT NOT NULL DEFAULT 'idle',
  discover_error  TEXT NOT NULL DEFAULT '',
  -- How many firms the last completed run returned, so the UI can report the
  -- result to a founder who closed the tab and came back.
  discover_found  INTEGER NOT NULL DEFAULT 0,
  -- When the running search started. A background job killed mid-flight never
  -- writes 'failed', so store.js treats a 'searching' row older than the
  -- staleness cutoff as failed rather than letting it wedge forever.
  discover_started INTEGER NOT NULL DEFAULT 0,
  -- idle | scoring | ready | failed, plus progress. Scoring the seed list runs
  -- several batched model calls over hundreds of firms, so it is a background
  -- job with a polled status for exactly the same reasons discovery is.
  score_status  TEXT    NOT NULL DEFAULT 'idle',
  score_error   TEXT    NOT NULL DEFAULT '',
  score_done    INTEGER NOT NULL DEFAULT 0,
  score_started INTEGER NOT NULL DEFAULT 0,
  created     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0
);

-- Per-user accounts. pw_hash = SHA-256 over (salt + ":" + password), hex.
-- company_id is the tenant binding; two users on the same company_id share a
-- pipeline (the co-founder case), which is why it isn't just a user-level scope.
CREATE TABLE IF NOT EXISTS users (
  username   TEXT PRIMARY KEY,
  display    TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'founder',  -- founder | admin
  salt       TEXT NOT NULL,
  pw_hash    TEXT NOT NULL,
  created    INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS users_company ON users (company_id);

CREATE TABLE IF NOT EXISTS deals (
  id         TEXT NOT NULL,
  company_id TEXT NOT NULL,
  stage      TEXT NOT NULL DEFAULT 'submitted',
  notes      TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}',
  ts         INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE IF NOT EXISTS log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL DEFAULT '',
  id         TEXT NOT NULL DEFAULT '',
  firm       TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ts         INTEGER NOT NULL DEFAULT 0,
  actor      TEXT NOT NULL DEFAULT ''
);
-- Dedupe key now includes company_id: two tenants can legitimately log the same
-- (id, type, ts) triple, and without the tenant column the second one is silently
-- dropped by INSERT OR IGNORE.
CREATE UNIQUE INDEX IF NOT EXISTS log_dedupe ON log (company_id, id, type, ts);
CREATE INDEX IF NOT EXISTS log_company_ts ON log (company_id, ts DESC);

CREATE TABLE IF NOT EXISTS trash (
  id         TEXT NOT NULL,
  company_id TEXT NOT NULL,
  ts         INTEGER NOT NULL DEFAULT 0,
  actor      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (company_id, id)
);

-- Investors belonging to a company: hand-added, or discovered by the research
-- pass. `source` distinguishes them so a founder can tell what they curated from
-- what the model found, and so a re-run can replace discovered rows only.
CREATE TABLE IF NOT EXISTS investors (
  id         TEXT NOT NULL,
  company_id TEXT NOT NULL,
  data       TEXT NOT NULL,
  -- seed      = loaded from data/investors.seed.json by seed-investors.js
  -- discovered = found by the research pass
  -- manual    = typed in by hand
  -- Kept distinct so a founder can tell curated rows from generated ones, and
  -- so a re-run can replace only what it wrote.
  source     TEXT NOT NULL DEFAULT 'manual',  -- seed | discovered | manual
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS investors_company_source ON investors (company_id, source);

-- Per-user, per-day API call counters. This is the ceiling that makes it safe to
-- run every tenant's Claude calls on one owner's API key: without it, one founder
-- looping deck re-analysis bills the key owner without limit.
CREATE TABLE IF NOT EXISTS usage (
  username TEXT NOT NULL,
  day      TEXT NOT NULL,   -- UTC yyyy-mm-dd
  kind     TEXT NOT NULL,   -- deck | discover | intro | critique | score
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, day, kind)
);

-- Deploy-level configuration: which model to call and, optionally, the API key
-- to call it with. One row, id 'default' — this is not per-company state.
--
-- Storing a key here is a deliberate convenience: it lets the owner rotate
-- credentials from the browser instead of redeploying. It is NOT the more
-- secure option. A Cloudflare Worker secret (ANTHROPIC_API_KEY) never sits in a
-- queryable table and never appears in a database export; this row does both.
-- Anyone who can read this database can read the key, so on a deploy with more
-- than one account, or one whose D1 backups leave your control, prefer the
-- secret. worker.js reads whichever is present, secret first, and never
-- serializes either into a response.
CREATE TABLE IF NOT EXISTS settings (
  id      TEXT PRIMARY KEY,          -- always 'default'
  data    TEXT NOT NULL DEFAULT '{}',
  updated INTEGER NOT NULL DEFAULT 0
);

-- ---- email ----
--
-- The Worker never speaks SMTP. It queues messages here, and apps/mailer (run
-- by GitHub Actions on a schedule, or by cron anywhere) drains the queue
-- through the founder's own mailbox. Sending from your own address is the
-- point: replies land in your inbox and thread like any other email.

-- Files that ride along on email, almost always the deck. Bytes live in D1 as
-- base64 slices (file_chunks) so the app needs no R2 bucket. Each slice is cut
-- on a multiple of three raw bytes, so the base64 of consecutive slices
-- concatenates into the base64 of the whole file and the mailer can stream it.
CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
  size         INTEGER NOT NULL DEFAULT 0,
  chunks       INTEGER NOT NULL DEFAULT 0,
  -- Attached to every new email unless the founder unticks it. Set on the deck
  -- uploaded during onboarding.
  attach_by_default INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS files_company ON files (company_id, id);

CREATE TABLE IF NOT EXISTS file_chunks (
  file_id INTEGER NOT NULL,
  seq     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (file_id, seq)
);

CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  TEXT NOT NULL,
  investor_id TEXT NOT NULL DEFAULT '',
  to_email    TEXT NOT NULL,
  to_name     TEXT NOT NULL DEFAULT '',
  cc          TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- [{id, name, size, mime}], copied at queue time so a sent message keeps
  -- saying what it carried after the file is deleted.
  attachments TEXT NOT NULL DEFAULT '[]',
  -- Epoch ms before which the mailer leaves the row alone. 0 = next run.
  send_after  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL DEFAULT '',
  sent_at     INTEGER NOT NULL DEFAULT 0,
  failed_at   INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (company_id, sent_at, failed_at, send_after);

-- One mailer credential per company. Only the SHA-256 of the token is kept;
-- the token itself is shown once, when it is generated in the app.
CREATE TABLE IF NOT EXISTS mailers (
  company_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL DEFAULT 0
);
