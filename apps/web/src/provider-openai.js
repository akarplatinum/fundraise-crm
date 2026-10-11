// OpenAI-compatible Chat Completions adapter.
//
// The common dialect of hosted and self-hosted models: OpenAI, OpenRouter,
// Together, Groq, Fireworks, and local servers such as Ollama, vLLM and LM
// Studio. Point AI_BASE_URL (or the Settings page) at the server's /v1 root.
//
// It has no built-in browsing, so the app fetches websites itself before
// calling, and investor discovery (which needs live web search) is off.

export const label = "OpenAI-compatible (OpenAI, OpenRouter, Ollama, vLLM, LM Studio...)";

export const capabilities = { pdf: true, webFetch: false, webSearch: false };

// No default model: there is no sensible one across every server this covers.
export const defaults = { baseUrl: "https://api.openai.com/v1", model: "" };

export async function complete(cfg, req) {
  // PDFs go as a file part. OpenAI and OpenRouter accept them; many local
  // servers do not, and their error is passed through as-is.
  const user = req.pdf
    ? [
        { type: "file", file: { filename: "deck.pdf", file_data: `data:application/pdf;base64,${req.pdf}` } },
        { type: "text", text: req.prompt },
      ]
    : req.prompt;

  // The schema goes in the prompt as well as response_format, because some
  // servers ignore response_format. The caller's JSON parser is forgiving.
  const system = req.schema
    ? `${req.system || ""}\n\nRespond with only a JSON object that matches this JSON Schema:\n${JSON.stringify(req.schema)}`
    : req.system;

  const body = {
    model: cfg.model,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
    max_completion_tokens: req.maxTokens,
  };
  if (req.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: req.schema, strict: false },
    };
  }

  const send = () =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Local servers usually need no key.
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });

  let r = await send();
  let j = await r.json().catch(() => null);
  // A server that does not support structured output rejects the request; the
  // schema is already in the prompt, so retry without it.
  if (r.status === 400 && body.response_format && /response_format|json_schema/i.test(JSON.stringify(j))) {
    delete body.response_format;
    r = await send();
    j = await r.json().catch(() => null);
  }
  if (!j) throw new Error(`The model returned something unreadable (HTTP ${r.status}).`);
  if (!r.ok) throw new Error(j.error?.message || j.message || `HTTP ${r.status}`);

  const choice = j.choices?.[0];
  if (choice?.finish_reason === "content_filter") throw new Error("The model declined this request.");
  const content = choice?.message?.content;
  // Some servers return content as an array of text parts.
  return (Array.isArray(content) ? content.map((p) => p.text || "").join("") : content || "").trim();
}
