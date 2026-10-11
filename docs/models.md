# Using your own model

The app talks to models through a small adapter per API. Two ship with it:

| Provider              | Covers                                                                                                                                                                  | Reads PDFs         | Opens websites                        | Searches the web |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------- | ---------------- |
| `anthropic` (default) | Anthropic's API                                                                                                                                                         | yes                | yes, and follows links to a deck      | yes              |
| `openai`              | anything that speaks the OpenAI Chat Completions API: OpenAI, OpenRouter, Together, Groq, Fireworks, and self-hosted servers like Ollama, vLLM, LM Studio and llama.cpp | if the server does | the app reads the landing page for it | no               |

What changes with a provider that cannot do everything:

- **No web search:** **Find investors** is switched off, and says why. Scoring
  the bundled list, deck analysis, critiques and drafts all work.
- **No browsing:** when you give a website, the app fetches the landing page
  itself and hands the model its text. It cannot follow a link to a deck, so
  upload the deck as a PDF if you have one.
- **No PDF reading:** many self-hosted servers cannot read PDFs. Use the
  website path, or a server or model that accepts files.

Every call in this app is a judgement call: reading a deck, ranking a fund
against a thesis. Small local models produce noticeably weaker profiles and
scores. Use the strongest model you can run.

## Choosing a provider

Either set it once in the browser, on **Model settings** (admin only), or set
it for the deploy with these variables. Settings wins when both are set.

| Variable      | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `AI_PROVIDER` | `anthropic` or `openai`                                               |
| `AI_BASE_URL` | the API root, ending in `/v1`; leave unset for the provider's default |
| `AI_API_KEY`  | the key; `ANTHROPIC_API_KEY` also works                               |
| `MODEL_ID`    | the model name the server expects; required for `openai`              |

### Examples

```bash
# Anthropic (the default)
AI_API_KEY=sk-ant-... npm run dev

# OpenAI
AI_PROVIDER=openai AI_API_KEY=sk-... MODEL_ID=gpt-5 npm run dev

# OpenRouter: any model it lists
AI_PROVIDER=openai AI_BASE_URL=https://openrouter.ai/api/v1 AI_API_KEY=sk-or-... \
  MODEL_ID=meta-llama/llama-3.3-70b-instruct npm run dev

# Ollama on your own machine, no key
AI_PROVIDER=openai AI_BASE_URL=http://localhost:11434/v1 MODEL_ID=llama3.3:70b npm run dev

# vLLM or any other self-hosted server
AI_PROVIDER=openai AI_BASE_URL=http://my-gpu-box:8000/v1 MODEL_ID=my-finetune npm run dev
```

The same variables work with `npm run deploy`, which stores them as Cloudflare
secrets. A deployed app runs on Cloudflare, so a self-hosted model must be
reachable from the internet (behind a tunnel such as Cloudflare Tunnel, for
example), not just from your laptop.

### Where a key is allowed to go

A key from the deploy's secrets is only ever sent to the provider and base URL
the deploy itself names. If you point Model settings at a different provider or
URL, enter a key there too. That way nobody with access to the Settings page
can redirect your key to a server of their choosing.

## Adding a provider

If your model speaks the OpenAI dialect, use `openai` and stop here. For
anything else (a different API shape, a gateway with its own auth), write an
adapter.

1. Copy `apps/web/src/provider-openai.js` to `provider-<name>.js`. It exports
   four things:

   ```js
   export const label = "My provider"; // shown in Model settings
   export const capabilities = { pdf: false, webFetch: false, webSearch: false };
   export const defaults = { baseUrl: "https://...", model: "" };
   export async function complete(cfg, req) {
     /* return the model's text */
   }
   ```

2. `complete(cfg, req)` gets the resolved config and one request:

   | `cfg`                                  | `req`                                                                                                                                                                                                                           |
   | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `apiKey`, `baseUrl`, `model`, `effort` | `system`, `prompt`, `maxTokens`, `timeoutMs` (pass it to `AbortSignal.timeout`), and, only if your capabilities allow it, `pdf` (base64), `fetchUrl`, `webSearch`. When `schema` is set, return JSON matching that JSON Schema. |

   Return the text of the answer. Throw an `Error` with a readable message on
   failure; it is shown to the founder.

3. Register it in `apps/web/src/ai.js`:

   ```js
   import * as mine from "./provider-mine.js";
   export const PROVIDERS = { anthropic, openai, mine };
   ```

It then appears in Model settings and works with `AI_PROVIDER=mine`. Add a
check to `apps/web/test/smoke.js` that fakes your endpoint, the way the
`openai` one does.

Declare capabilities honestly. The app checks them before calling and adapts
(reading the website itself, switching discovery off). Claiming one you do not
support produces a confusing failure in place of a clear message.
