// Every database call in the app lives here.
//
// The rest of the app never names a table, writes SQL, or touches `env.DB`.
// Moving to Postgres, libSQL, or a test double means reimplementing this one
// module against the same function signatures.
//
// Two rules hold throughout:
//   1. Every query is scoped by company_id. That scoping IS the tenant
//      boundary — a query that forgets it leaks one founder's pipeline into
//      another's. There is no second line of defence, so it is never optional.
//   2. Nothing here parses model output or applies business rules. Callers hand
//      down finished values; this module reads and writes them.

// DB columns hold strict JSON we wrote ourselves, so a plain parse with a
// fallback is right here. Model output needs the far more forgiving parser in
// ai.js, deliberately not shared, because tolerating fenced or truncated
// JSON from our own database would hide corruption instead of surfacing it.
function col(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

// ---- users ----

export function findUser(env, username) {
  return env.DB.prepare(
    "SELECT username, display, company_id, role, salt, pw_hash FROM users WHERE username = ?",
  )
    .bind(
      String(username || "")
        .trim()
        .toLowerCase(),
    )
    .first();
}

export function touchLastSeen(env, username) {
  return env.DB.prepare("UPDATE users SET last_seen = ?1 WHERE username = ?2")
    .bind(Date.now(), username)
    .run();
}

// A company and its first user are one unit: a user row with no company is a
// tenant-less account that every scoped query would silently return nothing for.
// Batched so a failure leaves neither.
export function createAccount(env, { companyId, companyName, username, display, salt, pwHash }) {
  const now = Date.now();
  return env.DB.batch([
    env.DB.prepare(
      "INSERT INTO companies (id, name, profile, categories, deck_status, created, updated) VALUES (?1, ?2, '{}', '[]', 'empty', ?3, ?3)",
    ).bind(companyId, companyName, now),
    env.DB.prepare(
      `INSERT INTO users (username, display, company_id, role, salt, pw_hash, created, last_seen)
       VALUES (?1, ?2, ?3, 'founder', ?4, ?5, ?6, 0)`,
    ).bind(username, display, companyId, salt, pwHash, now),
  ]);
}

// ---- usage metering ----

// Increment first, return the new count, let the caller compare against its
// limit. Read-then-write would let two concurrent requests both see "4 of 5
// used" and both proceed.
export async function bumpUsage(env, username, day, kind) {
  const row = await env.DB.prepare(
    `INSERT INTO usage (username, day, kind, count) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT(username, day, kind) DO UPDATE SET count = usage.count + 1
     RETURNING count`,
  )
    .bind(username, day, kind)
    .first();
  return row?.count ?? 0;
}

export async function usageToday(env, username, day) {
  const { results } = await env.DB.prepare("SELECT kind, count FROM usage WHERE username = ?1 AND day = ?2")
    .bind(username, day)
    .all();
  return results;
}

// ---- companies ----

export async function getCompany(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, name, profile, categories, deck_name, deck_pages, deck_status, deck_error, site_url,
            discover_status, discover_error, discover_found, discover_started,
            score_status, score_error, score_done, score_started FROM companies WHERE id = ?`,
  )
    .bind(id)
    .first();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    profile: col(row.profile, {}),
    categories: col(row.categories, []),
    siteUrl: row.site_url || "",
    deck: { name: row.deck_name, pages: row.deck_pages, status: row.deck_status, error: row.deck_error },
    // Defaulted rather than assumed: a deploy that has not run the ALTER yet
    // returns undefined here, and the UI should read that as "never searched"
    // rather than wedging on a missing status.
    discover: discoverState(row),
    score: scoreState(row),
  };
}

// A background search that dies mid-flight — deploy, crash, Worker eviction —
// never gets to write 'failed', so the row would sit on 'searching' forever:
// the UI polls with no end and the concurrent-run guard blocks every retry. The
// staleness cutoff is derived on read rather than repaired by a write, so the
// poll and the guard can never disagree about whether a run is still alive.
const DISCOVER_STALE_MS = 25 * 60 * 1000;

function discoverState(row) {
  const status = row.discover_status || "idle";
  const started = row.discover_started || 0;
  if (status === "searching" && started && Date.now() - started > DISCOVER_STALE_MS) {
    return { status: "failed", error: "The search stopped unexpectedly. Try again.", found: 0, stale: true };
  }
  return {
    status,
    error: row.discover_error || "",
    found: row.discover_found || 0,
    stale: false,
  };
}

// Scoring reuses the discovery lifecycle wholesale — same staleness derivation,
// same reasons. A run that dies without writing 'failed' would otherwise leave
// the row on 'scoring' forever, and the concurrent-run guard would refuse every
// retry while the UI polled a job that no longer exists.
const SCORE_STALE_MS = 25 * 60 * 1000;

function scoreState(row) {
  const status = row.score_status || "idle";
  const started = row.score_started || 0;
  if (status === "scoring" && started && Date.now() - started > SCORE_STALE_MS) {
    return { status: "failed", error: "Scoring stopped unexpectedly. Try again.", done: 0, stale: true };
  }
  return { status, error: row.score_error || "", done: row.score_done || 0, stale: false };
}

// ---- discovery status (mirrors the deck_* lifecycle above) ----

export function markDiscovering(env, companyId) {
  return env.DB.prepare(
    `UPDATE companies SET discover_status = 'searching', discover_error = '',
       discover_started = ?1, updated = ?1 WHERE id = ?2`,
  )
    .bind(Date.now(), companyId)
    .run();
}

export function markDiscovered(env, companyId, found) {
  return env.DB.prepare(
    "UPDATE companies SET discover_status = 'ready', discover_error = '', discover_found = ?1, updated = ?2 WHERE id = ?3",
  )
    .bind(Number(found) || 0, Date.now(), companyId)
    .run();
}

export function markDiscoverFailed(env, companyId, message) {
  return env.DB.prepare(
    "UPDATE companies SET discover_status = 'failed', discover_error = ?1, updated = ?2 WHERE id = ?3",
  )
    .bind(String(message || "").slice(0, 400), Date.now(), companyId)
    .run();
}

// ---- scoring status ----

export function markScoring(env, companyId) {
  return env.DB.prepare(
    `UPDATE companies SET score_status = 'scoring', score_error = '', score_done = 0,
       score_started = ?1, updated = ?1 WHERE id = ?2`,
  )
    .bind(Date.now(), companyId)
    .run();
}

export function markScored(env, companyId, done) {
  return env.DB.prepare(
    "UPDATE companies SET score_status = 'ready', score_error = '', score_done = ?1, updated = ?2 WHERE id = ?3",
  )
    .bind(Number(done) || 0, Date.now(), companyId)
    .run();
}

export function markScoreFailed(env, companyId, message) {
  return env.DB.prepare(
    "UPDATE companies SET score_status = 'failed', score_error = ?1, updated = ?2 WHERE id = ?3",
  )
    .bind(String(message || "").slice(0, 400), Date.now(), companyId)
    .run();
}

// Progress for a run still in flight, so a founder watching a five-minute job
// sees a number move instead of a spinner. Deliberately not a status change:
// the run is still 'scoring' until it finishes or fails.
export function bumpScored(env, companyId, done) {
  return env.DB.prepare("UPDATE companies SET score_done = ?1 WHERE id = ?2")
    .bind(Number(done) || 0, companyId)
    .run();
}

export function markAnalyzing(env, companyId, { deckName = "", siteUrl = "" } = {}) {
  return env.DB.prepare(
    `UPDATE companies SET
       deck_name  = COALESCE(NULLIF(?1, ''), deck_name),
       site_url   = COALESCE(NULLIF(?2, ''), site_url),
       deck_status = 'analyzing', deck_error = '', updated = ?3
     WHERE id = ?4`,
  )
    .bind(deckName, siteUrl, Date.now(), companyId)
    .run();
}

// `categories` is written only when the founder has not confirmed a set yet
// (the column still being '[]' is what "not yet confirmed" means). A re-analysis
// must not silently discard chips they picked by hand.
export function saveProfile(env, companyId, { profile, name, categories }) {
  return env.DB.prepare(
    `UPDATE companies SET profile = ?1, name = COALESCE(NULLIF(?2, ''), name),
       categories = CASE WHEN categories = '[]' THEN ?3 ELSE categories END,
       deck_status = 'ready', deck_error = '', updated = ?4 WHERE id = ?5`,
  )
    .bind(JSON.stringify(profile), name || "", JSON.stringify(categories || []), Date.now(), companyId)
    .run();
}

export function markFailed(env, companyId, message) {
  return env.DB.prepare(
    "UPDATE companies SET deck_status = 'failed', deck_error = ?1, updated = ?2 WHERE id = ?3",
  )
    .bind(String(message || "").slice(0, 400), Date.now(), companyId)
    .run();
}

// Partial hand-edit of a company. Takes a plain object so the caller never
// assembles SQL; unknown keys are ignored rather than interpolated, which is
// what keeps this from becoming an injection point as fields get added.
const COMPANY_FIELDS = { profile: "profile", categories: "categories", name: "name" };

export function updateCompany(env, companyId, fields) {
  const sets = [];
  const binds = [];
  for (const [key, column] of Object.entries(COMPANY_FIELDS)) {
    if (!(key in fields)) continue;
    const v = fields[key];
    sets.push(`${column} = ?${binds.push(typeof v === "string" ? v : JSON.stringify(v))}`);
  }
  if (!sets.length) return null;
  sets.push(`updated = ?${binds.push(Date.now())}`);
  return env.DB.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?${binds.push(companyId)}`)
    .bind(...binds)
    .run();
}

