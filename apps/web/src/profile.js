import { WEB_FETCH_TOOL, callAnthropic, parseJSON } from "./claude.js";

// Turning a deck or a website into a company profile: the model call, the
// closed category taxonomy it labels against, and the stage-relative deck score.

// Deck upload / re-analysis is the multi-tenant onboarding path. A single-tenant
// deploy with a hand-curated profile turns it off (DECK_UPLOAD=off) so nobody
// can overwrite that profile by uploading a deck. Default on: the white-label
// template behaves exactly as before unless a deploy opts out.
export const deckUploadEnabled = (env) => String(env.DECK_UPLOAD ?? "on").toLowerCase() !== "off";
export const DECK_OFF_MSG = "Deck upload is off on this instance. The profile is managed directly.";

// Anthropic caps PDF documents at 32MB / 600 pages. We stop well short: a deck
// is slides, and a 20MB "deck" is a signal something else got uploaded.
export const MAX_DECK_BYTES = 20 * 1024 * 1024;

// ---- labeling: taxonomy ----
//
// A closed vocabulary: the model picks from it, and anything it returns that
// isn't here is dropped. Free-form tags would make "B2B SaaS" and "b2b-saas"
// two categories, and categories drive discovery and scoring.
//
// Three axes because they answer different investor questions — what market
// (sector), how the money works (model), and how it reaches customers (gtm). A
// fund's thesis is usually a sector plus a model, so tagging both is what makes
// the discovery query specific instead of generic.
export const TAXONOMY = {
  sector: [
    "fintech",
    "healthtech",
    "biotech",
    "climate",
    "energy",
    "enterprise-software",
    "devtools",
    "security",
    "data-infra",
    "ai-ml",
    "consumer",
    "social",
    "commerce",
    "logistics",
    "supply-chain",
    "proptech",
    "insurtech",
    "legaltech",
    "hrtech",
    "edtech",
    "govtech",
    "agtech",
    "manufacturing",
    "robotics",
    "hardware",
    "semiconductors",
    "space",
    "defense",
    "mobility",
    "traveltech",
    "gaming",
    "media",
    "creator-economy",
    "fitness",
    "food",
    "retail-tech",
    "martech",
    "salestech",
    "fintech-infra",
    "crypto",
    "web3",
  ],
  model: [
    "saas",
    "b2b-saas",
    "b2c-subscription",
    "marketplace",
    "transactional",
    "usage-based",
    "hardware-sales",
    "hardware-plus-saas",
    "licensing",
    "ad-supported",
    "commission",
    "interchange",
    "lending",
    "insurance-premium",
    "services",
    "open-source-commercial",
    "api-platform",
  ],
  gtm: [
    "plg",
    "sales-led",
    "enterprise-sales",
    "smb-self-serve",
    "channel-partner",
    "community-led",
    "direct-to-consumer",
    "embedded-distribution",
    "bottoms-up",
    "procurement-led",
  ],
};
export const TAXONOMY_AXES = Object.keys(TAXONOMY);
export const ALL_LABELS = new Set(TAXONOMY_AXES.flatMap((a) => TAXONOMY[a]));

// Older rows (and the confirmed-categories column) store bare strings; the
// analyzer now stores {label, axis, confidence, evidence}. Everything
// downstream — discovery, the edit endpoint, the UI — goes through here so a
// company profiled before this change keeps working untouched.
export function categoryLabels(cats) {
  if (!Array.isArray(cats)) return [];
  return cats
    .map((c) => (typeof c === "string" ? c : c && c.label))
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim());
}

// Keep only labels that are actually in the taxonomy, on the axis the model
// claimed. A hallucinated label is worse than a missing one: it silently
// widens the discovery query with a term no fund describes itself by.
export function validateCategories(raw) {
  const seen = new Set();
  const kept = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c !== "object") continue;
    const label = String(c.label || "")
      .trim()
      .toLowerCase();
    const axis = String(c.axis || "")
      .trim()
      .toLowerCase();
    if (!ALL_LABELS.has(label) || !TAXONOMY[axis] || !TAXONOMY[axis].includes(label)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    kept.push({
      label,
      axis,
      confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0)),
      evidence: String(c.evidence || "").slice(0, 300),
    });
  }
  return kept.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

