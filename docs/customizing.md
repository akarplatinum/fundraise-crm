# Making it yours

Everything that is a matter of taste or policy lives in a named constant or a
single function. This is the map. Paths are relative to `apps/web/`.

After any change: `npm test` from the repo root, then `./setup.sh local` to look
at it, then `./setup.sh deploy` (or `npm run deploy -w apps/web`) to ship it.

## Your company

You do not edit code for this. The profile (one-liner, stage, raise, traction,
categories) comes from the deck or website you give it during onboarding, and
you can edit it afterwards at `/onboarding`, which stays open after setup. Intro drafts, scoring and
discovery all read from that profile, so a correction there flows everywhere.

Your deck is stored once and attached to outgoing email by default. Replace it
from the **Outbox** page.

## Name, colors, look

| What                                      | Where                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Product name in the sidebar and tab title | `public/index.html`: the `.brand` element and `<title>`                                                                              |
| Sign-in and sign-up pages                 | `public/login.html`, `public/signup.html`                                                                                            |
| Colors, light and dark                    | the `:root` custom properties at the top of `public/app/app.css` and `app/onboarding.css`, and in the `<style>` of the sign-in pages |
| App and database names                    | `name` and `database_name` in `wrangler.toml`, the only place they appear                                                            |

The UI is plain HTML, CSS and JavaScript with no build step. Edit and reload.

## The pipeline

| What                                               | Where                                          |
| -------------------------------------------------- | ---------------------------------------------- |
| Stages, their labels, colors and close probability | `STAGE` and `FLOW` in `public/app/core.js`     |
| Which stages appear as board columns               | `BOARDCOLS` in `public/app/core.js`            |
| Round size used before your profile says otherwise | `DEFAULT_ROUND_TARGET` in `public/app/core.js` |
| Check-size filter buckets                          | `CHECKB` in `public/app/core.js`               |

Stage keys are stored on each deal, so renaming a label is safe, but removing a
key strands any deal already in that stage. Move those deals first.

## What the AI writes

| What                                           | Where                                                       |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Intro drafts (warm request and cold email)     | `buildIntroPrompts()` in `src/drafts.js`                    |
| The deck critique                              | `buildCritiquePrompt()` in `src/drafts.js`                  |
| What the profile extracts from a deck          | `PROFILE_SCHEMA` and `analyzeProfile()` in `src/profile.js` |
| The category vocabulary                        | `TAXONOMY` in `src/profile.js`                              |
| The deck score rubric and how stage weights it | `RUBRIC` and `STAGE_WEIGHTS` in `src/profile.js`            |
| How investors are found                        | `discoverInvestors()` in `src/investors.js`                 |

The intro prompt sets the voice: direct, specific, no hype, no exclamation
marks. If your drafts come out sounding like someone else, change the system
prompt there. Keep the rule that it never invents facts about the investor or
traction beyond the profile; that is what stops a draft from claiming a metric
you do not have.

`TAXONOMY` is a closed list on purpose: the model labels your company from it
and anything else is dropped, so "B2B SaaS" and "b2b-saas" cannot become two
categories. Add a label there if your sector is missing, rather than loosening
the check.

## Scoring

Scoring runs in two passes. `structuralScore()` in `src/investors.js` is free
and runs over every investor: sector overlap, stage match, and how the fund's
check size fits your round. The model pass then reads the top
`SCORE_DEFAULT_TOP` (100) by structural score, in batches of `SCORE_BATCH`, and
the final score leans 75% on the model. Change the weights in `runScoring()`.

## Model and spend

| What                  | Where                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Default model         | `DEFAULT_MODEL` in `src/ai.js`, or `MODEL_ID` in `wrangler.toml`, or the Model settings page (admin only), which wins |
| Daily limits per user | `LIMITS` in `src/ai.js`                                                                                               |

`LIMITS` counts actions per user per UTC day: 5 deck analyses, 8 scoring runs,
6 discovery runs, 5 critiques, 60 intro drafts. On your own deploy it is a guard
against a bug that retries forever. If you let other people sign up, it is what
keeps them from running up your API bill. Raise it on purpose, not to make an
error go away.

## Email

How sending works and how to set it up is in [email.md](email.md). The pieces:

| What                      | Where                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Largest attachment        | `MAX_FILE_BYTES` in `src/mail.js` (bounded by the D1 query limit on the Free plan, see the comment) |
| How often the mailer runs | the `cron` line in `.github/workflows/mailer.yml`                                                   |
| SMTP behaviour            | `apps/mailer/smtp.js`                                                                               |

## The investor list

See [data/README.md](../data/README.md) for the format and how to load your own.

## Accounts and sharing

The first account `setup.sh` creates is the admin; that is you. To add people:

```bash
# A co-founder who shares your pipeline: pass your company id
node scripts/seed-user.js sam "Sam" "" "" co_ab12cd34ef

# Someone with their own separate pipeline
node scripts/seed-user.js sam "Sam" "Their Company"
```

Both print SQL to stdout and the password to stderr, so the password never
lands in a file. Apply the SQL with
`npx wrangler d1 execute DB --remote --file=<file>`.

Set `SIGNUP_OPEN = "true"` in `wrangler.toml` to let people create their own
account at `/signup`. Those accounts are never admin, so they cannot change the
API key, and each one gets its own company.

## Where the code is

```
apps/web/src/
  index.js      routing and the session gate
  auth.js       passwords and session cookies
  http.js       response helpers
  ai.js     the Anthropic call, model settings, daily limits
  profile.js    deck and site analysis, taxonomy, deck score
  investors.js  discovery and scoring
  drafts.js     prompts for intros and the critique
  mail.js       attachments, the outbox, the mailer API
  store.js      every database query
apps/web/public/
  index.html    the app's markup; scripts load in the order listed at the bottom
  app/          app.css, and one script per view (directory.js, pipeline.js,
                drawer.js, email.js, ...). core.js holds shared state and
                helpers and loads first; main.js starts the app and loads last.
  onboarding.html, login.html, signup.html  (onboarding's code is in app/ too)
apps/web/schema.sql
apps/mailer/      mailer.js (the queue) and smtp.js (the protocol)
```

Two rules hold across the server code. Every query is scoped by `company_id`,
which is the only thing keeping one company's data from another's. And nothing
outside `store.js` touches the database, so a change of database is a change to
one file.
