// Prompts for the deck critique and for intro drafts. Every fact about the
// company comes from the profile; nothing about any company is hardcoded.

// A deck critique is written against the profile Claude already extracted, not
// against the PDF a second time: the profile is what investors will effectively
// see (it's what feeds discovery and intros), so a gap there is a gap in the
// deck. Re-reading the PDF would also double the deck quota for one action.
export function buildCritiquePrompt(profile, companyName) {
  const list = (v) => (Array.isArray(v) ? v.join("; ") : v || "") || "n/a";
  const system = `You are a seed-stage investor giving a founder a blunt, useful critique of their pitch deck. You have read hundreds of seed decks and passed on most of them.

Rules:
- Be specific to THIS deck. Generic advice ("add more traction") is worthless; say which claim is thin and what would fix it.
- Lead with what would actually cause a pass. Do not open with praise padding.
- Where a number is missing, name the number you would want to see.
- No hype, no em dashes, no exclamation marks.
- If something in the brief is genuinely strong, say so once and move on.

Return markdown with exactly these sections:
## Verdict
One paragraph: would you take the meeting, and what is the single biggest risk.
## What lands
Three bullets maximum.
## What would cause a pass
The real objections, most severe first. Be concrete.
## Missing numbers
The specific metrics a seed investor will ask for that this brief does not answer.
## Sharpen these lines
Two or three verbatim rewrites of weak phrasing, shown as "before" and "after".`;

  const user = `Critique the seed deck for ${companyName}.

One-liner: ${profile.one_liner || "n/a"}
Stage: ${profile.stage || "n/a"}
Raising: ${profile.raising || "n/a"}
Problem: ${profile.problem || "n/a"}
Solution: ${profile.solution || "n/a"}
Business model: ${profile.business_model || "n/a"}
Traction: ${list(profile.traction)}
Team: ${profile.team || "n/a"}
Competition: ${profile.competition || "n/a"}
Categories: ${list(profile.categories)}
Ideal investor: ${profile.ideal_investor || "n/a"}`;

  return { system, user };
}

export function buildIntroPrompts(body, profile, display) {
  const { firm, partner, type, category, thesis, why, notes } = body;
  const isWarm = type === "warm";
  const company = profile.company || "the company";

  const system = `You write concise, high-signal fundraising outreach for a founder named ${display}, raising ${
    profile.raising || "a round"
  } for ${company}. Voice: direct, specific, no hype, no em dashes, no exclamation marks. Never invent facts about the investor beyond what is provided, and never invent traction beyond the brief. Keep it tight.

COMPANY BRIEF:
${company} — ${profile.one_liner || ""}
Stage: ${profile.stage || "n/a"}
Problem: ${profile.problem || "n/a"}
Solution: ${profile.solution || "n/a"}
Business model: ${profile.business_model || "n/a"}
Traction: ${(profile.traction || []).join("; ") || "n/a"}`;

  const investorContext = `Investor firm: ${firm || "(unknown)"}
Partner / person: ${partner || "(the relevant partner)"}
Their focus / categories: ${category || "n/a"}
Their thesis: ${thesis || "n/a"}
Why they may fit ${company}: ${why || "n/a"}
Extra notes from ${display}: ${notes || "none"}`;

  const user = isWarm
    ? `Write a SHORT warm-intro REQUEST that ${display} will send to a MUTUAL CONNECTION, asking that connection to forward them to ${
        partner || "the partner"
      } at ${
        firm || "the firm"
      }. It should be forwardable: 2-3 sentences the connection can paste, plus one crisp line on why ${company} fits this specific investor. Under 130 words. Return only the message text.

${investorContext}`
    : `Write a SHORT COLD outreach email from ${display} directly to ${partner || "the partner"} at ${
        firm || "the firm"
      }. One tight paragraph: the hook, one proof point drawn only from the brief, why THIS investor specifically, and a soft ask for 20 minutes. Include a subject line. Under 150 words. Return the subject line then the body.

${investorContext}`;

  return { system, user };
}