// ---- D1 statement width ----
//
// D1 rejects any single statement carrying more than 100 bound parameters, and a
// rejected statement fails the WHOLE batch. So an over-wide query does not lose
// one row — it silently loses every write in that batch. There is no partial
// success to notice.
//
// Two separate ceilings are in play and both are load-bearing:
//
//   - 100 bound parameters per statement. chunkFor() derives the row count from
//     the parameters per row rather than hardcoding it, so adding a column
//     cannot quietly push a statement over.
//   - Queries per Worker invocation: 1,000 on Workers Paid, 50 on Free. This is
//     why every writer below uses multi-row VALUES instead of one statement per
//     row, and why the columns that repeat within a statement are bound once
//     and referenced by number. Writing 900 investors as 900 statements exceeds
//     the free ceiling eighteen times over and comes within a rounding error of
//     the paid one. As written it is 19 statements.
//
// Source: https://developers.cloudflare.com/d1/platform/limits/
const D1_MAX_PARAMS = 100;

// `reserved` is for parameters the statement needs beyond the rows themselves —
// a leading `WHERE updated_at <= ?`, for instance.
export function chunkFor(rows, paramsPerRow, reserved = 0) {
  const size = Math.max(1, Math.floor((D1_MAX_PARAMS - reserved) / paramsPerRow));
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// ---- investors ----

export async function loadInvestors(env, companyId) {
  const { results } = await env.DB.prepare(
    "SELECT data FROM investors WHERE company_id = ? ORDER BY updated_at DESC",
  )
    .bind(companyId)
    .all();
  return results.map((r) => col(r.data, null)).filter(Boolean);
}

// Multi-row VALUES, chunked to the parameter ceiling, with the four columns that
// are identical for every row in the statement bound ONCE and referenced by
// number.
//
// This is the difference between working on a free Cloudflare plan and not.
// A scoring run rewrites every investor a company holds — 900 for a freshly
// seeded pipeline. At one statement per row that is 900 queries. At six bound
// parameters per row it is 57. Binding company_id, source, updated_by and
// updated_at once leaves two parameters per row, so 48 rows fit in a statement
// and the same write is 19 — inside the free plan's 50-query invocation ceiling
// rather than eighteen times past it.
//
// SQLite numbered parameters may repeat, which is what makes the shared binds
// legal; ?1-?4 below appear once in the bind list and many times in the SQL.
export function saveInvestors(env, companyId, records, source, actor) {
  if (!records.length) return null;
  const now = Date.now();
  const rows = records.map((rec) => [rec.id, JSON.stringify(rec)]);
  const SHARED = 4;
  return env.DB.batch(
    chunkFor(rows, 2, SHARED).map((group) =>
      env.DB.prepare(
        `INSERT INTO investors (id, company_id, data, source, updated_by, updated_at)
         VALUES ${group
           .map((_, i) => `(?${SHARED + i * 2 + 1}, ?1, ?${SHARED + i * 2 + 2}, ?2, ?3, ?4)`)
           .join(",")}
         ON CONFLICT(company_id, id) DO UPDATE SET
           data=excluded.data, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      ).bind(companyId, source, actor, now, ...group.flat()),
    ),
  );
}

export function deleteInvestor(env, companyId, id) {
  return env.DB.prepare("DELETE FROM investors WHERE company_id = ?1 AND id = ?2").bind(companyId, id).run();
}

// ---- CRM state ----

const DEAL_OWN = new Set(["stage", "notes", "ts", "by"]);

// The activity log is append-only and grows for the life of the account, so
// only the most recent window is returned. The client re-sends only entries it has not yet
// stored, so holding a truncated log is safe: it cannot cause the older rows to
// be re-uploaded or dropped.
const LOG_WINDOW = 500;

export async function loadCrm(env, companyId) {
  const [dealRows, logRows, trashRows] = await env.DB.batch([
    env.DB.prepare("SELECT id, stage, notes, data, ts, updated_by FROM deals WHERE company_id = ?").bind(
      companyId,
    ),
    // Newest first for the LIMIT, then reversed below — the UI wants oldest
    // first, but "the 500 oldest" is the wrong 500.
    env.DB.prepare(
      "SELECT id, firm, type, detail, ts, actor FROM log WHERE company_id = ? ORDER BY seq DESC LIMIT ?",
    ).bind(companyId, LOG_WINDOW),
    env.DB.prepare("SELECT id FROM trash WHERE company_id = ?").bind(companyId),
  ]);
  const deals = {};
  for (const r of dealRows.results) {
    deals[r.id] = { ...col(r.data, {}), stage: r.stage, notes: r.notes, ts: r.ts, by: r.updated_by };
  }
  return {
    deals,
    log: logRows.results
      .map((r) => ({ id: r.id, firm: r.firm, type: r.type, detail: r.detail, ts: r.ts, by: r.actor }))
      .reverse(),
    trash: trashRows.results.map((r) => r.id),
  };
}

// Merge, never clobber — each deal is its own row, written only if the incoming
// edit is at least as new as what's stored, so two people editing different
// deals both keep their work.
//
// Deletions are the subtle case: a deal missing from the payload usually means
// "removed", but it also means "someone else added it after I loaded". Only rows
// this client demonstrably knew about (updated_at <= _base) are deleted.
//
// Every statement here is chunked multi-row VALUES, and the set of removed
// deals is worked out in JS from a SELECT rather than with `id NOT IN (...)`.
// D1 rejects a statement with more than 100 bound parameters, and a rejected
// statement fails the whole batch, so no query's width may grow with the
// number of deals.
export async function saveCrm(env, companyId, body, actor) {
  const base = Number(body._base) || 0;
  const now = Date.now();
  const deals = body.deals && typeof body.deals === "object" ? body.deals : {};
  const log = Array.isArray(body.log) ? body.log : [];
  const trash = Array.isArray(body.trash) ? body.trash : [];
  const stmts = [];

  const dealRows = [];
  for (const [id, d] of Object.entries(deals)) {
    if (!d || typeof d !== "object") continue;
    const extra = {};
    for (const [k, v] of Object.entries(d)) if (!DEAL_OWN.has(k)) extra[k] = v;
    dealRows.push([id, d.stage || "submitted", d.notes || "", JSON.stringify(extra), Number(d.ts) || now]);
  }
  // company_id, updated_by and updated_at are the same for every row in the
  // statement, so they are bound once as ?1-?3 and referenced per row. Five
  // parameters per row instead of eight means 19 deals per statement instead of
  // 12 — a 500-deal save is 27 statements rather than 42, which is the
  // difference between fitting inside a free plan's 50-query invocation budget
  // and not.
  const DEAL_SHARED = 3;
  for (const group of chunkFor(dealRows, 5, DEAL_SHARED)) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO deals (id, company_id, stage, notes, data, ts, updated_by, updated_at)
         VALUES ${group
           .map((_, i) => {
             const b = DEAL_SHARED + i * 5;
             return `(?${b + 1}, ?1, ?${b + 2}, ?${b + 3}, ?${b + 4}, ?${b + 5}, ?2, ?3)`;
           })
           .join(",")}
         ON CONFLICT(company_id, id) DO UPDATE SET
           stage=excluded.stage, notes=excluded.notes, data=excluded.data,
           ts=excluded.ts, updated_by=excluded.updated_by, updated_at=excluded.updated_at
         WHERE excluded.ts >= deals.ts`,
      ).bind(companyId, actor, now, ...group.flat()),
    );
  }

  // Deleting by explicit id keeps every statement a fixed, small width no matter
  // how large the pipeline grows. Both reads are tenant-scoped: without the
  // company_id filter this would happily delete another founder's rows.
  const keep = new Set(Object.keys(deals));
  const known = await env.DB.prepare("SELECT id FROM deals WHERE company_id = ?1 AND updated_at <= ?2")
    .bind(companyId, base)
    .all();
  const goneDeals = known.results.map((r) => r.id).filter((id) => !keep.has(id));

  // A SAVE MAY NOT EMPTY THE BOARD.
  //
  // Deletion here is INFERRED FROM ABSENCE, and absence is exactly what a broken
  // read produces. The client refuses to save from a board that never loaded,
  // but that is a guard in code we do not control — a stale tab, a cached
  // bundle, or a second client would all bypass it. This is the half that
  // cannot be bypassed.
  //
  // It is not hypothetical. In the app this was forked from a failed /api/crm
  // read produced a blank board and the next save deleted every deal; it nearly
  // happened a second time when D1's free-tier daily read limit — which is per
  // ACCOUNT, not per database — was exhausted by an unrelated job and every CRM
  // read started failing.
  //
  // A genuine bulk delete passes `confirm_bulk: true` in the POST body. A
  // browser that failed to load cannot.
  const bulkOk = body && body.confirm_bulk === true;
  if (!bulkOk && known.results.length > 0 && keep.size === 0) {
    return {
      refused: true,
      would_delete: known.results.length,
      error:
        `refused: a save with zero deals would delete all ${known.results.length} rows. That is what a ` +
        `failed read looks like, not an edit. Reload and check the board is populated before saving.`,
    };
  }
  if (!bulkOk && known.results.length >= 20 && goneDeals.length > known.results.length / 2) {
    return {
      refused: true,
      would_delete: goneDeals.length,
      error:
        `refused: this save would delete ${goneDeals.length} of ${known.results.length} deals. ` +
        `Pass confirm_bulk if that is genuinely intended.`,
    };
  }

  // The updated_at guard is repeated in the DELETE, not just in the SELECT: a
  // save landing in between must not have its row deleted by this one.
  for (const group of chunkFor(goneDeals, 1, 2)) {
    stmts.push(
      env.DB.prepare(
        `DELETE FROM deals WHERE company_id = ? AND updated_at <= ? AND id IN (${group
          .map(() => "?")
          .join(",")})`,
      ).bind(companyId, base, ...group),
    );
  }

  const logRows = log
    .filter((e) => e && typeof e === "object")
    .map((e) => [
      companyId,
      e.id || "",
      e.firm || "",
      e.type || "",
      e.detail || "",
      Number(e.ts) || now,
      e.by || actor,
    ]);
  for (const group of chunkFor(logRows, 7)) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO log (company_id, id, firm, type, detail, ts, actor)
         VALUES ${group.map(() => "(?,?,?,?,?,?,?)").join(",")}`,
      ).bind(...group.flat()),
    );
  }

  const trashRows = trash.map((id) => [id, companyId, now, actor]);
  for (const group of chunkFor(trashRows, 4)) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO trash (id, company_id, ts, actor) VALUES ${group
          .map(() => "(?,?,?,?)")
          .join(",")}`,
      ).bind(...group.flat()),
    );
  }
  const keptTrash = new Set(trash);
  const knownTrash = await env.DB.prepare("SELECT id FROM trash WHERE company_id = ?1 AND ts <= ?2")
    .bind(companyId, base)
    .all();
  const goneTrash = knownTrash.results.map((r) => r.id).filter((id) => !keptTrash.has(id));
  for (const group of chunkFor(goneTrash, 1, 2)) {
    stmts.push(
      env.DB.prepare(
        `DELETE FROM trash WHERE company_id = ? AND ts <= ? AND id IN (${group.map(() => "?").join(",")})`,
      ).bind(companyId, base, ...group),
    );
  }

  await env.DB.batch(stmts);
  return { ok: true };
}

