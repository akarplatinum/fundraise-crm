// Fundraise CRM: the Cloudflare Worker entry point and router.
//
// One founder, one raise: upload a pitch deck (or point at a website), get a
// structured company profile, score a list of investors against it, work the
// pipeline, and email investors from your own mailbox.
//
// Where things live:
//
//   index.js      this file: routing, the session gate, request validation
//   auth.js       password hashing and the signed session cookie
//   http.js       response helpers (json, csv, downloads)
//   ai.js     the Anthropic call, model settings, per-user daily limits
//   profile.js    deck/site analysis, the category taxonomy, the deck score
//   investors.js  investor discovery and scoring the list against a profile
//   drafts.js     the prompts behind intro drafts and the deck critique
//   mail.js       attachments, the outbox, and the API apps/mailer drains
//   store.js      every database query; nothing else touches env.DB
//
// Every row is scoped to the company_id resolved from the session. Long jobs
// (analysis, discovery, scoring) run in ctx.waitUntil and write status to the
// companies row, which the client polls; no response waits on a model call.

import { DEFAULT_MODEL, LIMITS, callAnthropic, resolveModel, spend, toBase64, utcDay } from "./ai.js";
import { JSON_TYPE, NO_STORE, asset, download, json, readJson, toCsv } from "./http.js";
import {
  SESSION_DAYS,
  hashPassword,
  hex,
  makeSession,
  readSession,
  rid,
  sessionCookie,
  timingSafeEqual,
} from "./auth.js";
import {
  DECK_OFF_MSG,
  MAX_DECK_BYTES,
  analyzeProfile,
  categoryLabels,
  deckUploadEnabled,
  normalizeSiteUrl,
} from "./profile.js";
import {
  SCORE_BATCH,
  SCORE_DEFAULT_TOP,
  discoverInvestors,
  normalizeInvestor,
  runScoring,
} from "./investors.js";
import { buildCritiquePrompt, buildIntroPrompts } from "./drafts.js";
import { MAX_FILE_BYTES, handleMail, handleMailerApi, storeFile } from "./mail.js";
import {
  createAccount,
  deleteInvestor,
  findUser,
  getCompany,
  getSettings,
  loadCrm,
  loadInvestors,
  markAnalyzing,
  markDiscoverFailed,
  markDiscovered,
  markDiscovering,
  markFailed,
  markScoreFailed,
  markScoring,
  saveCrm,
  saveInvestors,
  saveProfile,
  saveSettings,
  touchLastSeen,
  updateCompany,
  usageToday,
} from "./store.js";

