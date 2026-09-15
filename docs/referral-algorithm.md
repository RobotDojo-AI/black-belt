# Referral Algorithm

Robot Dojo surfaces "invite a friend" candidates by scoring the people
already in the user's network against the profile of a qualified Robot
Dojo customer.

## What makes a qualified Robot Dojo customer?

Robot Dojo is a local-first personal AI with memory. The people most
likely to *get it* and pay for it are:

- **Technical** enough to understand why local-first matters
- **Tool-curious** — already pay for Claude, ChatGPT, Notion, Superhuman,
  Linear, GitHub, or similar
- **Privacy-aware** — care about where their data lives
- **Signal-generators** — write newsletters, forward articles, send
  long-form emails
- **Close to the user** — they'll actually open the invite

The top-N candidates are *not* the user's best friends by interaction
count. They are the best *potential Robot Dojo customers* inside the
user's trusted circle.

## The five signals

Each signal is normalized to `[0.0, 1.0]`. The final score is a weighted
sum:

| Signal | Weight | What it measures | Where it comes from |
|--------|-------:|------------------|---------------------|
| Relationship | 0.25 | Existing tier + interaction history + consistency | `people.tier`, `people.score`, `people.consistency_score`, `first_seen` |
| Technical    | 0.30 | Title keywords + tech-company email domain | `person_professional.title`, `person_professional.company_domain` |
| Tool spend   | 0.20 | Mentions of paid tools in their outbound emails | email body scan for `claude.ai`, `notion.so`, `linear.app`, `superhuman.com`, `cursor`, `github.com`, etc. |
| Privacy      | 0.15 | Proton/Signal usage + privacy keywords in messages | email domain + body scan |
| Sharing      | 0.10 | Long-form emails + newsletter authorship | `emails.is_newsletter`, avg body length |

Qualification threshold: **0.6**. Anything above that is a recommended
referral target.

## The formula

```
total = relationship * 0.25
      + technical    * 0.30
      + tool_spend   * 0.20
      + privacy      * 0.15
      + sharing      * 0.10
```

Relationship alone caps at `0.25 * 1.0 = 0.25` — a family member with
zero tech signal cannot pass the qualification bar just on
relationship. That's by design: a qualified referral needs *at least
one* professional signal.

## Tuning weights per campaign

Weights live in `lib/referral.js` as `WEIGHTS`. Adjust for the campaign:

- **"Friends and family" launch:** bump `relationship` to 0.5 and drop
  `technical` to 0.15. Surfaces close-but-soft leads.
- **"Technical early adopters":** bump `technical` to 0.4 and
  `toolSpend` to 0.3. Surfaces CTOs, engineers, AI-curious PMs.
- **"Privacy-first champions":** bump `privacy` to 0.3. Surfaces Proton
  users and privacy advocates.

Always re-run `computeReferralScores()` (or `node scripts/top-referrals.js
--refresh`) after changing weights.

## How professional context is populated

We do **not** scrape LinkedIn. We do the following instead:

1. **Email signatures.** Haiku reads the tail of recent non-automated
   emails from each candidate and extracts `{ title, company }` if
   they're explicitly stated in a signature.
2. **Email domain.** The domain is kept as `company_domain`. Known
   tech-company domains (Anthropic, OpenAI, Stripe, Vercel, etc.) boost
   the technical signal.
3. **LinkedIn URL** — only if the user already has it in
   `person_identifiers.type='linkedin'`. We store the URL, never the
   page contents.

Extraction is batched (20 people per Haiku call) and capped at $5 per
run by default. All state is upserted into `person_professional`,
keyed by `person_id`.

## Privacy model

- All five signals are computed **locally**, against the user's own
  SQLite database.
- Scores and breakdowns are stored in the same local DB
  (`referral_scores` table). Nothing is transmitted.
- The only outbound traffic is the Haiku call for signature extraction,
  and only the 800-char tail of an email body is sent — never the full
  message, never the recipient list.
- Reports are written to `~/.robotdojo/reports/top-referrals-{date}.md`
  — gitignored and outside the repo.

## Re-running

```
# Use cached scores — fast, no cost
node scripts/top-referrals.js --limit 20

# Recompute scores (no new LLM calls)
node scripts/top-referrals.js --refresh

# Extract missing professional context first (LLM, costs $)
node scripts/top-referrals.js --extract-pro --max-spend 5.0

# Dry-run extraction (no DB writes)
node scripts/top-referrals.js --extract-pro --dry-run
```

The maint_rescore maintenance routine (`scripts/maintenance-phases.js
--phase RESCORE`) calls `computeReferralScores()` on the existing cached
pro data, so scores stay fresh every day even without new LLM calls.
