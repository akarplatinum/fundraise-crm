// End-to-end checks against the real Worker, in-process.
//
//   node test/smoke.js
//
// src/index.js is imported unmodified and driven through its actual fetch handler,
// over the real schema.sql on an in-memory SQLite database (test/d1.js). Only
// two things are faked: the Anthropic endpoint, and the static asset server.
// Everything else — routing, sessions, tenant scoping, metering, the scoring
// engine, the settings surface — is the shipping code.
//
// The point of these is not coverage. It is the handful of things that are
// expensive to find in production: a tenant reading another tenant's pipeline,
// a metering ceiling that does not hold, an API key leaking into a response,
// and a scoring run that writes nothing.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeDB } from "./d1.js";

// node:sqlite landed in Node 22. On 18 or 20 the import fails with a module
// error that says nothing about versions, so say it here instead.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`These tests need Node 22+ for node:sqlite (found ${process.versions.node}).`);
  console.error("The app itself runs on Cloudflare Workers and has no such requirement.");
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const worker = (await import(path.join(ROOT, "src/index.js"))).default;

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

// ---- fake Anthropic ----
//
// Records every request so the tests can assert on what was actually sent —
// which model, which key — rather than only on what came back.
const sent = [];
let anthropicHandler = null;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://api.anthropic.com")) throw new Error("unexpected fetch: " + u);
  const body = JSON.parse(init.body);
  sent.push({ model: body.model, key: init.headers["x-api-key"], body });
  return anthropicHandler(body);
};
const reply = (obj) =>
  new Response(
    JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }] }),
    { status: 200 },
  );

// ---- env ----
function makeEnv(extra = {}) {
  return {
    DB: makeDB(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8")),
    SESSION_SECRET: "test-secret-not-a-real-one",
    ASSETS: {
      fetch: async () => new Response("<html>asset</html>", { headers: { "content-type": "text/html" } }),
    },
    ...extra,
  };
}

// ctx.waitUntil normally lets a handler return before its background job is
// done. Here the jobs are collected so a test can await them — otherwise every
// assertion about a background run is a race.
function makeCtx() {
  const jobs = [];
  return { ctx: { waitUntil: (p) => jobs.push(p) }, settle: () => Promise.all(jobs) };
}

const call = (env, ctx, path, opts = {}) =>
  worker.fetch(
    new Request("https://test.local" + path, {
      method: opts.method || "GET",
      headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers || {}) },
      body: opts.body,
    }),
    env,
    ctx,
  );

const cookieFrom = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

async function signup(env, ctx, { username, password, company }) {
  const r = await call(env, ctx, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, company, display: username }),
  });
  return { res: r, cookie: cookieFrom(r) };
}

// A profile good enough for the scoring engine to have something to reason
// about, written the way the deck analyzer writes one.
const PROFILE = {
  company: "Northwind",
  one_liner: "Warehouse robotics for mid-size distributors.",
  stage: "Seed",
  raising: "$3M",
  business_model: "b2b-saas",
  categories: [{ label: "robotics", axis: "sector", confidence: 0.9, evidence: "slide 3" }],
  ideal_investor: "A seed fund that backs physical-world automation.",
};