// ---- labeling: deck score ----
//
// The model scores each dimension 0-5 against evidence it has to cite. The
// weighting and the overall number are computed here, in plain JS, rather than
// asked for — a model asked for an overall score anchors on the vibe of the
// deck and the dimensions become decoration. This way the arithmetic is
// deterministic and the same deck scores the same twice.
export const RUBRIC = [
  { key: "clarity", label: "Clarity", ask: "Can a partner state what this company does after slide 1?" },
  { key: "problem", label: "Problem", ask: "Is the pain specific, urgent, and someone's budget line?" },
  {
    key: "differentiation",
    label: "Differentiation",
    ask: "Is it clear why this wins over named incumbents?",
  },
  { key: "market", label: "Market", ask: "Is the market sized bottom-up and plausibly venture-scale?" },
  { key: "traction", label: "Traction", ask: "Are there real metrics with a trend, not just logos?" },
  { key: "team", label: "Team", ask: "Is there earned insight or unfair advantage for THIS problem?" },
  {
    key: "business_model",
    label: "Business model",
    ask: "Is it clear how revenue is earned and whether unit economics work?",
  },
  { key: "ask", label: "The ask", ask: "Is the raise amount, use of funds, and next milestone stated?" },
];
export const RUBRIC_KEYS = RUBRIC.map((d) => d.key);

// Weights shift by stage because the same gap means different things at
// different points. A pre-seed deck with no revenue is normal and should not be
// marked down for it; a Series A deck with no revenue is the whole story. Team
// and market carry the weight early, traction and economics carry it later.
export const STAGE_WEIGHTS = {
  "pre-seed": {
    clarity: 1.2,
    problem: 1.3,
    differentiation: 1.0,
    market: 1.2,
    traction: 0.4,
    team: 1.5,
    business_model: 0.7,
    ask: 0.9,
  },
  seed: {
    clarity: 1.2,
    problem: 1.2,
    differentiation: 1.1,
    market: 1.1,
    traction: 1.0,
    team: 1.3,
    business_model: 0.9,
    ask: 1.0,
  },
  "series-a": {
    clarity: 1.0,
    problem: 0.9,
    differentiation: 1.2,
    market: 1.1,
    traction: 1.8,
    team: 1.0,
    business_model: 1.4,
    ask: 1.0,
  },
  "series-b": {
    clarity: 1.0,
    problem: 0.8,
    differentiation: 1.2,
    market: 1.1,
    traction: 2.0,
    team: 0.9,
    business_model: 1.6,
    ask: 1.0,
  },
};

// Free-text stage ("Seed round", "raising our A") onto a weight profile.
// Unrecognized or absent stage falls back to seed, the most common case here
// and the least opinionated of the four.
export function stageKey(stage) {
  const s = String(stage || "").toLowerCase();
  if (/pre-?seed|angel|friends/.test(s)) return "pre-seed";
  if (/series\s*b|\bb\b.*round|round.*\bb\b/.test(s)) return "series-b";
  if (/series\s*a|\ba\b.*round|round.*\ba\b/.test(s)) return "series-a";
  return "seed";
}

export function scoreBand(overall) {
  if (overall >= 4.2) return "Strong — this reads like a deck that gets second meetings";
  if (overall >= 3.4) return "Fundable — the story lands, some slides need work";
  if (overall >= 2.5) return "Needs work — a partner will stall on the gaps below";
  return "Early — the core narrative isn't on the page yet";
}

// rubric[] from the model + stage -> overall, band, and per-dimension detail.
// Dimensions the model skipped are dropped rather than scored zero: a missing
// judgement is not the same as a bad one, and zero-filling would punish a deck
// for the analyzer's omission.
export function scoreDeck(rubricRaw, stage) {
  const key = stageKey(stage);
  const weights = STAGE_WEIGHTS[key];
  const byKey = new Map();
  for (const r of Array.isArray(rubricRaw) ? rubricRaw : []) {
    if (!r || !RUBRIC_KEYS.includes(r.dimension)) continue;
    const score = Number(r.score);
    if (!Number.isFinite(score)) continue;
    byKey.set(r.dimension, {
      dimension: r.dimension,
      // Defaulted: the schema constrains `dimension` to RUBRIC_KEYS, but a
      // resumed or partially-refused turn has been seen to return prose, and
      // reading .label off undefined would take down the whole analysis over
      // one bad row.
      label: (RUBRIC.find((d) => d.key === r.dimension) || {}).label || r.dimension,
      score: Math.max(0, Math.min(5, Math.round(score))),
      evidence: String(r.evidence || "").slice(0, 400),
      fix: String(r.fix || "").slice(0, 400),
      weight: weights[r.dimension],
    });
  }
  const dims = RUBRIC_KEYS.map((k) => byKey.get(k)).filter(Boolean);
  if (!dims.length) return null;

  const totalWeight = dims.reduce((n, d) => n + d.weight, 0);
  const overall = dims.reduce((n, d) => n + d.score * d.weight, 0) / totalWeight;
  const rounded = Math.round(overall * 10) / 10;

  return {
    overall: rounded,
    band: scoreBand(rounded),
    stage_basis: key,
    // Weakest-first, weighted: what costs the most at THIS stage surfaces
    // first, so the fix list is ordered by what a partner will hit hardest.
    dimensions: dims.slice().sort((a, b) => a.score - b.score || b.weight - a.weight),
  };
}

