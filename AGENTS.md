# For AI agents

Two jobs: installing this for someone, and changing the code. Read the section
you need.

## Installing it for someone

### What it is

An investor CRM. The user gives it a pitch deck or website; Claude writes a
company profile, scores a bundled list of 1,715 investors against it, and the
user works the resulting pipeline. Emails are queued in the app and sent from
the user's own mailbox by `apps/mailer`. `apps/web` is a Cloudflare Pages app
with a D1 database. Every command below runs from the repo root.

Tell the user two things up front:

1. **Setup creates their account and prints the password once.** Only a hash is
   stored. If they lose it, create a new account with
   `node apps/web/scripts/seed-user.js`; the old one cannot be recovered.
2. **The investor list arrives unscored.** Fit numbers are placeholders until
   they analyze a deck and click **Score against my deck**. Do not call it
   "1,715 matched investors".

### Pick the mode

Ask: is this just for them, on their machine, or on a URL?

| Answer   | Command                                       | Needs                            |
| -------- | --------------------------------------------- | -------------------------------- |
| Just me  | `ANTHROPIC_API_KEY=sk-ant-... npm run dev`    | an Anthropic API key             |
| On a URL | `ANTHROPIC_API_KEY=sk-ant-... npm run deploy` | the key and a Cloudflare account |

Do not default to deploy: it creates cloud resources. Get the key from the user
(<https://console.anthropic.com/settings/keys>) and pass it in the environment.
Do not write it into `apps/web/.dev.vars` yourself; the script writes that file
whole, with owner-only permissions.

**Local.** The script applies the schema, asks for a username, name and company
(set `OWNER_USER`, `OWNER_DISPLAY`, `OWNER_COMPANY` to skip the prompts), loads
the investor list, builds, and serves on port 4318 (`PORT=5000` to change). It
stays in the foreground; that is success. Check from another shell:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4318/login   # expect 200
```

**Deploy.** `npx wrangler login` opens a browser, so ask the user to run it
and tell you when it's done. The deploy script then creates the database and
the Pages project, writes the database id into `apps/web/wrangler.toml`,
applies the schema, sets both secrets, creates the owner account, and deploys.
It is safe to re-run after a failure. If the login has several Cloudflare
accounts it stops; ask which, and re-run with `CLOUDFLARE_ACCOUNT_ID=<id>`.

The deploy is invite-only. To let people create their own accounts, set
`SIGNUP_OPEN = "true"` in `apps/web/wrangler.toml` and deploy again.

### Email

Walk the user through `docs/email.md`.

- **Never ask for or handle their mailbox password.** They create an app
  password with their provider and paste it into their fork's GitHub secrets
  themselves. You can tell them the secret names.
- They create the mailer token in the app (Outbox, Create mailer token). It is
  shown once.
- Verify with an email queued to their own address, and check the Outbox marks
  it sent. A green workflow run is not proof the email arrived.

### Verify, and report what you saw

```bash
npm test     # expect: 64 passed, 0 failed, then smtp: ok
```

Signed in as the user: `/api/me` shows `"role":"admin"`; the Directory lists
1,715 investors with the "not scored yet" banner; **Model settings** appears in
the sidebar (admin only; if it's missing, they signed up at `/signup` instead
of using the account setup created).

Do not report deck analysis, discovery or drafting as working until you have
seen one return a result from the real API. The tests fake it.

### When something is wrong

`npm run doctor` checks node, `.dev.vars`, secrets, the database id, the build
and the port, and changes nothing. Then:

- **Edits seem to do nothing:** an old server still holds the port and serves
  old code. Find it with `ss -ltnp | grep 4318` and kill it by pid. A broad
  `pkill` pattern can kill your own shell.
- **`no_api_key`:** the key binding is empty. Run `doctor`.
- **Deck analysis looks stuck:** it takes 30 to 60 seconds in the background.
  Poll `/api/me` until `company.deck.status` is `ready` or `failed`.
- **"Daily limit reached":** that is `LIMITS` in `apps/web/src/claude.js`
  working. Raise it only if the user asks.

## Changing the code

Read `docs/customizing.md` for where things live and `docs/how-it-works.md` for
why. Rules that keep this codebase what it is:

- **Every query is scoped by `company_id`,** and all SQL lives in
  `apps/web/src/store.js`. That scoping is the only wall between one company's
  data and another's.
- **No dependencies, no bundler, no build step for the UI.** Server code is ES
  modules on the Workers runtime. The UI is plain scripts in
  `apps/web/public/app/`, one per view; `core.js` loads first, `main.js` last.
- **D1 limits shape every write:** 100 bound parameters per statement and 50
  queries per request on the Free plan. `apps/web/test/d1.js` enforces both.
- **Names live in `apps/web/wrangler.toml` only.** Refer to the database by its
  binding, `DB`.
- **Comments say why, not what happened.** No bug histories; state the rule
  the code follows.
- **Format with Prettier** (`npx prettier@3 --write .`, config in
  `.prettierrc`) and run `npm test` before committing. Add a check to
  `apps/web/test/smoke.js` for any new route.
- **Never commit** `.dev.vars`, an API key, or a database id that is not the
  placeholder.
