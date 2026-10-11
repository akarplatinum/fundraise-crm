// Anthropic Messages API adapter.
//
// The richest provider: it reads PDFs natively and runs web search and page
// fetching on Anthropic's side as server tools, so the Worker never browses.

export const label = "Anthropic";

export const capabilities = { pdf: true, webFetch: true, webSearch: true };

export const defaults = { baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-5-5" };

// The _20260209 tools filter results before they reach the context window.
// Do not also declare code_execution alongside them.
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 12 };
// web_fetch only opens URLs already in the conversation: the founder's URL, then
// links found on pages it fetched (which is how it reaches a linked deck).
const WEB_FETCH_TOOL = { type: "web_fetch_20260209", name: "web_fetch", max_uses: 12 };

export async function complete(cfg, req) {
  const content = [];
  // The document goes before the instruction, so the model reads the deck first.
  if (req.pdf) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: req.pdf },
    });
  }
  content.push({ type: "text", text: req.prompt });

  const tools = [];
  if (req.webSearch) tools.push(WEB_SEARCH_TOOL);
  if (req.fetchUrl) tools.push(WEB_FETCH_TOOL);

  const body = {
    model: cfg.model,
    max_tokens: req.maxTokens,
    // Every call here is a judgement call, so thinking earns its latency.
    // Current models reject temperature and budget_tokens; effort is the dial.
    thinking: { type: "adaptive" },
    output_config: { effort: req.effort || cfg.effort },
    messages: [{ role: "user", content }],
  };
  if (req.system) body.system = req.system;
  if (tools.length) body.tools = tools;
  if (req.schema) body.output_config.format = { type: "json_schema", schema: req.schema };

  // Server tools stop with pause_turn when they hit their iteration cap.
  // Resuming means re-sending with the assistant turn appended.
  let out = null;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${cfg.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`The model returned something unreadable (HTTP ${r.status}).`);
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    out = j;
    if (j.stop_reason !== "pause_turn") break;
    body.messages.push({ role: "assistant", content: j.content });
  }

  if (out?.stop_reason === "refusal") throw new Error("The model declined this request.");
  return (out?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