// ---- deck analysis ----
export const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string", description: "Company name as it appears in the deck." },
    one_liner: { type: "string", description: "One sentence: what the company does, for whom." },
    problem: { type: "string" },
    solution: { type: "string" },
    stage: { type: "string", description: "Pre-seed, Seed, Series A, etc. as stated or implied." },
    raising: { type: "string", description: "Amount being raised, verbatim if stated, else empty." },
    traction: {
      type: "array",
      items: { type: "string" },
      description: "Concrete metrics only. Never invent numbers.",
    },
    business_model: { type: "string" },
    categories: {
      type: "array",
      description:
        "3-6 labels drawn ONLY from the supplied taxonomy. Cover the sector axis at minimum; add model and " +
        "gtm labels where the source states them. Do not invent labels — use custom_tags for anything the " +
        "taxonomy cannot express.",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Exact label from the taxonomy, verbatim." },
          axis: { type: "string", enum: TAXONOMY_AXES, description: "Which axis the label came from." },
          confidence: {
            type: "number",
            description:
              "0-1. How firmly the source supports this label. Below 0.5 means you are inferring it rather " +
              "than reading it.",
          },
          evidence: { type: "string", description: "The specific line or slide that supports it. Quote it." },
        },
        required: ["label", "axis", "confidence", "evidence"],
        additionalProperties: false,
      },
    },
    custom_tags: {
      type: "array",
      items: { type: "string" },
      description:
        "At most 2 free-form tags for something genuinely outside the taxonomy. Leave empty unless the " +
        "taxonomy actually fails to describe the company.",
    },
    rubric: {
      type: "array",
      description:
        "Score every dimension listed in the instructions. One entry each, no extras, no omissions.",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string", enum: RUBRIC_KEYS },
          score: {
            type: "integer",
            description:
              "0-5. 0 = absent from the deck. 1-2 = present but a partner would stall on it. 3 = adequate. " +
              "4 = clearly done. 5 = a genuine strength. Judge against what is normal FOR THIS STAGE.",
          },
          evidence: {
            type: "string",
            description: "What the source actually says here. Quote or cite the slide.",
          },
          fix: {
            type: "string",
            description: "One concrete change that would raise this score. Empty if score is 5.",
          },
        },
        required: ["dimension", "score", "evidence", "fix"],
        additionalProperties: false,
      },
    },
    competitors: {
      type: "array",
      description:
        "Companies the source names as competitors or comparables. Only ones the material actually names — " +
        "do not supply a market map from memory.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          note: { type: "string", description: "One clause on how they overlap or differ, from the source." },
        },
        required: ["name", "note"],
        additionalProperties: false,
      },
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "Search terms for finding matching investors.",
    },
    ideal_investor: { type: "string", description: "One sentence on the kind of investor that fits." },
    gaps: {
      type: "array",
      items: { type: "string" },
      description: "What a partner would ask that the deck does not answer.",
    },
  },
  required: [
    // Every property is listed: with additionalProperties:false the schema is
    // strict, and a property that is optional there comes back inconsistently.
    // An empty array is a fine answer; a missing key is not.
    "company",
    "one_liner",
    "problem",
    "solution",
    "stage",
    "raising",
    "traction",
    "business_model",
    "categories",
    "custom_tags",
    "rubric",
    "competitors",
    "keywords",
    "ideal_investor",
    "gaps",
  ],
  additionalProperties: false,
};

// Reject anything that isn't a plain http(s) URL before it reaches the model.
// The fetch happens on Anthropic's side, not ours, so this is not an SSRF guard
// for our own network — it's to fail a typo'd or non-web URL here with a clear
// message rather than burning a quota unit discovering it.
export function normalizeSiteUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s);
  } catch (_) {
    throw Object.assign(new Error("That doesn't look like a valid website address."), { status: 400 });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw Object.assign(new Error("Website must be an http:// or https:// address."), { status: 400 });
  }
  if (!u.hostname.includes(".")) {
    throw Object.assign(new Error("That doesn't look like a valid website address."), { status: 400 });
  }
  return u.toString();
}