// ---- instance settings ----
//
// One row, id 'default': this is deploy-level configuration (which model, whose
// key), not per-company state. It is a table rather than a Worker secret so the
// owner can rotate a key from the browser without a redeploy — and it is read
// server-side only. Nothing here is ever returned to a client unmasked; see
// /api/settings in index.js, which is the only reader that faces outward.

export async function getSettings(env) {
  const row = await env.DB.prepare("SELECT data FROM settings WHERE id = 'default'").first();
  return row ? col(row.data, {}) : {};
}

// Merge, not replace: saving a model choice must not silently drop the stored
// key, and the Settings form does not send the key back (it never receives it).
export async function saveSettings(env, patch) {
  const merged = { ...(await getSettings(env)), ...patch };
  for (const k of Object.keys(merged)) {
    if (merged[k] === null || merged[k] === "") delete merged[k];
  }
  await env.DB.prepare(
    `INSERT INTO settings (id, data, updated) VALUES ('default', ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
  )
    .bind(JSON.stringify(merged), Date.now())
    .run();
  return merged;
}

// ---- email: files ----

export async function listFiles(env, companyId) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, mime, size, attach_by_default, created_at FROM files
     WHERE company_id = ?1 ORDER BY id DESC`,
  )
    .bind(companyId)
    .all();
  return results.map((f) => ({ ...f, attach_by_default: !!f.attach_by_default }));
}

