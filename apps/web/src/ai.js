import * as anthropic from "./provider-anthropic.js";
import * as openai from "./provider-openai.js";
import { bumpUsage, getSettings } from "./store.js";

// The model layer. The app asks for one thing, complete(), in provider-neutral
// terms; an adapter per API turns that into a request. To add a provider, write
// a module with the same exports as provider-openai.js (label, capabilities,
// defaults, complete) and list it here. docs/models.md walks through it.
export const PROVIDERS = { anthropic, openai };

// Which provider, model and key this deploy uses. The Settings page (admin
// only) wins over Worker vars, so an owner can switch without a redeploy:
//
//   provider  settings.provider  > AI_PROVIDER  > "anthropic"
//   base URL  settings.base_url  > AI_BASE_URL  > the provider's default
//   API key   settings.api_key   > AI_API_KEY (or ANTHROPIC_API_KEY)
//   model     settings.model     > MODEL_ID     > the provider's default
//
// The key is read here and nowhere returns it; /api/settings shows its last
// four characters only.
export async function resolveModel(env) {
  const saved = (await getSettings(env)) || {};
  const provider = PROVIDERS[saved.provider]
    ? saved.provider
    : PROVIDERS[env.AI_PROVIDER]
      ? env.AI_PROVIDER
      : "anthropic";
  const { defaults, capabilities } = PROVIDERS[provider];
  const baseUrl = (saved.base_url || env.AI_BASE_URL || defaults.baseUrl).replace(/\/$/, "");
  // A key from the deploy's secrets only goes to the provider and URL the
  // deploy itself names. Pointing Settings somewhere else needs a key entered
  // there, so changing the base URL can never send the owner's key elsewhere.
  const deployProvider = PROVIDERS[env.AI_PROVIDER] ? env.AI_PROVIDER : "anthropic";
  const deployUrl = (env.AI_BASE_URL || PROVIDERS[deployProvider].defaults.baseUrl).replace(/\/$/, "");
  const secretKey =
    provider === deployProvider && baseUrl === deployUrl ? env.AI_API_KEY || env.ANTHROPIC_API_KEY || "" : "";
  const apiKey = saved.api_key || secretKey;
  const model = saved.model || (provider === deployProvider ? env.MODEL_ID : "") || defaults.model;
  return {
    provider,
    capabilities,
    apiKey,
    model,
    baseUrl,
    // How hard the model thinks. Below high, deck analyses come back shallow.
    // Only providers that support it use it.
    effort: saved.effort || "high",
    // Anthropic always needs a key; a self-hosted OpenAI-compatible server may
    // not, but every provider needs a model name.
    ready: !!model && (provider !== "anthropic" || !!apiKey),
  };
}

/**
 * One model call, the same for every provider.
 *
 *   system     instructions
 *   prompt     the user turn
 *   pdf        optional base64 PDF to read
 *   fetchUrl   optional URL the model may open, and follow links from
 *   webSearch  true if the model must search the web
 *   schema     optional JSON Schema the answer must match
 *   maxTokens, effort, timeoutMs
 *
 * Asking for something the provider cannot do (see its `capabilities`) is an
 * error. Callers check capabilities first and adapt, as analyzeProfile does.
 */
export async function complete(env, req) {
  // Resolved per call, so a change on the Settings page applies immediately.
  const cfg = await resolveModel(env);
  if (!cfg.ready) {
    const e = new Error("The AI model is not set up on this deploy. An admin can set it in Model settings.");
    e.status = 503;
    throw e;
  }
  const { capabilities } = cfg;
  if (req.webSearch && !capabilities.webSearch) throw unsupported(cfg, "web search");
  if (req.fetchUrl && !capabilities.webFetch) throw unsupported(cfg, "fetching web pages");
  if (req.pdf && !capabilities.pdf) throw unsupported(cfg, "reading PDFs");

  try {
    return await PROVIDERS[cfg.provider].complete(cfg, {
      maxTokens: 8000,
      timeoutMs: 300000,
      ...req,
    });
  } catch (e) {
    // This message reaches the founder verbatim through the job status.
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error("That took too long and was stopped. Try again.");
    }
    throw e;
  }
}

function unsupported(cfg, what) {
  const e = new Error(
    `This needs ${what}, which the ${cfg.provider} provider does not offer. Switch provider in Model settings to use it.`,
  );
  e.status = 409;
  return e;
}

// Per-user daily ceilings, counted in whole actions rather than tokens (an
// action is what a person recognises; a token is not). On a shared deploy this
// is what makes it safe to put one key behind many accounts. On a single-owner
// deploy it is still worth keeping: it is the difference between a bug that
// retries forever costing you a few dollars and costing you a few hundred.
//
// `score` is one whole scoring run over the seed list, not one firm — a run
// makes several batched model calls internally.
export const LIMITS = { deck: 5, discover: 6, intro: 60, critique: 5, score: 8 };

// ---- usage metering ----
export const utcDay = () => new Date().toISOString().slice(0, 10);

// Reserve one unit of quota. The counter increments before the comparison (see
// bumpUsage), so two concurrent requests can't both read "4 of 5 used" and both
// proceed. The limit itself is policy and stays here, not in the store.
export async function spend(env, username, kind) {
  const limit = LIMITS[kind] ?? 0;
  const count = await bumpUsage(env, username, utcDay(), kind);
  if (count > limit) {
    const e = new Error(`Daily limit reached for this action (${limit}/day). Resets at 00:00 UTC.`);
    e.status = 429;
    throw e;
  }
}

// Structured outputs constrain the response, but a pause_turn resume or a
// refusal can still hand back prose. Parse defensively rather than trusting it.
export function parseJSON(text, fallback) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  };
  let v = tryParse(text);
  if (v) return v;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && (v = tryParse(fenced[1].trim()))) return v;
  const first = text.indexOf("{"),
    last = text.lastIndexOf("}");
  if (first >= 0 && last > first && (v = tryParse(text.slice(first, last + 1)))) return v;
  return fallback;
}

// btoa() on a whole deck blows the stack via String.fromCharCode(...arr) —
// the spread pushes one argument per byte. Chunk it.
export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