// Builds the profile from a deck, a site URL, or both. Either source alone is
// enough: plenty of pre-deck founders have a live site, and for those who have
// both the site is usually more current than the deck — so when they disagree,
// the prompt tells the model to prefer the site and note the discrepancy as a
// gap rather than silently picking one.
export async function analyzeProfile(env, { pdfBase64 = "", siteUrl = "" } = {}) {
  if (!pdfBase64 && !siteUrl) throw new Error("Nothing to analyze.");

  const sources = [pdfBase64 && "a pitch deck", siteUrl && "the company's website"].filter(Boolean);
  const content = [];
  // The document block goes before the text block — the model reads the
  // deck, then the instruction about what to do with it.
  if (pdfBase64) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
    });
  }
  content.push({
    type: "text",
    text: siteUrl
      ? `Extract the fundraising profile for this company. Fetch and read ${siteUrl} first.\n\n` +
        "Then follow links from that page, in this order of priority:\n" +
        "1. A pitch deck, investor deck, or fundraising one-pager — often a PDF, a link labelled " +
        "'deck'/'investors'/'raise'/'pitch', or a Docsend/Notion/Drive link. If you find one, fetch and read it. " +
        "It is the single highest-value source here and usually the only place stage, raise amount, and traction " +
        "metrics appear.\n" +
        "2. About, team, product, pricing, and customer pages.\n\n" +
        "If a deck link exists but cannot be fetched (login wall, Docsend gate, dead link), say so in `gaps` " +
        "rather than guessing at what it contained." +
        (pdfBase64 ? "\n\nTheir pitch deck is also attached above; read it as well." : "")
      : "Extract the fundraising profile for this deck.",
  });

  const call = () =>
    callAnthropic(env, {
      system:
        `You extract a structured fundraising profile from ${sources.join(" and ")}. ` +
        "Report only what the source material actually says. If a field is absent, return an empty string or empty " +
        "array — never infer a metric, a raise amount, or a customer that is not stated. `gaps` is where you note what " +
        "is missing. A website on its own rarely states stage or raise amount — if you did not find a linked deck, " +
        "leave those empty rather than guessing. " +
        "Where the deck and the website disagree, prefer the website (it is usually more current) and record the " +
        "discrepancy in `gaps`.\n\n" +
        "CATEGORY TAXONOMY — `categories.label` must be one of these, verbatim:\n" +
        TAXONOMY_AXES.map((a) => `${a}: ${TAXONOMY[a].join(", ")}`).join("\n") +
        "\n\nSCORING — return one `rubric` entry for each of these dimensions:\n" +
        RUBRIC.map((d) => `${d.key} — ${d.ask}`).join("\n") +
        "\n\nScore against what is normal for this company's stage, not against an ideal Series B deck: a " +
        "pre-seed deck with no revenue is not thereby a 0 on traction, it is a 0 only if it makes claims it " +
        "cannot support. Score what is on the page — a dimension you cannot assess because the source omits it " +
        "is a low score with `evidence` saying it is absent, not a guess at what they probably meant. Do not " +
        "return an overall score; the dimensions are combined elsewhere.",
      content,
      tools: siteUrl ? [WEB_FETCH_TOOL] : undefined,
      schema: PROFILE_SCHEMA,
      maxTokens: 8000,
    });

  // Retrieval is flaky in a specific way: roughly one run in six comes back
  // schema-valid but empty — every field blank — because the model correctly
  // declines to invent anything when the fetch degraded. Measured on one deck
  // URL, five of six attempts produced a full 14/14 profile, so a single retry
  // converts almost all of those misses. It costs no quota: spend() is called
  // once by the route, outside this function.
  let profile = parseJSON(await call(), null);
  if (!profile || !profile.one_liner) {
    profile = parseJSON(await call(), null);
  }

  if (!profile || !profile.one_liner) {
    // Do not blame the source. Two attempts returning nothing usable is far
    // more often flaky retrieval than a genuinely unreadable page, and the old
    // wording sent founders to re-check a site that was never the problem.
    throw new Error(
      siteUrl && !pdfBase64
        ? "Could not get a profile back from that page — the read came back empty twice. Try again, or link a deck directly."
        : "Could not read a profile out of that deck. Try again, or upload a different export.",
    );
  }

  // Labels are validated against the taxonomy and the score is computed here,
  // not trusted from the model. Both are stored on the profile blob, so no
  // schema migration is needed and a company profiled before this change just
  // has neither field.
  profile.categories = validateCategories(profile.categories);
  profile.custom_tags = (Array.isArray(profile.custom_tags) ? profile.custom_tags : [])
    .map((t) =>
      String(t || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .slice(0, 2);
  profile.deck_score = scoreDeck(profile.rubric, profile.stage);
  delete profile.rubric; // it lives inside deck_score.dimensions now, weighted

  return profile;
}