// One batch, so a file either lands whole or not at all. The caller keeps the
// slice count under the Free plan's 50-queries-per-request ceiling.
export async function saveFile(env, companyId, { name, mime, size, slices, byDefault }, actor) {
  const row = await env.DB.prepare(
    `INSERT INTO files (company_id, name, mime, size, chunks, attach_by_default, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7) RETURNING id`,
  )
    .bind(companyId, name, mime, size, slices.length, Date.now(), actor)
    .first();
  const stmts = slices.map((data, seq) =>
    env.DB.prepare("INSERT INTO file_chunks (file_id, seq, data) VALUES (?1, ?2, ?3)").bind(
      row.id,
      seq,
      data,
    ),
  );
  // A new default replaces the old one: uploading a new deck should not mean
  // investors get both versions.
  if (byDefault) {
    stmts.push(
      env.DB.prepare("UPDATE files SET attach_by_default = (id = ?2) WHERE company_id = ?1").bind(
        companyId,
        row.id,
      ),
    );
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    await env.DB.prepare("DELETE FROM files WHERE id = ?1").bind(row.id).run();
    throw e;
  }
  return row.id;
}

export function setFileDefault(env, companyId, id, on) {
  return env.DB.prepare("UPDATE files SET attach_by_default = ?3 WHERE company_id = ?1 AND id = ?2")
    .bind(companyId, Number(id), on ? 1 : 0)
    .run();
}

