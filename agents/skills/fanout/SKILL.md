---
name: fanout
description: Fan one task to all four frontier models (Anthropic, OpenAI, Google, xAI), judge them under bias guards with a selectable judge (Grok by default), challenge the leader, and return a synthesized answer inline with full receipts. Use when the operator wants a trustworthy multi-model answer without leaving the coding session.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: tool
---

# /fanout
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

This skill is a thin wrapper. The mechanism is the agent-agnostic CLI at `scripts/fanout.js`; this skill is convenience only, not the tool. The CLI takes structured flags and embeds no natural-language parser — **you are the language layer.** Map the operator's plain-language intent onto the flags, then shell the command and relay its stdout verbatim.

## Contract

Reads: the operator's task and intent (natural language).

Writes: nothing in the repo. The CLI writes receipts under `~/.robotdojo/fanout/{runId}/` (four raw answers, judge scores + reasoning, challenger argument, synthesis, cost, meta).

Stops when: the CLI's inline result (answer + verdict + cost + receipts path) is relayed.

## Run it

```sh
node ~/robotdojo/scripts/fanout.js "<the operator's task>" [flags]
```

Relay stdout as-is — it already carries the synthesized answer, the ranked verdict with the judge's own rank flagged, whether the challenger ran, the total cost, and the receipts path the operator can open to audit.

## Natural-language → flag mapping

You translate operator intent into structured flags. The CLI does not.

- "use claude as judge" / "let gpt judge" / "gemini should judge" → `--judge anthropic` | `--judge openai` | `--judge google` (default judge is `xai`/Grok)
- "go cheap" / "budget" / "don't spend much" → `--cheap` (fans the budget tiers; the judge and synthesizer stay on their best tier regardless)
- "top models" / "best quality" / "frontier" → `--best`
- "drop grok's own vote" / "don't let the judge score itself" → `--exclude-own` (drops whichever provider is judging from the ranking; its raw answer is still saved)
- "really push back" / "force a challenge" → `--challenge`
- "skip the challenger" / "no devil's advocate" → `--no-challenge` (the challenger otherwise runs by default and auto-fires when the answers substantially agree)

Flags compose. "Use claude as judge and go cheap" → `--judge anthropic --cheap`. An unrecognized `--judge` value errors clearly; pick one of anthropic, openai, google, xai.

## Steps

1. Translate the operator's intent into structured flags (see the mapping below) — the CLI takes flags only, the agent is the language layer.
2. Run `node ~/robotdojo/scripts/fanout.js "<the operator's task>" [flags]`. It fans the task to all four frontier models (Anthropic, OpenAI, Google, xAI), judges them under bias guards (Grok judges by default), optionally challenges the leader, and synthesizes one answer.
3. Relay stdout as-is: the synthesized answer, the ranked verdict with the judge's own rank flagged, whether the challenger ran, the total cost, and the receipts path.
4. If the operator wants to audit, point them at the receipts under `~/.robotdojo/fanout/{runId}/` (four raw answers, judge scores + reasoning, challenger argument, synthesis, cost, meta).

## Canonical use cases

- A high-stakes or contested question where one model's answer isn't trustworthy alone, and cross-model agreement (or disagreement) is itself the signal.
- A decision the operator wants a second, third, and fourth opinion on without leaving the coding session.
- Auditing a single model's answer: fan the same task, see whether the frontier models converge, and read the judge's reasoning plus the challenger's pushback.
- Not for bulk or automated use — one run per explicit operator ask; live runs cost real money across four providers.

## Boundaries

- Do not add a natural-language parser to the CLI — the agent is the language layer by design (keeps the tool structured and portable to Grok Build or a bare shell).
- Do not treat the skill as required — `node scripts/fanout.js "<task>"` from any shell is the whole mechanism.
- Live runs cost real money across four providers. One run per explicit operator ask.
