# Installing Fundraise CRM for someone

Instructions for an AI agent setting this up on behalf of a user. Follow them in
order. Every step is verifiable — check the stated signal before moving on, and
do not report success on a step you have not verified.

## What you are installing

An investor CRM. The user uploads a pitch deck or gives a website; Claude writes
a company profile, scores the deck against a stage-relative rubric, labels it
against a fixed category taxonomy, then scores a bundled list of 1,715 investors
against that profile and researches further ones into a pipeline. Emails are
queued in the app and sent from the user's own mailbox by `apps/mailer`.

It is a monorepo. `apps/web` is a Cloudflare Pages Worker with a D1 database;
every setup command below runs from the repo root and calls
`apps/web/setup.sh`.

Two things to tell the user rather than let them discover:

1. **The setup script creates their owner account and prints a generated password
   once.** It is stored only as a hash. If they lose it, the fix is to create a
   new account with `apps/web/scripts/seed-user.js`, not to recover the old one.
2. **The bundled investor list arrives unscored on purpose.** The fit numbers
   are placeholders until they analyze a deck and click "Score against my deck"
   on the Directory. Do not describe the list as "1,715 matched investors". It is
   1,715 investors with no opinion attached yet.

## Decide the mode first

Ask the user one question: **is this for them alone, or for other people too?**

| Answer | Mode | What it needs |
|---|---|---|
| Just me, on my machine | `local` | An Anthropic API key. Nothing else. |
| I want it on a URL | `deploy` | An API key **and** a Cloudflare account |

Do not default to `deploy`. It provisions cloud resources and costs money; local
mode needs no Cloudflare account at all, because `--local` keeps the database in
`.wrangler/state` and never consults the placeholder ids in `wrangler.toml`.

## Local install

Get the key from the user first — it is the one value that cannot be defaulted
or generated. Direct them to <https://console.anthropic.com/settings/keys>.
Then, without prompting:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

Pass the key **in the environment**, not by editing `apps/web/.dev.vars` yourself. The
script writes that file wholesale with `umask 077`; hand-appending to it is how
it previously ended up with a value split across two lines, which silently
resolved the binding to nothing and made every model call fail at runtime with
`no_api_key`.

The script installs dependencies, applies `schema.sql` to the local D1, builds
`.assets/`, frees the port if a stale server holds it, and starts serving. It
runs in the foreground and does not exit — that is success, not a hang. Do not
wait on it. Verify from another shell:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4318/login   # expect 200
```

Then tell the user to open <http://localhost:4318/signup> and create the first
account. Do not create the account for them — it sets a password.

Set `PORT` if 4318 is taken: `PORT=5000 npm run dev`.

## Hosted install

Requires an authenticated Cloudflare CLI. `npx wrangler login` opens a browser
and cannot be driven headlessly — **ask the user to run it themselves** and tell
you when it is done. Then:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run deploy
```

This resolves the account id, creates the D1 database if absent, rewrites the
placeholder ids and the original author's `account_id` in `wrangler.toml`,
applies the schema, sets both secrets, builds, and deploys. It is idempotent:
if it fails halfway, fix the cause and run it again.

If the user has more than one Cloudflare account the script stops rather than
guessing — ask which one and re-run with `CLOUDFLARE_ACCOUNT_ID=<id>`.

Signup is open by default so the user can create their own first account. If
they want it invite-only, set `SIGNUP_OPEN = "false"` in `wrangler.toml`,
redeploy, and seed accounts with `apps/web/scripts/seed-user.js` (it prints the password to
stderr — pass it to the user over a channel they chose, never a shared log).

## Email

Read `docs/email.md` and walk the user through it. Three rules:

- **Never ask for or handle their mailbox password.** The app password goes
  straight from their mail provider into their fork's GitHub secrets, which
  they enter themselves. You can tell them which secret names to create.
- The mailer token is created by the user in the app (Outbox, Create mailer
  token) and shown once. Have them paste it into the `CRM_TOKEN` secret.
- Verify with a message queued to the user's own address, and check the Outbox
  shows it as sent. "The workflow ran" is not the same as "the email arrived".

## When something is wrong

```bash
npm run doctor
```

Checks node, dependencies, `.dev.vars` well-formedness, both secrets, whether
`wrangler.toml` still has placeholders, whether `.assets/` is built, and whether
anything answers on the port. Changes nothing. Run it before diagnosing by hand.

## Failure modes worth knowing

**`Address already in use`** — an earlier server still holds the port. This is
the dangerous one: the old process keeps serving *stale code*, so edits appear
to do nothing and a test can pass against the wrong build. `setup.sh` clears the
port on startup, but if you start wrangler by hand, confirm what is listening
(`ss -ltnp | grep 4318`) and kill it by pid rather than with a bare `pkill`
pattern, which can match and kill your own shell.

**Analysis returns `no_api_key`** — the binding is empty. Run `doctor`. Wrangler
prints its bindings at startup; `env.ANTHROPIC_API_KEY ("(hidden)")` must appear
in that list.

**Deck analysis takes 30-60s** and runs in the background. `/api/deck` returns
`{"status":"analyzing"}` immediately; poll `/api/me` until
`company.deck.status` is `ready` or `failed`. Do not treat the first response as
the result.

**Per-user daily caps** are enforced in `LIMITS` in `apps/web/src/claude.js` because every
tenant's calls bill the deploy owner's key. If a user reports being cut off,
that is the ceiling working. Raise it deliberately, not reflexively.

## Do not

- Commit `.dev.vars`, or paste the API key into a file you did not write with
  `umask 077`. It is gitignored; keep it that way.
- Run `npm run deploy` to "test" an install. It creates billable resources.
- Apply `schema.sql` with `--remote` against a database you did not create here.


## After the install, verify these — do not assume them

Run these and report what you actually saw, not what should have happened.

```bash
npm test      # expect: 62 passed, 0 failed, then smtp: ok
```

Then, signed in as the user:

1. `/api/me` returns their company and `"role":"admin"`.
2. The Directory lists 1,715 investors and shows the banner
   *"N investors are not scored yet"*. If the banner is missing but the list is
   there, the seed loaded without `scored: false` — check `apps/web/scripts/seed-investors.js`
   ran against `data/investors.json` and not something else.
3. `⚙ Model settings` appears in the sidebar. It only renders for an `admin`; if
   it is missing, the owner account was created as a `founder` — most likely
   they signed up at `/signup` instead of letting `setup.sh` create the account.

## What you must not do

- **Do not put an API key in a file you commit.** `setup.sh` takes it from the
  environment and writes `.dev.vars` with `umask 077`; `.gitignore` covers
  `.dev.vars*` with a glob, deliberately, because the bare name does not match
  `.dev.vars.save`.
- **Do not report the Claude-backed paths as verified** unless you have actually
  run one against the real API and seen a profile come back. The smoke tests
  fake the endpoint.
