# Fundraise CRM

A CRM for founders raising a pre-seed or seed round. Give it your deck and it
ranks 1,715 investors against what you are building, then runs the raise:
pipeline, intro tracking, drafts in your voice, and email sent from your own
mailbox with your deck attached.

You host it yourself, on Cloudflare's free tier, with whichever AI model you
choose: Anthropic, OpenAI, OpenRouter, or a model you run yourself through
Ollama, vLLM or any OpenAI-compatible server. See [docs/models.md](docs/models.md).

- **Your deck in, a profile out.** Upload a PDF or point it at your website.
  The AI writes a company profile (stage, raise, traction, categories) and a
  blunt deck critique.
- **1,715 investors to start with.** Funds, micro-VCs and angels, each with
  thesis, stages, check size, portfolio, and a named partner for 1,673 of
  them. See [data/README.md](data/README.md).
- **Scored against you, not someone else.** The list arrives unscored. One click
  scores every firm on sector, stage and check size, then has the AI read the
  top 100 theses against your profile.
- **A pipeline you will actually use.** Kanban stages from first contact to
  signed, an intro map of who can introduce you to whom, and a round builder
  that shows how far your pipeline gets you to your target.
- **Email from your own address.** Draft an intro, edit it, queue it. A small
  mailer sends it through Gmail, iCloud, Fastmail, Zoho or any SMTP server, so
  replies land in your inbox like any other email.

## Get started

Fork this repo, clone your fork, then:

```bash
AI_API_KEY=sk-ant-... npm run dev      # run it on your machine, with Anthropic
```

That runs `apps/web/setup.sh local`, which needs Node 18+ and no Cloudflare
account. It creates your account, loads the
investor list, prints your password once, and serves the app at
<http://localhost:4318>. Sign in, upload your deck, and click **Score against my
deck** on the Directory.

To put it on the internet:

```bash
npx wrangler login                            # once; opens a browser
AI_API_KEY=sk-ant-... npm run deploy   # creates the database, sets secrets, deploys
```

It is safe to re-run after a failure. `npm run doctor` diagnoses an install
without changing anything.

Then set up email: [docs/email.md](docs/email.md). It takes about ten minutes
and runs on GitHub Actions in your fork, so there is no server to keep up.

To use a different model, set `AI_PROVIDER`, `AI_BASE_URL` and `MODEL_ID` as
well; for example, a local Ollama model needs no key:

```bash
AI_PROVIDER=openai AI_BASE_URL=http://localhost:11434/v1 MODEL_ID=llama3.3:70b npm run dev
```

[docs/models.md](docs/models.md) covers each provider, what works with each,
and how to add your own.

## What it costs

Cloudflare Pages and D1 fit inside the free plan. The mailer's GitHub Actions
runs are free on a public fork; a private fork should run it less often (see
[docs/email.md](docs/email.md#on-github-actions-recommended)). The bill that
scales is your model provider, paid per use on your key, or nothing if you run
the model yourself. Investor discovery uses web search and costs the most of
any action. Every model action has a daily limit
per user; see [docs/customizing.md](docs/customizing.md#model-and-spend).

## The repo

```
apps/web/      the CRM: a Cloudflare Pages app with a D1 database
apps/mailer/   sends queued email over SMTP; no dependencies
data/          the investor list
docs/          email setup, customizing, how it works
```

It is an npm workspace with no runtime dependencies. The server code is plain
ES modules with no framework and no bundler. The UI is HTML, CSS and JavaScript
with no build step.

```bash
npm test       # both apps; needs Node 22+
```

## Docs

- [docs/models.md](docs/models.md): choosing a model, self-hosting one, adding a provider
- [docs/email.md](docs/email.md): sending from your own mailbox, provider by provider
- [docs/customizing.md](docs/customizing.md): name and colors, pipeline stages, prompts, limits, accounts
- [docs/how-it-works.md](docs/how-it-works.md): design notes, limits, and what the tests cover
- [data/README.md](data/README.md): what the investor list is, where it came from, and how to use your own
- [AGENTS.md](AGENTS.md): instructions for an AI agent setting this up for you

## Before you rely on it

The investor records are point-in-time research from 2026. Partners move and
funds close, so check before you write. Deck analysis, discovery and drafting
call your live model, which the test suite fakes; confirm your first deck
analysis looks right before you trust the scores built on it.

## License

MIT. See [LICENSE](LICENSE).