export async function deleteFile(env, companyId, id) {
  const owned = await env.DB.prepare("SELECT id FROM files WHERE company_id = ?1 AND id = ?2")
    .bind(companyId, Number(id))
    .first();
  if (!owned) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM file_chunks WHERE file_id = ?1").bind(owned.id),
    env.DB.prepare("DELETE FROM files WHERE id = ?1").bind(owned.id),
  ]);
}

// The file must belong to the company asking: the mailer's token is scoped to
// one company, and a guessed integer id must not reach another tenant's deck.
export function getFileChunk(env, companyId, id, seq) {
  return env.DB.prepare(
    `SELECT f.chunks, c.data FROM files f JOIN file_chunks c ON c.file_id = f.id
     WHERE f.company_id = ?1 AND f.id = ?2 AND c.seq = ?3`,
  )
    .bind(companyId, Number(id), Number(seq))
    .first();
}

export async function filesById(env, companyId, ids) {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, name, mime, size FROM files WHERE company_id = ?1
     AND id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(companyId, JSON.stringify(ids.map(Number)))
    .all();
  return results;
}

// ---- email: outbox ----

const OUTBOX_COLUMNS = `id, investor_id, to_email, to_name, cc, subject, body, attachments,
  send_after, created_at, created_by, sent_at, failed_at, error`;