async function main() {
  // ---------------------------------------------------------------- accounts
  section("Accounts and sessions");
  const env = makeEnv({ SIGNUP_OPEN: "true", ANTHROPIC_API_KEY: "sk-ant-secret-KEY1" });
  let { ctx, settle } = makeCtx();

  const a = await signup(env, ctx, {
    username: "ava",
    password: "correct-horse-battery",
    company: "Northwind",
  });
  check("signup creates an account and a session", a.res.status === 200 && /^\w+=\S+/.test(a.cookie));

  const anon = await call(env, ctx, "/api/data");
  check(
    "an unauthenticated API call is refused",
    anon.status === 401 || anon.status === 302,
    `got ${anon.status}`,
  );

  const me = await (await call(env, ctx, "/api/me", { cookie: a.cookie })).json();
  check("signup does NOT grant admin", me.role === "founder", `role was ${me.role}`);

  // ------------------------------------------------------------ tenant walls
  section("Tenant isolation");
  const b = await signup(env, ctx, {
    username: "sam",
    password: "correct-horse-battery",
    company: "Southwind",
  });
  const aCo = (await (await call(env, ctx, "/api/me", { cookie: a.cookie })).json()).company.id;
  const bCo = (await (await call(env, ctx, "/api/me", { cookie: b.cookie })).json()).company.id;
  check("two signups get different companies", aCo !== bCo);

  await call(env, ctx, "/api/investor", {
    method: "POST",
    cookie: a.cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firm: "Ava Only Capital", category: "robotics" }),
  });
  await call(env, ctx, "/api/investor", {
    method: "POST",
    cookie: a.cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firm: "Hand Added Fund",
      best_partner: { name: "Pat", email: "pat@fund.example", x: 1 },
    }),
  });
  const aData = await (await call(env, ctx, "/api/data", { cookie: a.cookie })).json();
  const handAdded = aData.vcs.find((v) => v.firm === "Hand Added Fund");
  check(
    "a hand-added partner keeps its name and email, and nothing else",
    JSON.stringify(handAdded?.best_partner) === JSON.stringify({ name: "Pat", email: "pat@fund.example" }),
    JSON.stringify(handAdded?.best_partner),
  );
  const bData = await (await call(env, ctx, "/api/data", { cookie: b.cookie })).json();
  check(
    "one tenant cannot see another's investors",
    !(bData.vcs || []).some((v) => v.firm === "Ava Only Capital"),
    `sam saw ${(bData.vcs || []).length} investors`,
  );

  // --------------------------------------------------------------- the seed
  section("Seeded investor list");
  const seedFile = path.join(ROOT, "../../data/investors.json");
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  check(`the list is present (${seed.length} firms)`, seed.length > 0);
  check(
    "the list carries no fit scores",
    seed.every((v) => !("fit_score" in v) && !("scored" in v)),
    "a bundled fit score would be an opinion about somebody else's company",
  );
  check(
    "no seeded record names the source company",
    !/re\s?route/i.test(JSON.stringify(seed)),
    "the export sanitizer leaked",
  );
  check(
    "records carry the fields the UI reads",
    seed.every((v) => v.id && v.firm && Array.isArray(v.category) && typeof v.best_partner === "object"),
  );

  // Load the first chunk into ava's pipeline with the real loader script.
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  execFileSync("node", [path.join(ROOT, "scripts/seed-investors.js"), aCo, seedDir], { stdio: "ignore" });
  const firstChunk = fs.readFileSync(path.join(seedDir, "001.sql"), "utf8").trim().split(";\n");
  await env.DB.batch(firstChunk.map((sql) => env.DB.prepare(sql)));
  const seeded = await (await call(env, ctx, "/api/data", { cookie: a.cookie })).json();
  const seededRows = seeded.vcs.filter((v) => v.tier === "seed" || v.tier === "fund-list");
  check(
    "the loader's rows load through the API",
    seededRows.length === firstChunk.length,
    `got ${seededRows.length}`,
  );
  check(
    "loaded rows arrive unscored",
    seededRows.every((v) => v.scored === false && v.fit_score === 50),
  );
  const { provenance } = await import(path.join(ROOT, "src/investors.js"));
  check(
    "both halves of the bundled list are stored as seed rows",
    provenance({ tier: "seed" }) === "seed" && provenance({ tier: "fund-list" }) === "seed",
    "scoring would relabel fund-list rows as hand-added",
  );

  // -------------------------------------------------------------- profiling
  section("Scoring");
  // Stand a profile up directly: deck analysis is the model reading a PDF, which
  // is not what these tests are about.
  await env.DB.prepare("UPDATE companies SET profile=?1, deck_status='ready', categories=?2 WHERE id=?3")
    .bind(JSON.stringify(PROFILE), JSON.stringify(["robotics", "b2b-saas"]), aCo)
    .run();

  const notReady = await call(env, ctx, "/api/score", { method: "POST", cookie: b.cookie, body: "{}" });
  check("scoring is refused before there is a profile to score against", notReady.status === 409);

  anthropicHandler = (body) => {
    const rows = JSON.parse(body.messages[0].content[0].text.split("\n\n").pop());
    return reply({
      scores: rows.map((r) => ({ id: r.id, fit_score: 80, fit_rationale: "Backs physical automation." })),
    });
  };
  ({ ctx, settle } = makeCtx());
  env.DB.resetQueryCount();
  const started = await call(env, ctx, "/api/score", { method: "POST", cookie: a.cookie, body: "{}" });
  check("a scoring run starts and returns immediately", started.status === 200);
  await settle();
  // A scoring run rewrites the whole pipeline. One statement per row would put a
  // full 900-firm run at ~950 queries — past a free plan's 50-per-invocation
  // ceiling by eighteen times and within a rounding error of the paid 1,000.
  check(
    "a scoring run stays inside the query budget",
    env.DB._queries < 50,
    `${env.DB._queries} queries to score ${seededRows.length} investors`,
  );

  const after = await (await call(env, ctx, "/api/data", { cookie: a.cookie })).json();
  const scoredRows = after.vcs.filter((v) => v.scored === true);
  check("the model pass wrote scores", scoredRows.length > 0, `${scoredRows.length} scored`);
  check(
    "every firm got a structural score, not just the model slice",
    after.vcs.every((v) => typeof v.structural_score === "number"),
    "the free pass is what makes the paid one affordable — it must cover everything",
  );
  check(
    "scores differ between firms",
    scoredRows.length > 0 && new Set(after.vcs.map((v) => v.fit_score)).size > 1,
    "a scorer that returns one number for everything is not scoring",
  );
  check(
    "a scored firm carries a rationale",
    scoredRows.length > 0 && scoredRows.every((v) => v.fit_rationale),
    "a number with no reason attached is not usable by a founder",
  );
  const co = (await (await call(env, ctx, "/api/me", { cookie: a.cookie })).json()).company;
  check(
    "the run reports itself finished",
    co.score.status === "ready",
    `status ${co.score.status}: ${co.score.error}`,
  );

  // -------------------------------------------------------------- saves at scale
  section("Saving a large pipeline");
  //
  // This section exists because of a specific production failure: saveCrm used
  // to delete removed deals with `id NOT IN (…every id the client kept…)`, one
  // bound parameter per deal. At ~98 deals that crossed D1's 100-parameter
  // ceiling, and since a rejected statement fails the whole batch, every save
  // from then on failed ENTIRELY. It looked like "the app stopped saving", and
  // it went unnoticed for hours because the client swallowed the error.
  //
  // The shim enforces the same 100-parameter ceiling, so these tests fail
  // against the old implementation rather than passing on a technicality.
  {
    const bulk = { deals: {}, log: [], trash: [], _base: Date.now() };
    for (let i = 0; i < 500; i++) {
      bulk.deals[`firm-${i}`] = {
        stage: "submitted",
        notes: "n".repeat(20),
        ts: Date.now(),
        value: i * 1000,
      };
    }
    for (let i = 0; i < 300; i++) {
      bulk.log.push({ id: `firm-${i}`, firm: `Firm ${i}`, type: "submitted", detail: "", ts: 1000 + i });
    }
    env.DB.resetQueryCount();
    const big = await call(env, ctx, "/api/crm", {
      method: "POST",
      cookie: a.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bulk),
    });
    check("500 deals and 300 log rows save without error", big.status === 200, `status ${big.status}`);
    const backB = await (await call(env, ctx, "/api/crm", { cookie: a.cookie })).json();
    check(
      "all 500 deals came back",
      Object.keys(backB.deals).length === 500,
      `${Object.keys(backB.deals).length}`,
    );
    check("all 300 log rows came back", backB.log.length === 300, `${backB.log.length}`);
    check(
      "the log comes back oldest-first",
      backB.log[0].ts < backB.log[backB.log.length - 1].ts,
      "the window takes the newest rows but the UI reads oldest-first",
    );
    // 800 rows as one statement per row would be 800 queries — over the free
    // plan's 50-per-invocation ceiling sixteen times over, and close enough to
    // the paid plan's 1,000 to break as the activity log grows.
    check(
      "the save stays well inside the query budget",
      env.DB._queries < 60,
      `${env.DB._queries} queries for an 800-row save`,
    );

    // Deletion still has to work, and has to stay inside the tenant.
    const base2 = backB._base;
    const half = {};
    for (let i = 0; i < 250; i++) half[`firm-${i}`] = backB.deals[`firm-${i}`];
    await call(env, ctx, "/api/crm", {
      method: "POST",
      cookie: a.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deals: half, log: [], trash: [], _base: base2 }),
    });
    const backC = await (await call(env, ctx, "/api/crm", { cookie: a.cookie })).json();
    check(
      "removing 250 deals removes exactly those",
      Object.keys(backC.deals).length === 250,
      `${Object.keys(backC.deals).length}`,
    );
    check("the activity log is never deleted by a save", backC.log.length === 300, `${backC.log.length}`);

    // ---- a save may not empty the board ----
    //
    // Deletion is inferred from absence, and absence is what a failed read
    // produces. The client refuses to save from a board that never loaded, but
    // that guard lives in code we do not control — a stale tab or a second
    // client bypasses it. This is the half that cannot be bypassed.
    const wipe = await call(env, ctx, "/api/crm", {
      method: "POST",
      cookie: a.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deals: {}, log: [], trash: [], _base: Date.now() }),
    });
    check(
      "a save with zero deals against a populated board is refused",
      wipe.status === 409,
      `status ${wipe.status}`,
    );
    const stillThere = await (await call(env, ctx, "/api/crm", { cookie: a.cookie })).json();
    check("the refused save changed nothing", Object.keys(stillThere.deals).length === 250);

    const mostly = {};
    for (let i = 0; i < 40; i++) mostly[`firm-${i}`] = stillThere.deals[`firm-${i}`];
    const halfGone = await call(env, ctx, "/api/crm", {
      method: "POST",
      cookie: a.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deals: mostly, log: [], trash: [], _base: stillThere._base }),
    });
    check(
      "a save deleting most of the board is refused",
      halfGone.status === 409,
      `status ${halfGone.status}`,
    );

    // A real bulk delete has to remain possible, or the guard is a wall.
    const onPurpose = await call(env, ctx, "/api/crm", {
      method: "POST",
      cookie: a.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deals: mostly,
        log: [],
        trash: [],
        _base: stillThere._base,
        confirm_bulk: true,
      }),
    });
    check(
      "confirm_bulk lets a deliberate bulk delete through",
      onPurpose.status === 200,
      `status ${onPurpose.status}`,
    );
    const after40 = await (await call(env, ctx, "/api/crm", { cookie: a.cookie })).json();
    check("and it deletes exactly what was asked", Object.keys(after40.deals).length === 40);

    // A deal the other tenant owns must survive a delete-heavy save here.
    await call(env, ctx, "/api/crm", {
      method: "POST",
      cookie: b.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deals: { "sam-firm": { stage: "submitted", ts: Date.now() } },
        log: [],
        trash: [],
        _base: 0,
      }),
    });
    await call(env, ctx, "/api/crm", {
      method: "POST",
      cookie: a.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deals: {}, log: [], trash: [], _base: Date.now(), confirm_bulk: true }),
    });
    const samBack = await (await call(env, ctx, "/api/crm", { cookie: b.cookie })).json();
    check(
      "one tenant clearing their whole board leaves another's alone",
      !!samBack.deals["sam-firm"],
      "a delete escaped the company scope",
    );
  }

  // ------------------------------------------------------------ log windowing
  section("Activity log growth");
  {
    // 900 entries stands in for an instance that has been in use a while. The
    // read is windowed because nothing ever deletes from this table, so an
    // unwindowed read grows the page-load response for the life of the account.
    const many = [];
    for (let i = 0; i < 900; i++)
      many.push({ id: `x-${i}`, firm: "F", type: "note", detail: "", ts: 900000 + i });
    await call(env, ctx, "/api/crm", {
      method: "POST",
      cookie: b.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deals: {}, log: many, trash: [], _base: 0 }),
    });
    const win = await (await call(env, ctx, "/api/crm", { cookie: b.cookie })).json();
    check("the log read is windowed, not unbounded", win.log.length === 500, `${win.log.length} rows`);
    check(
      "the window keeps the NEWEST entries",
      win.log[win.log.length - 1].ts === 900899,
      `last ts ${win.log[win.log.length - 1]?.ts}`,
    );
  }

  // ------------------------------------------------- scoring must not downgrade
  section("Scoring respects existing scores");
  {
    // A discovered investor was scored by the research pass, which actually read
    // the web. A later structural pass must never overwrite that with a guess.
    await call(env, ctx, "/api/investor", {
      method: "POST",
      cookie: a.cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firm: "Handpicked Capital", category: "robotics", fit_score: 91 }),
    });
    const beforeAll = await (await call(env, ctx, "/api/data", { cookie: a.cookie })).json();
    const before = beforeAll.vcs.find((v) => v.firm === "Handpicked Capital");
    check(
      "a hand-added investor is marked scored",
      before && before.scored === true,
      `scored=${before?.scored}`,
    );

    anthropicHandler = () => reply({ scores: [] }); // model contributes nothing this run
    ({ ctx, settle } = makeCtx());
    await call(env, ctx, "/api/score", { method: "POST", cookie: a.cookie, body: "{}" });
    await settle();
    const afterAll = await (await call(env, ctx, "/api/data", { cookie: a.cookie })).json();
    const after = afterAll.vcs.find((v) => v.firm === "Handpicked Capital");
    check(
      "a scoring run does not overwrite an already-scored investor",
      after && after.fit_score === before.fit_score,
      `${before?.fit_score} became ${after?.fit_score}`,
    );
    check("it still gets a structural score for ordering", typeof after.structural_score === "number");
  }

  // ------------------------------------------------------------------ limits
  section("Spend ceilings");
  ({ ctx, settle } = makeCtx());
  let last;
  for (let i = 0; i < 12; i++) {
    last = await call(env, ctx, "/api/score", { method: "POST", cookie: a.cookie, body: "{}" });
    // Let each run finish, or the concurrency guard answers instead of the meter.
    await settle();
    ({ ctx, settle } = makeCtx());
    if (last.status === 429) break;
  }
  check("the daily ceiling eventually refuses a run", last.status === 429, `ended on ${last.status}`);

  // ---------------------------------------------------------------- settings
  section("Model settings");
  const founderGet = await call(env, ctx, "/api/settings", { cookie: a.cookie });
  check("a founder cannot read settings", founderGet.status === 403);

  await env.DB.prepare("UPDATE users SET role='admin' WHERE username='ava'").run();
  const s1 = await (await call(env, ctx, "/api/settings", { cookie: a.cookie })).json();
  check("an admin can read settings", !!s1.model);
  check("the default model is current", s1.model === "claude-opus-5-5", `got ${s1.model}`);
  check("the key is never returned", !JSON.stringify(s1).includes("sk-ant-secret-KEY1"), "API KEY LEAK");
  check("only the tail is shown", s1.keyTail === "KEY1" && s1.keySource === "worker secret");

  const bad = await call(env, ctx, "/api/settings", {
    method: "POST",
    cookie: a.cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "not-a-key" }),
  });
  check("an implausible key is rejected", bad.status === 400);

  await call(env, ctx, "/api/settings", {
    method: "POST",
    cookie: a.cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "sk-ant-saved-KEY2", model: "claude-sonnet-5-5" }),
  });
  sent.length = 0;
  anthropicHandler = () => reply({ scores: [] });
  ({ ctx, settle } = makeCtx());
  await call(env, ctx, "/api/intro", {
    method: "POST",
    cookie: a.cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firm: "Equal Ventures", type: "warm" }),
  });
  check(
    "a saved key overrides the Worker secret",
    sent[0] && sent[0].key === "sk-ant-saved-KEY2",
    sent[0]?.key,
  );
  check(
    "a saved model is the one actually called",
    sent[0] && sent[0].model === "claude-sonnet-5-5",
    sent[0]?.model,
  );

  const s2 = await (await call(env, ctx, "/api/settings", { cookie: a.cookie })).json();
  check("settings reports where the key came from", s2.keySource === "settings");

  // Clearing falls back to the secret rather than leaving the deploy keyless.
  await call(env, ctx, "/api/settings", {
    method: "POST",
    cookie: a.cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "" }),
  });
  const s3 = await (await call(env, ctx, "/api/settings", { cookie: a.cookie })).json();
  check(
    "clearing a saved key falls back to the secret",
    s3.keySource === "worker secret" && s3.keySet === true,
  );

  // -------------------------------------------------------------------- email
  section("Email");
  const postJson = (cookie, route, body) =>
    call(env, ctx, route, {
      method: "POST",
      cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // A deck big enough to need several slices, with a byte pattern that would
  // show any slice landing out of order.
  const deck = new Uint8Array(1_000_000).map((_, i) => i % 251);
  const up = await (
    await call(env, ctx, "/api/files?name=deck.pdf&default=1", {
      method: "POST",
      cookie: a.cookie,
      body: deck,
    })
  ).json();
  check("a file uploads", up.ok && up.id, JSON.stringify(up));
  const files = (await (await call(env, ctx, "/api/files", { cookie: a.cookie })).json()).files;
  check("an uploaded deck is attached by default", files.length === 1 && files[0].attach_by_default);
  const samFiles = (await (await call(env, ctx, "/api/files", { cookie: b.cookie })).json()).files;
  check("one tenant cannot see another's files", samFiles.length === 0);

  const badAddress = await postJson(a.cookie, "/api/outbox", {
    to: "not-an-address",
    subject: "Hi",
    body: "Hello",
  });
  check("a malformed address is refused", badAddress.status === 400);

  const queued = await (
    await postJson(a.cookie, "/api/outbox", {
      to: "partner@fund.example",
      to_name: "Pat Partner",
      subject: "Northwind",
      body: "Hello Pat",
      investor_id: "seed-" + "x",
      attach: [up.id],
    })
  ).json();
  check("an email queues", queued.ok && queued.id, JSON.stringify(queued));

  const noToken = await call(env, ctx, "/api/mailer/pending");
  check("the mailer API refuses a request with no token", noToken.status === 401);

  const tokA = (
    await (await call(env, ctx, "/api/mailer-token", { method: "POST", cookie: a.cookie })).json()
  ).token;
  const tokB = (
    await (await call(env, ctx, "/api/mailer-token", { method: "POST", cookie: b.cookie })).json()
  ).token;
  const mailer = (tok, route, opts = {}) =>
    call(env, ctx, route, { ...opts, headers: { authorization: `Bearer ${tok}`, ...(opts.headers || {}) } });

  const pendingA = (await (await mailer(tokA, "/api/mailer/pending")).json()).pending;
  const pendingB = (await (await mailer(tokB, "/api/mailer/pending")).json()).pending;
  check(
    "a mailer sees its own company's queue",
    pendingA.length === 1 && pendingA[0].attachments[0].id === up.id,
  );
  check("a mailer cannot see another company's queue", pendingB.length === 0);

  const stolen = await mailer(tokB, `/api/mailer/file?id=${up.id}&seq=0`);
  check("a mailer cannot read another company's file", stolen.status === 404);

  let joined = "";
  for (let seq = 0, chunks = 1; seq < chunks; seq++) {
    const part = await (await mailer(tokA, `/api/mailer/file?id=${up.id}&seq=${seq}`)).json();
    chunks = part.chunks;
    joined += part.data;
  }
  check(
    "the slices concatenate into the file's base64",
    joined === Buffer.from(deck).toString("base64"),
    `got ${joined.length} chars`,
  );

  const report = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: queued.id, ok: true }),
  };
  await mailer(tokA, "/api/mailer/result", report);
  await mailer(tokA, "/api/mailer/result", report);
  const outbox = await (await call(env, ctx, "/api/outbox", { cookie: a.cookie })).json();
  check("a sent message is marked sent", outbox.messages[0].sent_at > 0);
  check("the app sees the mailer has checked in", outbox.mailer.lastSeen > 0);
  const crmAfter = await (await call(env, ctx, "/api/crm", { cookie: a.cookie })).json();
  check(
    "a send reported twice is logged once",
    crmAfter.log.filter((e) => e.type === "emailed").length === 1,
    JSON.stringify(crmAfter.log.filter((e) => e.type === "emailed")),
  );

  const rotated = (
    await (await call(env, ctx, "/api/mailer-token", { method: "POST", cookie: a.cookie })).json()
  ).token;
  check(
    "a new token revokes the old one",
    (await mailer(tokA, "/api/mailer/pending")).status === 401 && !!rotated,
  );

  // ------------------------------------------------------------------- report
  console.log(
    `\n${failures.length ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${failures.length} failed\x1b[0m`,
  );
  if (failures.length) {
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\x1b[31mharness error:\x1b[0m", e);
  process.exit(1);
});
