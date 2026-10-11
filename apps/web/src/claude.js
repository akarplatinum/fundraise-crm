import { bumpUsage, getSettings } from "./store.js";

// The Anthropic API: which model and key this deploy uses, the one function
// that calls it, and the per-user daily limits that bound what any account can
// spend.

// The default model. Overridable per deploy without touching code: MODEL_ID as
// a Worker var, or the model field on the Settings page (which wins). Opus is
// the right default here because every call in this app is a judgement call —
// reading a deck, ranking a fund against a thesis — not a formatting task.
export const DEFAULT_MODEL = "claude-opus-5-5";

// Where the model credentials come from, in order of precedence:
//
//   1. The `settings` row written by the Settings page (owner-only).
//   2. The ANTHROPIC_API_KEY / MODEL_ID Worker secrets and vars.
//
// The settings row wins so an owner can rotate a key from the browser without a
// redeploy. Either way the key is read server-side and never serialized into a
// response — see /api/settings, which returns only a masked tail.
export async function resolveModel(env) {
  const saved = (await getSettings(env)) || {};
  return {
    apiKey: saved.api_key || env.ANTHROPIC_API_KEY || "",
    model: saved.model || env.MODEL_ID || DEFAULT_MODEL,
    // Effort trades tokens for thoroughness. `high` is the default for a reason:
    // at `low` the deck analyses come back shallow enough that the profile is
    // worse than the deck it was read from.
    effort: saved.effort || "high",
  };
}

// Server-tool version for investor discovery. The _20260209 variants carry
// built-in dynamic filtering, so results are filtered before they hit the
// context window — do NOT also declare code_execution alongside it.
export const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 12 };

// Used when a founder gives a site URL instead of (or alongside) a deck.
//
// web_fetch only fetches URLs already present in the conversation. The founder's
// URL arrives in the user turn; links found *in* that fetched page are then in
// the conversation too, which is what lets the model follow a "download our
// deck" link one hop out. It still cannot wander to a URL that never appeared.
//
// max_uses is the landing page plus roughly a deck and a handful of subpages.
export const WEB_FETCH_TOOL = { type: "web_fetch_20260209", name: "web_fetch", max_uses: 12 };

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

// ---- Anthropic ----
//
// Raw fetch rather than @anthropic-ai/sdk, because the Worker has no bundler.
// timeoutMs applies to each HTTP request (the pause_turn loop may make several):
// without it, a hung request would leave a background job running forever.
export async function callAnthropic(
  env,
  { system, content, tools, schema, maxTokens = 8000, effort, timeoutMs = 300000 },
) {
  // Resolved per call rather than at module load: a key saved on the Settings
  // page must take effect on the next request, not the next deploy. It costs
  // one indexed D1 read against a call that runs for seconds.
  const cfg = await resolveModel(env);
  if (!cfg.apiKey) throw new Error("no_api_key");

  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    // These are judgement tasks — reading a deck, ranking a fund against a
    // thesis — so thinking earns its latency. `budget_tokens` and `temperature`
    // are rejected on current models; effort is the depth control.
    thinking: { type: "adaptive" },
    output_config: { effort: effort || cfg.effort },
    messages: [{ role: "user", content }],
  };
  if (system) body.system = system;
  if (tools) body.tools = tools;
  if (schema) body.output_config.format = { type: "json_schema", schema };

  // Server tools run their own sampling loop and stop with pause_turn when it
  // hits the iteration cap. Resuming is just re-sending with the assistant turn
  // appended — no extra user message, or the model treats it as new input.
  const messages = body.messages;
  let out = null;
  for (let i = 0; i < 4; i++) {
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ ...body, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Surfaced as a plain sentence because it reaches the founder verbatim
      // through markFailed / markDiscoverFailed.
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new Error("That took too long and was stopped. Try again.");
      }
      throw e;
    }
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch (_) {
      throw new Error("bad_response: " + text.slice(0, 300));
    }
    if (r.status >= 400) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    out = j;
    if (j.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: j.content });
  }

  if (out?.stop_reason === "refusal") throw new Error("The model declined this request.");
  return (out?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
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
