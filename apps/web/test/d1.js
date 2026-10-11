// A D1 shim over node:sqlite, so the real Worker can be driven in-process.
//
// This exists because the alternative — booting workerd for every check — is
// slow, needs a Cloudflare login for anything remote, and cannot be run in CI
// without one. The shim implements exactly the surface store.js uses:
// prepare/bind/first/run/all/batch. If store.js starts using more of D1 than
// this covers, the shim must grow with it or the tests are testing a fiction.
//
// It is NOT a D1 emulator. Real D1 has limits this does not (statements per
// batch, bound parameters per statement, row size), so a passing test here does
// not prove a query is within them.
import { DatabaseSync } from "node:sqlite";

// D1 and node:sqlite disagree about parameters, in a way that silently corrupts
// data if you translate it carelessly.
//
// D1 uses ?1-style numbered parameters, and store.js REUSES an index — e.g.
// `score_started = ?1, updated = ?1 WHERE id = ?2` binds two values for three
// placeholders. Rewriting every ?N to a bare ? turns that into three positional
// parameters, and the statement then either throws or, worse, writes the id
// into a timestamp column. So numbered parameters become NAMED ones (:p1),
// which node:sqlite binds from an object and which may legitimately repeat.
//
// Statements using plain `?` are bound positionally, unchanged.
const NUMBERED = /\?(\d+)/;
const toNamed = (sql) => sql.replace(/\?(\d+)/g, ":p$1");

// The ceilings real D1 enforces. Without these the shim happily accepts a
// statement with 500 bound parameters, and a regression test for the
// 100-parameter bug would pass against code that still has it — proving
// nothing. A shim that is more permissive than production is worse than no
// shim, because it manufactures confidence.
//
// Source: https://developers.cloudflare.com/d1/platform/limits/
const D1_MAX_PARAMS = 100;
const D1_MAX_SQL_BYTES = 100_000;

class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.named = NUMBERED.test(sql);
    this.sql = this.named ? toNamed(sql) : sql;
    this.args = this.named ? [{}] : [];
  }
  bind(...args) {
    if (args.length > D1_MAX_PARAMS) {
      throw new Error(
        `D1_ERROR: too many SQL variables (${args.length} > ${D1_MAX_PARAMS}) — ` +
          `this statement would be rejected and would fail the whole batch: ${this.sql.slice(0, 120)}`,
      );
    }
    if (this.sql.length > D1_MAX_SQL_BYTES) {
      throw new Error(`D1_ERROR: SQL statement too long (${this.sql.length} > ${D1_MAX_SQL_BYTES} bytes)`);
    }
    const clean = args.map((a) => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a));
    // Numbered placeholders are 1-based and may repeat, so they are addressed
    // by name; plain ones stay a positional list.
    this.args = this.named ? [Object.fromEntries(clean.map((v, i) => [`p${i + 1}`, v]))] : clean;
    return this;
  }
  #prepared() {
    return this.db.prepare(this.sql);
  }
  async first() {
    const rows = this.#prepared().all(...this.args);
    return rows.length ? rows[0] : null;
  }
  async all() {
    return { results: this.#prepared().all(...this.args), success: true };
  }
  // Real D1 returns the same shape for every statement — a `results` array that
  // is simply empty for a write — and batch() returns one of those per
  // statement, SELECTs included. loadCrm() reads its rows straight out of a
  // batch, so a shim that returned `{success, meta}` for reads made a correct
  // caller throw "results is not iterable" and looked like an app bug.
  async run() {
    // node:sqlite splits reads from writes and throws if you call the wrong
    // one. A statement with RETURNING is a read to it, which is why the usage
    // counter needs this branch too.
    if (/^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql)) {
      return { results: this.#prepared().all(...this.args), success: true, meta: {} };
    }
    const r = this.#prepared().run(...this.args);
    return { results: [], success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
  }
}

export function makeDB(schemaSql) {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql);
  return {
    prepare(sql) {
      this._queries = (this._queries || 0) + 1;
      return new Stmt(db, sql);
    },
    // Statements issued since the last reset. Counted in prepare(), which every
    // statement passes through exactly once — batch() must NOT count them again
    // or a batched save reads as double its real cost. Real D1 caps this per
    // Worker invocation at 1,000 on Workers Paid and 50 on Free, so a save whose
    // width scales with the size of the pipeline is a ceiling waiting to be hit.
    _queries: 0,
    resetQueryCount() {
      this._queries = 0;
    },
    // Real D1 batches run in one transaction; so does this.
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    _raw: db,
  };
}