// Shared by the deck and website entry points so the two can never drift on the
// failure path — a tenant left in 'analyzing' forever is unrecoverable from the
// UI, so both paths must write a terminal status.
function beginAnalysis(env, ctx, companyId, { pdfBase64 = "", siteUrl = "", label = "" }) {
  ctx.waitUntil(
    (async () => {
      try {
        const profile = await analyzeProfile(env, { pdfBase64, siteUrl });
        await saveProfile(env, companyId, {
          profile,
          name: profile.company,
          // The column stays a flat label list: it is the founder's confirmed
          // selection, and the chips they add by hand have no taxonomy entry.
          // The labeled objects live on the profile blob.
          categories: categoryLabels(profile.categories),
        });
      } catch (e) {
        await markFailed(env, companyId, e.message || e);
      }
    })(),
  );
  return json({ ok: true, status: "analyzing", source: label });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    try {
      // ---- open routes ----
      if (p === "/api/signup" && method === "POST") {
        if (env.SIGNUP_OPEN !== "true") return json({ error: "Signup is closed on this deploy." }, 403);
        const b = await readJson(request);
        const username = String(b.username || "")
          .trim()
          .toLowerCase();
        const password = String(b.password || "");
        const display = String(b.display || "").trim() || username;
        const companyName = String(b.company || "").trim();
        if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
          return json({ error: "Username must be 3-40 chars: letters, numbers, . _ -" }, 400);
        }
        if (password.length < 12) return json({ error: "Password must be at least 12 characters." }, 400);
        if (!companyName) return json({ error: "Company name is required." }, 400);
        if (await findUser(env, username)) return json({ error: "That username is taken." }, 409);

        const companyId = rid("co");
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        await createAccount(env, {
          companyId,
          companyName,
          username,
          display,
          salt,
          pwHash: await hashPassword(salt, password),
        });
        const token = await makeSession(env, username);
        return new Response(JSON.stringify({ ok: true, user: { username, display }, company: companyName }), {
          headers: {
            "content-type": JSON_TYPE,
            "cache-control": NO_STORE,
            "set-cookie": sessionCookie(token, SESSION_DAYS * 86400),
          },
        });
      }

      if (p === "/api/login" && method === "POST") {
        const creds = await readJson(request);
        const user = await findUser(env, creds.username);
        // Hash even when the user doesn't exist, so response time doesn't leak
        // which usernames are real.
        const candidate = await hashPassword(user ? user.salt : "absent", String(creds.password || ""));
        if (!user || !timingSafeEqual(candidate, user.pw_hash)) {
          return json({ error: "Wrong username or password." }, 401);
        }
        await touchLastSeen(env, user.username);
        const token = await makeSession(env, user.username);
        return new Response(
          JSON.stringify({ ok: true, user: { username: user.username, display: user.display } }),
          {
            headers: {
              "content-type": JSON_TYPE,
              "cache-control": NO_STORE,
              "set-cookie": sessionCookie(token, SESSION_DAYS * 86400),
            },
          },
        );
      }

      if (p === "/api/logout") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": JSON_TYPE,
            "cache-control": NO_STORE,
            "set-cookie": sessionCookie("", 0),
          },
        });
      }

      if (p === "/login" || p === "/login.html") return asset(env, request, "/login.html");
      if (p === "/signup" || p === "/signup.html") return asset(env, request, "/signup.html");

      // Vendored static scripts sit above the session gate: they hold no tenant
      // data, and the signed-out pages load them too.
      //
      // Deliberately narrow. A bare `/vendor/` prefix pass-through hands an
      // unauthenticated caller the app shell, because Pages falls back to
      // index.html for any path that isn't a real file — so match one .js file
      // and confirm what came back is actually a script. Anything else drops
      // through to the session check below.
      if (/^\/vendor\/[a-z0-9._-]+\.js$/.test(p)) {
        const res = await asset(env, request, p);
        if (res.ok && (res.headers.get("content-type") || "").includes("javascript")) return res;
      }

      // The mailer authenticates with its own bearer token, not a session.
      if (p.startsWith("/api/mailer/")) return handleMailerApi(request, env, url);

      // ---- everything below requires a session ----
      const username = await readSession(env, request);
      if (!username) {
        if (p.startsWith("/api/")) return json({ error: "not signed in" }, 401);
        const to = new URL(request.url);
        to.pathname = "/login";
        to.search = p === "/" ? "" : `?next=${encodeURIComponent(p)}`;
        // Built by hand rather than Response.redirect() so no-store sticks — a
        // cached redirect would bounce signed-in users to /login.
        return new Response(null, {
          status: 302,
          headers: { location: to.toString(), "cache-control": NO_STORE },
        });
      }

      const me = await findUser(env, username);
      if (!me) {
        // The cookie is validly signed but names a user this database doesn't
        // have — e.g. a session minted against an earlier/other DB, or an
        // account since removed. For a page load, don't dead-end on a JSON
        // error: clear the stale cookie and bounce to /login so a refresh
        // recovers. API callers still get the JSON 401 they can handle.
        if (p.startsWith("/api/")) return json({ error: "account no longer exists" }, 401);
        const to = new URL(request.url);
        to.pathname = "/login";
        to.search = "";
        return new Response(null, {
          status: 302,
          headers: { location: to.toString(), "cache-control": NO_STORE, "set-cookie": sessionCookie("", 0) },
        });
      }
      const companyId = me.company_id;
      if (!companyId) return json({ error: "This account is not attached to a company." }, 403);

      // Onboarding gate: until a deck has been analyzed there is no profile to
      // hang discovery or intros off, so send the UI to /onboarding.
      if (p === "/" || p === "/index.html") {
        const co = await getCompany(env, companyId);
        if (!co || co.deck.status !== "ready") {
          return new Response(null, {
            status: 302,
            headers: { location: new URL("/onboarding", request.url).toString(), "cache-control": NO_STORE },
          });
        }
      }
      if (p === "/onboarding" || p === "/onboarding.html") return asset(env, request, "/onboarding.html");

      if (p === "/api/me" && method === "GET") {
        const co = await getCompany(env, companyId);
        return json({
          username: me.username,
          display: me.display,
          role: me.role,
          company: co,
          // Resolved, not read straight off env: a key saved on the Settings
          // page counts, or the UI tells a founder to configure one that is
          // already there.
          keyPresent: !!(await resolveModel(env)).apiKey,
          // Single-tenant deploys whose profile is hand-curated set
          // DECK_UPLOAD=off so re-analysis can't clobber it; the UI reads this
          // to hide the upload step. Default on, so the white-label template is
          // unchanged for every normal multi-tenant deploy.
          deckUpload: deckUploadEnabled(env),
        });
      }

      // ---- deck upload + analysis ----
      //
      // The PDF is sent as a raw body (content-type: application/pdf) rather
      // than multipart — the Worker only needs the bytes, and skipping
      // multipart parsing removes a whole class of edge cases.
      //
      // ?url= is optional: a founder with both gets one analysis over the pair
      // rather than two runs that overwrite each other.
      if (p === "/api/deck" && method === "POST") {
        if (!deckUploadEnabled(env)) return json({ error: DECK_OFF_MSG }, 403);
        const buf = await request.arrayBuffer();
        if (!buf.byteLength) return json({ error: "Empty upload." }, 400);
        if (buf.byteLength > MAX_DECK_BYTES) {
          return json({ error: `Deck is too large (max ${MAX_DECK_BYTES / 1024 / 1024}MB).` }, 413);
        }
        // Magic bytes, not the declared content-type: the browser's guess is not
        // a guarantee, and Anthropic will reject a non-PDF anyway — better to
        // fail here with a clear message than burn a quota unit on it.
        const head = new Uint8Array(buf.slice(0, 5));
        if (String.fromCharCode(...head) !== "%PDF-") return json({ error: "That file is not a PDF." }, 415);

        let siteUrl;
        try {
          siteUrl = normalizeSiteUrl(url.searchParams.get("url"));
        } catch (e) {
          return json({ error: e.message }, e.status || 400);
        }

        try {
          await spend(env, me.username, "deck");
        } catch (e) {
          return json({ error: e.message }, e.status || 500);
        }

        const name = (url.searchParams.get("name") || "deck.pdf").slice(0, 120);
        await markAnalyzing(env, companyId, { deckName: name, siteUrl });

        // The deck you were analyzed on is the deck investors get. A deck too
        // big to email is still analyzed; it just isn't attached by default.
        if (buf.byteLength <= MAX_FILE_BYTES) {
          await storeFile(
            env,
            companyId,
            buf,
            { name, mime: "application/pdf", byDefault: true },
            me.username,
          );
        }

        return beginAnalysis(env, ctx, companyId, {
          pdfBase64: toBase64(buf),
          siteUrl,
          label: siteUrl ? "deck+site" : "deck",
        });
      }

      // ---- website-only analysis ----
      //
      // Same quota bucket as the deck: it is the same model call from the key
      // owner's perspective, and metering them separately would let a founder
      // double their daily profile runs by alternating sources.
      if (p === "/api/site" && method === "POST") {
        if (!deckUploadEnabled(env)) return json({ error: DECK_OFF_MSG }, 403);
        const b = await readJson(request);

        let siteUrl;
        try {
          siteUrl = normalizeSiteUrl(b.url);
        } catch (e) {
          return json({ error: e.message }, e.status || 400);
        }
        if (!siteUrl) return json({ error: "Enter your website address." }, 400);

        try {
          await spend(env, me.username, "deck");
        } catch (e) {
          return json({ error: e.message }, e.status || 500);
        }

        await markAnalyzing(env, companyId, { siteUrl });

        return beginAnalysis(env, ctx, companyId, { siteUrl, label: "site" });
      }

      // Hand-edit the profile the model produced, or the confirmed categories.
      if (p === "/api/profile" && method === "POST") {
        const b = await readJson(request);
        // Only the fields actually present are sent down; the store ignores
        // anything it doesn't recognise rather than interpolating it.
        const fields = {};
        if (b.profile && typeof b.profile === "object") fields.profile = b.profile;
        if (Array.isArray(b.categories)) fields.categories = b.categories.slice(0, 12);
        if (typeof b.name === "string" && b.name.trim()) fields.name = b.name.trim();
        if (!Object.keys(fields).length) return json({ error: "nothing to update" }, 400);
        await updateCompany(env, companyId, fields);
        return json({ ok: true, company: await getCompany(env, companyId) });
      }

      // ---- scoring the list against this company ----
      //
      // Separate from discovery on purpose. Discovery goes and finds firms that
      // are not in the list yet and costs a web-search run per firm; scoring
      // reads what is already there. A founder who starts from the bundled seed
      // list wants this one, and wants it before spending anything on the other.
      if (p === "/api/score" && method === "POST") {
        const co = await getCompany(env, companyId);
        if (!co || co.deck.status !== "ready") {
          return json({ error: "Analyze a deck or website first — there is nothing to score against." }, 409);
        }
        if (co.score.status === "scoring") {
          return json({ ok: true, status: "scoring", note: "A scoring run is already going." });
        }
        // The body is optional here.
        const b = await request.json().catch(() => ({}));
        // How deep the model pass goes. Capped: the structural pass is free and
        // covers everything, but "score all 900 with the model" is a bill the
        // person clicking the button cannot see coming.
        const top = Math.max(SCORE_BATCH, Math.min(400, parseInt(b.top) || SCORE_DEFAULT_TOP));

        try {
          await spend(env, me.username, "score");
        } catch (e) {
          return json({ error: e.message }, e.status || 500);
        }

        await markScoring(env, companyId);
        ctx.waitUntil(
          (async () => {
            try {
              await runScoring(env, companyId, co, me.username, top);
            } catch (e) {
              await markScoreFailed(env, companyId, e.message);
            }
          })(),
        );
        return json({ ok: true, status: "scoring", top });
      }

      // ---- investor discovery ----
      if (p === "/api/discover" && method === "POST") {
        const co = await getCompany(env, companyId);
        if (!co || co.deck.status !== "ready") {
          return json({ error: "Upload and analyze a deck first." }, 409);
        }
        // The body is optional here.
        const b = await request.json().catch(() => ({}));
        const categories = Array.isArray(b.categories) ? b.categories : co.categories;

        // Refuse to start a second run over the top of one already going. Two
        // concurrent searches would both spend quota and race on saveInvestors.
        // getCompany already downgrades a stale 'searching' to 'failed', so a
        // job that died mid-flight does not lock the founder out of retrying.
        if (co.discover.status === "searching") {
          return json({ ok: true, status: "searching", note: "A search is already running." });
        }

        try {
          await spend(env, me.username, "discover");
        } catch (e) {
          return json({ error: e.message }, e.status || 500);
        }

        // Discovery is a 5-15 minute job: web search across 12-20 firms, up to
        // four pause_turn rounds. Holding the response open for that long hangs
        // the browser and exceeds what a Worker will keep alive in production,
        // so it runs in the background on exactly the pattern deck analysis
        // uses, and the client polls /api/me for company.discover.status.
        await markDiscovering(env, companyId);
        ctx.waitUntil(
          (async () => {
            try {
              const existing = await loadInvestors(env, companyId);
              const found = await discoverInvestors(
                env,
                co.profile,
                categories,
                existing.map((i) => i.firm).filter(Boolean),
              );
              const recs = found.filter((f) => f && f.firm).map((f) => normalizeInvestor(f, "discovered"));
              if (recs.length) await saveInvestors(env, companyId, recs, "discovered", me.username);
              await markDiscovered(env, companyId, recs.length);
            } catch (e) {
              await markDiscoverFailed(env, companyId, e.message);
            }
          })(),
        );
        return json({ ok: true, status: "searching" });
      }

      // ---- data + CRM ----
      if (p === "/api/data" && method === "GET") {
        const [investors, co] = await Promise.all([
          loadInvestors(env, companyId),
          getCompany(env, companyId),
        ]);
        return json({
          vcs: investors,
          competitors: (co && co.profile && co.profile.competitors) || [],
          company: co,
          keyPresent: !!(await resolveModel(env)).apiKey,
        });
      }

      if (p === "/api/investor" && method === "POST") {
        const inv = await readJson(request);
        if (!inv || !inv.firm || !String(inv.firm).trim()) return json({ error: "firm/name required" }, 400);
        const rec = normalizeInvestor(inv, "manual");
        await saveInvestors(env, companyId, [rec], "manual", me.username);
        return json({ ok: true, investor: rec });
      }

      if (p === "/api/investor" && method === "DELETE") {
        await deleteInvestor(env, companyId, url.searchParams.get("id"));
        return json({ ok: true });
      }

      if (p === "/api/crm" && method === "GET") {
        const crm = await loadCrm(env, companyId);
        // Clients echo `_base` back on save so we can tell a real deletion from
        // "this client simply hadn't seen that deal yet".
        return json({ ...crm, _base: Date.now() });
      }

      if (p === "/api/crm" && method === "POST") {
        const parsed = await readJson(request);
        const saved = await saveCrm(env, companyId, parsed, me.username);
        // A refusal is a 409, not a 500: nothing failed, the server declined a
        // write that looked like data loss. The client shows the message and
        // keeps the work on screen rather than assuming it landed.
        if (saved && saved.refused)
          return json({ error: saved.error, would_delete: saved.would_delete }, 409);
        return json({ ok: true, _base: Date.now() });
      }

      if (p === "/api/intro" && method === "POST") {
        const parsed = await readJson(request);
        const co = await getCompany(env, companyId);
        if (!co || co.deck.status !== "ready") return json({ error: "Analyze a deck first." }, 409);
        try {
          await spend(env, me.username, "intro");
          const { system, user } = buildIntroPrompts(parsed, co.profile, me.display);
          const text = await callAnthropic(env, {
            system,
            content: [{ type: "text", text: user }],
            maxTokens: 2000,
            effort: "medium",
          });
          return json({ text });
        } catch (e) {
          const msg = e.message === "no_api_key" ? "No API key is configured on this deploy." : e.message;
          return json({ error: msg }, e.status || 502);
        }
      }

      if (p === "/api/critique" && method === "POST") {
        const co = await getCompany(env, companyId);
        if (!co || co.deck.status !== "ready") return json({ error: "Analyze a deck first." }, 409);
        try {
          await spend(env, me.username, "critique");
          const { system, user } = buildCritiquePrompt(co.profile, co.name || "the company");
          const text = await callAnthropic(env, {
            system,
            content: [{ type: "text", text: user }],
            maxTokens: 4000,
            effort: "high",
          });
          // Stored in the profile blob rather than a new column: profile is
          // already a free-form JSON doc (see the deck_score precedent), so a
          // critique needs no migration and round-trips through /api/profile.
          const profile = { ...co.profile, critique: text, critique_ts: Date.now() };
          await updateCompany(env, companyId, { profile });
          return json({ text, ts: profile.critique_ts });
        } catch (e) {
          const msg = e.message === "no_api_key" ? "No API key is configured on this deploy." : e.message;
          return json({ error: msg }, e.status || 502);
        }
      }

      // ---- export ----
      //
      // Deliberately not metered: it costs no API calls and a founder locked out
      // of their own list by a daily cap would be a bad surprise. Tenant-scoped
      // like every other read, and no-store because it is per-user data.
      if (p === "/api/export" && method === "GET") {
        const what = url.searchParams.get("what") || "investors";
        const fmt = url.searchParams.get("format") === "json" ? "json" : "csv";
        const [investors, crm, co] = await Promise.all([
          loadInvestors(env, companyId),
          loadCrm(env, companyId),
          getCompany(env, companyId),
        ]);
        const slug =
          (co?.name || "company")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "company";
        const stamp = new Date().toISOString().slice(0, 10);

        if (fmt === "json") {
          const body =
            what === "pipeline" ? crm : what === "all" ? { company: co, investors, crm } : investors;
          return download(JSON.stringify(body, null, 2), `${slug}-${what}-${stamp}.json`, JSON_TYPE);
        }

        // CSV. Pipeline rows are investor rows joined to their deal, so the
        // founder gets one sheet with stage and notes against each firm rather
        // than two files they have to VLOOKUP together themselves.
        let csv;
        if (what === "pipeline") {
          // Indexed, not scanned: joining 500 deals against 900 investors with a
          // linear find() is 450,000 comparisons inside a Worker's CPU budget.
          const invById = new Map(investors.map((v) => [v.id, v]));
          const rows = Object.entries(crm.deals || {}).map(([id, d]) => {
            const inv = invById.get(id) || {};
            return {
              id,
              firm: inv.firm || id,
              stage: d.stage || "",
              notes: d.notes || "",
              partner: inv.best_partner?.name || "",
              website: inv.website || "",
              updated: d.ts ? new Date(d.ts).toISOString() : "",
              updated_by: d.by || "",
            };
          });
          csv = toCsv(rows, ["id", "firm", "stage", "notes", "partner", "website", "updated", "updated_by"]);
        } else {
          const rows = investors.map((v) => ({
            id: v.id,
            firm: v.firm,
            type: v.type,
            hq: v.hq,
            website: v.website,
            stages: (v.stages || []).join(" | "),
            category: (v.category || []).join(" | "),
            check_size: v.check_size,
            leads_rounds: v.leads_rounds === true ? "yes" : v.leads_rounds === false ? "no" : "",
            partner: v.best_partner?.name || "",
            thesis: v.thesis,
            why_fit: v.why_fit || v.fit_rationale || "",
            portfolio: (v.relevant_portfolio || []).join(" | "),
            source: v.tier,
            stage_in_pipeline: crm.deals?.[v.id]?.stage || "",
          }));
          csv = toCsv(rows, [
            "id",
            "firm",
            "type",
            "hq",
            "website",
            "stages",
            "category",
            "check_size",
            "leads_rounds",
            "partner",
            "thesis",
            "why_fit",
            "portfolio",
            "source",
            "stage_in_pipeline",
          ]);
        }
        return download(csv, `${slug}-${what}-${stamp}.csv`, "text/csv; charset=utf-8");
      }

      // ---- instance settings (owner only) ----
      //
      // Which model this deploy calls, and optionally the key it calls with.
      // Admin-only because it spends money: an account that can change the key
      // can point every call at a bill somebody else is paying.
      //
      // The key is WRITE-ONLY across this boundary. GET returns whether one is
      // set and its last four characters — enough to tell two keys apart, not
      // enough to use. There is no route that returns it, and adding one would
      // undo the reason it is safe to store at all.
      if (p === "/api/settings" && method === "GET") {
        if (me.role !== "admin") return json({ error: "Only an admin can view settings." }, 403);
        const cfg = await resolveModel(env);
        const saved = await getSettings(env);
        return json({
          model: cfg.model,
          effort: cfg.effort,
          defaultModel: DEFAULT_MODEL,
          keySet: !!cfg.apiKey,
          // Where the key came from matters to whoever is debugging: a saved key
          // silently overriding a Worker secret is otherwise invisible.
          keySource: saved.api_key ? "settings" : env.ANTHROPIC_API_KEY ? "worker secret" : "none",
          keyTail: cfg.apiKey ? cfg.apiKey.slice(-4) : "",
        });
      }

      if (p === "/api/settings" && method === "POST") {
        if (me.role !== "admin") return json({ error: "Only an admin can change settings." }, 403);
        const b = await readJson(request);
        const patch = {};
        if (typeof b.model === "string") patch.model = b.model.trim();
        if (typeof b.effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(b.effort)) {
          patch.effort = b.effort;
        }
        if (typeof b.api_key === "string") {
          const key = b.api_key.trim();
          // "" is the documented way to clear a saved key and fall back to the
          // Worker secret, so it is a valid value rather than a missing one.
          if (key && !/^sk-ant-/.test(key)) {
            return json(
              { error: "That does not look like an Anthropic API key (they start with sk-ant-)." },
              400,
            );
          }
          patch.api_key = key;
        }
        if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
        await saveSettings(env, patch);
        const cfg = await resolveModel(env);
        return json({ ok: true, model: cfg.model, effort: cfg.effort, keySet: !!cfg.apiKey });
      }

      if (p === "/api/usage" && method === "GET") {
        const results = await usageToday(env, me.username, utcDay());
        const used = Object.fromEntries(results.map((r) => [r.kind, r.count]));
        return json({ limits: LIMITS, used });
      }

      const mailResponse = await handleMail(request, env, { url, me, companyId });
      if (mailResponse) return mailResponse;

      // ---- static assets ----
      return env.ASSETS.fetch(request);
    } catch (e) {
      // Errors thrown deliberately by a route carry a status, and their message
      // is written to be read by a founder ("Daily limit reached…"). Those pass
      // through. Anything without one is an unexpected failure, and its message
      // is an internal detail — a D1 error, a stack-adjacent string, a provider
      // response — that should be logged rather than handed to the browser.
      if (e && e.status) return json({ error: String(e.message || e) }, e.status);
      console.error("unhandled:", p, method, e && (e.stack || e.message || e));
      return json({ error: "Something went wrong on our side. Try again." }, 500);
    }
  },
};