const outboxRow = (r) => ({ ...r, attachments: col(r.attachments, []) });

export async function listOutbox(env, companyId, limit = 200) {
  const { results } = await env.DB.prepare(
    `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE company_id = ?1 ORDER BY id DESC LIMIT ?2`,
  )
    .bind(companyId, limit)
    .all();
  return results.map(outboxRow);
}

export async function queueEmail(env, companyId, msg, actor) {
  const row = await env.DB.prepare(
    `INSERT INTO outbox (company_id, investor_id, to_email, to_name, cc, subject, body, attachments,
       send_after, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`,
  )
    .bind(
      companyId,
      msg.investorId,
      msg.to,
      msg.toName,
      msg.cc,
      msg.subject,
      msg.body,
      JSON.stringify(msg.attachments),
      msg.sendAfter,
      Date.now(),
      actor,
    )
    .first();
  return row.id;
}

// Only unsent messages can be cancelled; a sent one is history.
export function cancelEmail(env, companyId, id) {
  return env.DB.prepare("DELETE FROM outbox WHERE company_id = ?1 AND id = ?2 AND sent_at = 0")
    .bind(companyId, Number(id))
    .run();
}

export function retryEmail(env, companyId, id) {
  return env.DB.prepare(
    "UPDATE outbox SET failed_at = 0, error = '' WHERE company_id = ?1 AND id = ?2 AND sent_at = 0",
  )
    .bind(companyId, Number(id))
    .run();
}

