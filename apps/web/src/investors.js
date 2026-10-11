import { WEB_SEARCH_TOOL, callAnthropic, parseJSON } from "./ai.js";
import { categoryLabels } from "./profile.js";
import { bumpScored, loadInvestors, markScored, saveInvestors } from "./store.js";

// Investors: finding new ones with web search, normalizing records from any
// source, and scoring the list against the company profile.

// ---- investor discovery ----
export const INVESTORS_SCHEMA = {
  type: "object",
  properties: {
    investors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          firm: { type: "string" },
          type: { type: "string", description: "VC, Angel, Accelerator, Family Office." },
          website: { type: "string" },
          hq: { type: "string" },
          category: { type: "array", items: { type: "string" } },
          stages: { type: "array", items: { type: "string" } },
          check_size: { type: "string", description: "Verbatim from the source, or empty if not found." },
          thesis: { type: "string" },
          relevant_portfolio: { type: "array", items: { type: "string" } },
          best_partner: { type: "string", description: "Partner name if a source names one, else empty." },
          partner_title: { type: "string" },
          fit_score: { type: "integer", description: "1-99. How well this investor matches THIS company." },
          fit_rationale: {
            type: "string",
            description: "One sentence, grounded in something you actually read.",
          },
          sources: { type: "array", items: { type: "string" }, description: "URLs backing the above." },
        },
        required: [
          "firm",
          "type",
          "website",
          "hq",
          "category",
          "stages",
          "check_size",
          "thesis",
          "relevant_portfolio",
          "best_partner",
          "partner_title",
          "fit_score",
          "fit_rationale",
          "sources",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["investors"],
  additionalProperties: false,
};

export async function discoverInvestors(env, profile, categories, exclude) {
  // Confirmed categories win; otherwise fall back to what the analyzer labeled.
  // Either list may be bare strings (older rows, hand-added chips) or taxonomy
  // objects, so both go through categoryLabels.
  const confirmed = categoryLabels(categories);
  const cats = (confirmed.length ? confirmed : categoryLabels(profile.categories)).join(", ");
  // The analyzer's `gaps` are what the deck never answered. They go into the
  // search as open questions rather than facts so the researcher doesn't fill
  // them in from assumption, and so fit is scored against the proof this
  // company can actually show today.
  const gaps = (profile.gaps || []).slice(0, 8);
  const text = await callAnthropic(env, {
    system:
      "You are a fundraising researcher. Search the web to find real, currently-active investors that match the " +
      "company described. Rules: every investor must be one you actually found in a search result — never recall a " +
      "firm from memory and never invent a partner name, check size, or portfolio company. If you cannot verify a " +
      "field, return it empty. Prefer investors who lead at this stage and have visibly relevant portfolio companies. " +
      "Score fit against THIS company specifically, not the sector in general. " +
      "Anything listed under OPEN QUESTIONS is unproven — treat it as unknown, never as an established fact, and " +
      "favour investors who write checks at this level of proof over ones who would need those questions answered first.",
    content: [
      {
        type: "text",
        text: `Find 12-20 investors for this company.

COMPANY: ${profile.company || "(unnamed)"}
WHAT IT DOES: ${profile.one_liner || "n/a"}
STAGE: ${profile.stage || "n/a"}
RAISING: ${profile.raising || "n/a"}
BUSINESS MODEL: ${profile.business_model || "n/a"}
TRACTION: ${(profile.traction || []).join("; ") || "n/a"}
TARGET CATEGORIES: ${cats || "n/a"}
IDEAL INVESTOR: ${profile.ideal_investor || "n/a"}
${gaps.length ? `\nOPEN QUESTIONS — the deck does not answer these yet, so do not assume them:\n${gaps.map((g) => `- ${g}`).join("\n")}` : ""}

${exclude.length ? `Already in the pipeline — do not return these: ${exclude.join(", ")}` : ""}

Search for each category and stage combination. Return only investors you verified through search.`,
      },
    ],
    tools: [WEB_SEARCH_TOOL],
    schema: INVESTORS_SCHEMA,
    maxTokens: 16000,
    // Twelve searches plus a 16k structured payload measured ~150s of real
    // work, so 10 minutes is slack for a slow run while still bounding the
    // hang that left a job in 'searching' for half an hour.
    timeoutMs: 600000,
  });
  const parsed = parseJSON(text, null);
  return Array.isArray(parsed?.investors) ? parsed.investors : [];
}

// Normalizes a discovered or hand-added investor into the shape the CRM UI
// expects. Kept deliberately close to the original so index.html is unchanged.
export function normalizeInvestor(inv, source) {
  const cat = Array.isArray(inv.category)
    ? inv.category
    : inv.category
      ? String(inv.category)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  // Only known string fields survive: this object is stored and rendered, and
  // it can come straight from a browser.
  const partner =
    inv.best_partner && typeof inv.best_partner === "object"
      ? Object.fromEntries(
          ["name", "title", "focus", "linkedin", "twitter_x", "email"]
            .filter((k) => typeof inv.best_partner[k] === "string" && inv.best_partner[k].trim())
            .map((k) => [k, inv.best_partner[k].trim().slice(0, 300)]),
        )
      : null;
  return {
    id: (source === "discovered" ? "found-" : "custom-") + norm(inv.firm),
    firm: inv.firm,
    type: inv.type || "VC",
    tier: source === "discovered" ? "researched" : "custom",
    website: inv.website || "",
    hq: inv.hq || "",
    category: cat,
    stages: Array.isArray(inv.stages) && inv.stages.length ? inv.stages : ["Pre-seed", "Seed"],
    check_size: inv.check_size || "unknown",
    thesis: inv.thesis || "",
    relevant_portfolio: inv.relevant_portfolio || [],
    best_partner:
      partner || (inv.best_partner ? { name: inv.best_partner, title: inv.partner_title || "" } : {}),
    other_partners: [],
    fit_score: Math.max(1, Math.min(99, parseInt(inv.fit_score) || 70)),
    fit_rationale: inv.fit_rationale || "",
    // Already scored against THIS company: discovery reads the live web and
    // scores what it finds, and a hand-added firm is scored by the person
    // adding it. Only the bundled seed list arrives without an opinion.
    //
    // This flag is load-bearing, not decoration. Without it these rows read as
    // unscored and a later scoring run overwrites a researched score — built
    // from sources the model actually fetched — with a structural guess.
    scored: true,
    sources: Array.isArray(inv.sources) ? inv.sources : [],
  };
}

// ---- scoring an existing list against this company ----
//
// The seed list ships as facts about firms with no opinion attached: a fit
// score written for one company is misinformation for the next one. So every
// investor arrives unscored (fit_score 50, `scored: false`) and gets a number
// here, against THIS company's profile.
//
// Two passes, deliberately:
//
//   1. structuralScore() — local, free, instant, and applied to every firm. It
//      only knows what can be checked mechanically: does the sector overlap,
//      do they write at this stage, is the round the size they write into.
//   2. A model pass over the highest structural matches, which reads the thesis
//      and the portfolio and says something a filter cannot.
//
// Running the cheap pass over everything first is what makes the expensive one
// affordable: the model never reads the 600 firms that fail on stage alone.

export const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// The profile's categories come from a controlled taxonomy ("b2b-saas"); the
// list's are free text ("B2B SaaS"). Normalizing both to bare alphanumerics is
// what lets them meet.
export const catKeys = (list) => new Set((list || []).map(norm).filter(Boolean));

// "$3M", "3.5m", "raising $2-3M" -> 3000000. Returns null when there is no
// number to read, which the caller treats as "unknown", never as zero.
export function parseMoney(text) {
  const m = String(text || "").match(/\$?\s*([\d.]+)\s*([mkb])/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
  return n * mult;
}

// Stage vocabulary varies ("Pre-Seed", "preseed", "Seed / Series A"), so match
// on normalized substrings rather than equality.
export const STAGE_ALIASES = {
  preseed: ["preseed", "prese"],
  seed: ["seed"],
  seriesa: ["seriesa", "a"],
  seriesb: ["seriesb", "b"],
};

export function stageMatch(profileStage, investorStages) {
  const want = norm(profileStage);
  if (!want) return null; // unknown, not a mismatch
  const have = (investorStages || []).map(norm);
  if (!have.length) return null;
  // Direct containment covers almost everything: "seed" in "seed", "preseed"
  // in "preseed". Series A is the one that needs care, since a bare "a" would
  // match far too much.
  if (have.some((h) => h.includes(want) || want.includes(h))) return true;
  const aliases = STAGE_ALIASES[want] || [];
  return have.some((h) => aliases.some((a) => a.length > 1 && h.includes(a)));
}

// 1-99, weighted so that the things a founder would actually filter on
// dominate. Sector overlap is the heaviest because it is the one signal that is
// almost never wrong; check size is the lightest because the stored figure is
// often a rough public number.
export function structuralScore(inv, profileLabels, profile) {
  const invCats = catKeys(inv.category);
  const wanted = catKeys(profileLabels);
  let overlap = 0;
  for (const c of wanted) {
    // Substring both ways: "commerce" should meet "e-commerce", and "b2bsaas"
    // should meet "b2bsaasinfrastructure".
    if ([...invCats].some((i) => i.includes(c) || c.includes(i))) overlap++;
  }
  // Against min(4, wanted): a company with eight labels should not be penalised
  // for a fund that matches three of them well.
  const catFit = wanted.size ? Math.min(1, overlap / Math.min(4, wanted.size)) : 0.5;

  const stage = stageMatch(profile.stage, inv.stages);
  // null (unknown either side) sits between match and mismatch rather than
  // being scored as a failure — an absent field is not evidence.
  const stageFit = stage === null ? 0.6 : stage ? 1 : 0.15;

  const raise = parseMoney(profile.raising);
  let checkFit = 0.6; // unknown either side — neither credit nor penalty
  if (raise && inv.check_avg) {
    // Continuous rather than banded, and that is the point: three buckets left
    // hundreds of firms tied on the exact same score, so the top 100 handed to
    // the model was an arbitrary slice of a much larger tie. A smooth curve
    // orders them. It peaks where a fund writing 10-50% of the round sits, and
    // decays either side — too small to matter, or too large to be interested.
    const ratio = inv.check_avg / raise;
    const ideal = 0.3;
    // Distance in log space, so 3x too big and 3x too small are penalised
    // equally. A linear ratio would treat "half the round" as a near miss and
    // "twice the round" as a catastrophe.
    const d = Math.abs(Math.log(ratio / ideal));
    checkFit = Math.max(0.2, Math.min(1, 1 - d / 4));
  }

  const leadBonus = inv.leads_rounds === true ? 0.05 : 0;
  const raw = catFit * 0.55 + stageFit * 0.28 + checkFit * 0.17 + leadBonus;
  return Math.max(1, Math.min(99, Math.round(raw * 99)));
}

export const SCORES_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The investor id exactly as given." },
          fit_score: { type: "integer", description: "1-99. How well this investor fits THIS company." },
          fit_rationale: {
            type: "string",
            description: "One sentence, grounded in the firm's stated thesis or portfolio. No filler.",
          },
        },
        required: ["id", "fit_score", "fit_rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
};

// One batch of firms, scored in a single call. No web search: this pass reasons
// over the facts already stored, which is what keeps it cheap enough to run
// over hundreds of firms. Discovery is the pass that goes and reads the web.
export async function scoreBatch(env, profile, companyName, investors) {
  const brief = [
    `COMPANY: ${companyName || profile.company || "n/a"}`,
    `ONE-LINER: ${profile.one_liner || "n/a"}`,
    `PROBLEM: ${profile.problem || "n/a"}`,
    `STAGE: ${profile.stage || "n/a"}`,
    `RAISING: ${profile.raising || "n/a"}`,
    `BUSINESS MODEL: ${profile.business_model || "n/a"}`,
    `CATEGORIES: ${categoryLabels(profile.categories).join(", ") || "n/a"}`,
    `IDEAL INVESTOR: ${profile.ideal_investor || "n/a"}`,
  ].join("\n");

  const rows = investors.map((v) => ({
    id: v.id,
    firm: v.firm,
    type: v.type,
    hq: v.hq,
    stages: v.stages,
    check_size: v.check_size,
    category: v.category,
    thesis: v.thesis,
    portfolio: v.relevant_portfolio,
  }));

  const system = `You are scoring how well each investor fits one specific company. You know the venture landscape and you are not easily impressed.

Rules:
- Score 1-99. Use the whole range. A generalist seed fund with no stated interest in this space is a 40, not a 70.
- Judge fit for THIS company: sector, stage, check size, and what their portfolio says they actually back.
- The rationale must cite something concrete from the firm's thesis or portfolio. "Strong fit for this space" is worthless — name the reason.
- If the record is too thin to judge, score it low and say the record is thin. Do not invent a thesis for a firm you were given nothing about.
- Return exactly one entry per investor id you were given, using the id verbatim.`;

  const text = await callAnthropic(env, {
    system,
    content: [
      {
        type: "text",
        text: `${brief}\n\nScore each of these investors for this company:\n\n${JSON.stringify(rows)}`,
      },
    ],
    schema: SCORES_SCHEMA,
    maxTokens: 16000,
    timeoutMs: 300000,
  });
  const parsed = parseJSON(text, null);
  return Array.isArray(parsed?.scores) ? parsed.scores : [];
}

// How many firms the model pass reads, and how many go in each call. 25 keeps a
// batch's structured output comfortably inside maxTokens; going wider produced
// truncated JSON, which costs the whole batch rather than part of it.
export const SCORE_BATCH = 25;
export const SCORE_DEFAULT_TOP = 100;

// The whole run. Structural first over everything, then the model over the top
// slice, saving after each batch.
//
// Saving per batch rather than at the end is deliberate: a run that dies on
// batch seven keeps the six batches it paid for. The alternative loses them and
// bills again on the retry.
export async function runScoring(env, companyId, company, actor, top) {
  const investors = await loadInvestors(env, companyId);
  if (!investors.length) {
    await markScored(env, companyId, 0);
    return;
  }
  const profile = company.profile || {};
  const labels = categoryLabels(company.categories).length
    ? categoryLabels(company.categories)
    : categoryLabels(profile.categories);

  // Pass 1 — every firm, no model, no cost.
  const scored = investors.map((v) => ({ ...v, structural_score: structuralScore(v, labels, profile) }));
  // Indexed rather than scanned: a linear find() inside this loop is O(n²), and
  // n is the whole pipeline — 900 firms is 810,000 comparisons of CPU a Worker
  // has a hard budget for.
  const prior = new Map(investors.map((v) => [v.id, v]));
  const changed = [];
  for (const v of scored) {
    const before = prior.get(v.id);
    // `=== true`, not truthiness: a row written before this flag existed has
    // `scored: undefined`, and treating that as "unscored" is what let a
    // structural guess overwrite a researched score.
    //
    // For a genuinely unscored row the structural number IS the fit score until
    // the model gets to it — showing 50 for everything would leave the board
    // useless for however long the expensive pass runs.
    if (v.scored !== true) v.fit_score = v.structural_score;
    if (before.structural_score !== v.structural_score || before.fit_score !== v.fit_score) changed.push(v);
  }
  // Only rows that actually moved are written. A first run writes everything; a
  // re-run after a profile edit usually writes a handful, which keeps a repeat
  // scoring pass cheap instead of costing a full rewrite of the pipeline every
  // time.
  if (changed.length) await saveInvestorsBySource(env, companyId, changed, actor);

  // Pass 2 — the model, over the best structural matches only.
  const queue = [...scored].sort((a, b) => b.structural_score - a.structural_score).slice(0, top);
  const byId = new Map(scored.map((v) => [v.id, v]));
  let done = 0;
  for (let i = 0; i < queue.length; i += SCORE_BATCH) {
    const batch = queue.slice(i, i + SCORE_BATCH);
    let results = [];
    try {
      results = await scoreBatch(env, profile, company.name, batch);
    } catch (e) {
      // One failed batch is not a failed run. Losing 25 rationales is worth far
      // less than losing every batch already paid for, so record and continue.
      console.log("score batch failed:", e.message);
      continue;
    }
    const updated = [];
    for (const r of results) {
      const v = byId.get(r.id);
      if (!v) continue; // a hallucinated id refers to no firm we hold
      v.researcher_score = Math.max(1, Math.min(99, parseInt(r.fit_score) || v.structural_score));
      // The model read the thesis; the structural pass only counted overlaps.
      // Weighted toward the reader, but not blind to a hard stage mismatch.
      v.fit_score = Math.round(v.researcher_score * 0.75 + v.structural_score * 0.25);
      v.fit_rationale = String(r.fit_rationale || "").slice(0, 500);
      v.scored = true;
      updated.push(v);
    }
    if (updated.length) await saveInvestorsBySource(env, companyId, updated, actor);
    done += updated.length;
    await bumpScored(env, companyId, done);
  }
  await markScored(env, companyId, done);
}

// Writes a mixed set of investors back, one batch per provenance.
//
// The `source` column is per-statement, not per-row, so rows have to be grouped
// by it — a scoring pass must never relabel a hand-added firm as seeded.
// Statement width is handled inside saveInvestors (multi-row VALUES chunked to
// D1's parameter ceiling); there is deliberately no second layer of chunking
// here, which only added round trips.
//
// Sequential rather than Promise.all: three batched writes to one table have
// nothing to gain from overlapping, and concurrent batches are a transaction
// question nobody should have to think about while reading a scoring loop.
export async function saveInvestorsBySource(env, companyId, records, actor) {
  for (const src of ["seed", "discovered", "manual"]) {
    const of = records.filter((v) => provenance(v) === src);
    if (of.length) await saveInvestors(env, companyId, of, src, actor);
  }
}

// The storage column for a record, from its tier: both halves of the bundled
// list are "seed", research results are "discovered", the rest "manual".
export function provenance(v) {
  if (v.tier === "seed" || v.tier === "fund-list") return "seed";
  if (v.tier === "researched") return "discovered";
  return "manual";
}
