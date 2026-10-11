# How it works

Notes for whoever changes the code. For what to change, see
[customizing.md](customizing.md).

## Long jobs never hold a response open

Deck analysis, discovery and scoring return immediately and run in
`ctx.waitUntil`, writing status to the `companies` row that the client polls.
Reading a full deck takes longer than a browser will wait. A job that dies
mid-flight never writes `failed`, so a status that has been running past a
cutoff is treated as failed when read. Otherwise the row would sit on
`analyzing` forever and the "already running" guard would block every retry.

## Why the list arrives unscored

A fit score is an opinion about one company. Every bundled investor has
`scored: false` until **Score against my deck** runs, in two passes:

- **Structural**, free and instant, over every investor: sector overlap, stage
  match, and how the fund's check size relates to your round.
- **Model**, over the top 100 structural matches: reads each thesis and
  portfolio against your profile and returns a score with one sentence of
  reasoning.

The free pass is what makes the paid one affordable: the model never reads the
hundreds of firms that fail on stage alone. Each batch is saved as it finishes,
so a run that dies on batch seven keeps the six it paid for.

## The model and its key

Every model call goes through `complete()` in `src/ai.js`, which picks the
provider adapter (`src/provider-*.js`) from Model settings or the deploy's
`AI_*` variables. Callers ask for what they need (a PDF read, a page opened, a
web search) and check the provider's `capabilities` first, so a provider
without browsing gets the site's text from the Worker and one without search
leaves discovery off with a clear message. See [models.md](models.md).

No route returns the key. `GET /api/settings` gives whether one is set, where it
came from, and its last four characters. A key from the deploy's secrets is
only sent to the provider and URL the deploy names, so changing the base URL in
Settings cannot redirect it.

A Worker secret is the safer place for the key. A key saved in Settings lives in a D1 row,
so it is in your database exports and readable by anything that can query the
database.

## Email

The Worker queues; it never sends. `apps/mailer` polls `/api/mailer/pending`
with a bearer token, sends over SMTP, and reports back to `/api/mailer/result`.

- **The token is per company.** Only its SHA-256 is stored, and every mailer
  query is scoped to the company the token resolves to, so a mailer cannot read
  another company's queue or files.
- **Files live in D1, not R2.** A file is stored as base64 slices of 384 KiB.
  Because 384 KiB is a multiple of three bytes, the base64 of consecutive slices
  concatenates into the base64 of the whole file, so the mailer streams an
  attachment onto the SMTP connection a slice at a time and never holds it
  whole. This means the app needs no R2 bucket, which needs a card on file.
- **A send is logged once.** The result update only matches unsent rows, so a
  mailer that reports the same send twice changes nothing the second time.
- **The deck you were analyzed on is the one investors get.** `/api/deck` stores
  the upload and marks it the default attachment, replacing the previous
  default.

## Saves never empty the board

Deals are deleted when the client's save no longer contains them, and a failed
read looks exactly like an empty board. Three guards:

1. The server deletes a deal only if the client had seen it (`updated_at <=
_base`, where `_base` is stamped on every read).
2. The client refuses to save until `/api/crm` has returned a real board.
3. The server refuses any save that would delete the whole board, or more than
   half of a board with at least 20 deals, unless the request says
   `confirm_bulk: true`. The UI asks before sending that.

The third one is the one that matters, because it is the only one a stale tab
or a second client cannot bypass.

## Limits that shape the database code

Cloudflare D1 allows **50 queries per Worker request on the Free plan** (1,000 on
Paid) and **100 bound parameters per statement**. A statement over the
parameter limit is rejected, and a rejected statement fails its whole batch with
nothing partial to notice.

So writes in `store.js` use multi-row `VALUES`, chunked by `chunkFor()`, with
columns that repeat across rows bound once. Measured on the 904-investor list,
scoring every row took 37 queries and a re-score 18; one statement per row
would have been about 950. Attachments are capped at 30 slices for the same
reason: storing a file is one batch, and it has to fit in 50.

`test/d1.js` enforces the parameter and statement-size limits and counts queries
per request, so a regression here fails the tests rather than production.

What is not solved: `/api/data` returns every investor a company holds,
because the Directory searches thesis and portfolio text in the browser. At
1,715 investors that is fine. At tens of thousands it would need server-side
search.

## Tests

```bash
npm test
```

`apps/web/test/smoke.js` drives the real Worker through its fetch handler over
the real `schema.sql` on in-memory SQLite (Node 22+ for `node:sqlite`). Only the
Anthropic endpoint and the static asset server are faked. It covers sign-up and
sessions, tenant isolation, the daily limits, the key never appearing in a
response, a full scoring run, a 500-deal save and its deletion rules, and the
email path end to end: upload, queue, token scoping, slice reassembly, result
reporting and token rotation.

`apps/mailer/test/smtp.test.js` sends through `smtp.js` to a fake SMTP server
that speaks STARTTLS and checks the body and a 200 KB attachment arrive intact.

**Not covered by tests:** the live model calls (deck analysis, discovery,
intros) run against a fake endpoint, and real SMTP providers are only exercised
when you run `node apps/mailer/mailer.js --check` against your own.