export async function dueEmails(env, companyId, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT ${OUTBOX_COLUMNS} FROM outbox
     WHERE company_id = ?1 AND sent_at = 0 AND failed_at = 0 AND send_after <= ?2
     ORDER BY id LIMIT ?3`,
  )
    .bind(companyId, Date.now(), limit)
    .all();
  return results.map(outboxRow);
}

// Returns the row so the caller can log against the investor it was about.
// `sent_at = 0` in the WHERE makes a duplicate report from a retried mailer
// run a no-op instead of a second log entry.
export function recordSendResult(env, companyId, id, { ok, error }) {
  const now = Date.now();
  const sql = ok
    ? "UPDATE outbox SET sent_at = ?3, error = '' WHERE company_id = ?1 AND id = ?2 AND sent_at = 0 RETURNING investor_id, to_email"
    : "UPDATE outbox SET failed_at = ?3, error = ?4 WHERE company_id = ?1 AND id = ?2 AND sent_at = 0 RETURNING investor_id, to_email";
  const stmt = env.DB.prepare(sql);
  return (
    ok
      ? stmt.bind(companyId, Number(id), now)
      : stmt.bind(companyId, Number(id), now, String(error || "").slice(0, 500))
  ).first();
}

export function appendLog(env, companyId, { id, firm, type, detail }, actor) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO log (company_id, id, firm, type, detail, ts, actor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(companyId, id, firm, type, detail, Date.now(), actor)
    .run();
}

// ---- email: mailer credential ----

export function getMailer(env, companyId) {
  return env.DB.prepare("SELECT created_at, last_seen FROM mailers WHERE company_id = ?1")
    .bind(companyId)
    .first();
}

export function setMailerToken(env, companyId, tokenHash) {
  return env.DB.prepare(
    `INSERT INTO mailers (company_id, token_hash, created_at, last_seen) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT(company_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_seen = 0`,
  )
    .bind(companyId, tokenHash, Date.now())
    .run();
}

// Resolves a mailer token to its company and stamps the visit, so the app can
// show whether a mailer has actually checked in.
export async function mailerCompany(env, tokenHash) {
  const row = await env.DB.prepare("SELECT company_id FROM mailers WHERE token_hash = ?1")
    .bind(tokenHash)
    .first();
  if (!row) return null;
  await env.DB.prepare("UPDATE mailers SET last_seen = ?2 WHERE company_id = ?1")
    .bind(row.company_id, Date.now())
    .run();
  return row.company_id;
}

export async function getInvestor(env, companyId, id) {
  const row = await env.DB.prepare("SELECT data FROM investors WHERE company_id = ?1 AND id = ?2")
    .bind(companyId, String(id))
    .first();
  return row ? col(row.data, null) : null;
}
