# The investor list

`investors.json` holds 1,715 seed-stage investors: funds, micro-VCs, angels,
corporate VCs and studios. `apps/web/scripts/seed-investors.js` loads it into a
company when you set up the app.

| | |
|---|---|
| Investors | 1,715 |
| Curated (`tier: "seed"`) | 904 |
| From a fund list, researched (`tier: "fund-list"`) | 811 |
| With a named partner | 1,673 |
| With a partner LinkedIn URL | 1,075 |
| With a written thesis | 1,711 |
| With a parsed check size | 1,148 |
| Portfolio companies named | 6,338 |

## The two halves

**Curated (904).** Built by hand and with model-assisted research over several
months, for a seed raise in commerce and marketplace software. Firms were
checked against their own sites and partners against LinkedIn, and people who
had moved were re-checked. These records are the better ones: a thesis
paragraph, portfolio names, a partner with title, focus and LinkedIn, and often
a second partner.

**Fund list (811).** Imported from a larger list of funds with a listed contact,
filtered to firms that invest at pre-seed or seed in sectors near
commerce, software, data and AI, then researched
one by one against the firm's site, SEC Form D filings and fund databases. Each
record carries `sources` (the URLs the research read), `research_confidence`
(`low` 547, `medium` 168, `high` 17), and `research_notes` where the sources
disagreed or the firm looked inactive. Treat a `low` record as a lead, not a
fact.

## Fields

```jsonc
{
  "id": "seed-equal",            // stable; "seed-*" curated, "fund-*" fund list
  "firm": "Equal Ventures",
  "type": "VC",                  // VC | Micro-VC | Angel | Corporate VC | Studio | Syndicate ...
  "tier": "seed",                // seed | fund-list (the app adds researched and custom)
  "website": "https://www.equal.vc/",
  "hq": "New York, NY",
  "category": ["Commerce", "Retail", "B2B SaaS"],
  "stages": ["Pre-seed", "Seed"],
  "check_size": "~$1.5M initial checks at seed",   // as written by the source
  "check_min": 1500000, "check_max": 1500000, "check_avg": 1500000,  // parsed, when stated
  "leads_rounds": true,          // true | false | null (unknown)
  "thesis": "...",
  "relevant_portfolio": ["Chord Commerce", "Bikky"],
  "best_partner": { "name": "", "title": "", "focus": "", "linkedin": "", "twitter_x": "", "email": "" },  // email: never bundled; add your own
  "other_partners": [ /* same shape */ ],
  "sources": [],
  // fund-list records may also carry:
  "fund_name": "", "fund_year": 2023, "fund_size_usd": null, "aum_usd": null,
  "research_confidence": "low", "research_notes": ""
}
```

## What was removed

Both halves were originally written for one company's raise. Every record had a
fit score, a fit rationale, a "why this partner" note and a list of competitor
conflicts, all relative to that company. All of it was stripped, along with any
sentence that named it. A fit score is an opinion about one specific company,
and a score calibrated to somebody else's thesis is not a weak signal about
yours. It is a wrong one that looks right.

So the file holds facts only. The loader stores each record with
`scored: false` and a placeholder fit of 50, and the app says so until you click
**Score against my deck**.

## What it is not

- **Not current.** These are point-in-time records from 2026. Partners move and
  funds close. Check that a partner is still at the firm before you write.
- **Not neutral.** The curated half leans toward US pre-seed and seed funds in
  commerce, marketplaces, supply chain, retail tech and B2B software, because
  that is what it was built to find. If you are raising in biotech or climate,
  treat it as a starting frame and use **Find investors**, which researches
  against your own categories.
- **Not contact data.** There are no email addresses or phone numbers. Partner
  LinkedIn and X links are public professional profiles. When you find a
  partner's address, add it to the record in your own copy, or type it when
  you send. The app is built for writing to a few well-chosen people one at a
  time, ideally through a warm intro, not for blasting a list.

## Using your own list instead

Replace `investors.json` with any array of records in the shape above (only
`id`, `firm`, `category` and `best_partner` are required; the rest can be
empty). Then re-run setup, or load it into an
existing company with:

```bash
node apps/web/scripts/seed-investors.js <company_id> seed-sql
for f in seed-sql/*.sql; do npx wrangler d1 execute DB --remote --file="$f"; done
```

Loading upserts on `id`, so re-running it updates records rather than
duplicating them.
