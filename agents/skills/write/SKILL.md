---
name: write
description: Generate prose in the requested voice channel or register. Reads the owner voice corpus from wk_user/user-voice/ (owner-calibrated, gitignored), then drafts to stdout and auto-runs /check on the result.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: tool
---

# Skill: write
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
This skill uses frontier synthesis — the best available model for every reasoning operation.

Generates prose in the owner's voice for a channel or document-type register. Owner voice is already inlined on every session and every reply; this skill is the extra isolated pass that pins one channel or register and auto-runs `/check`.

## Contract

Reads: a brief or outline + a destination or kind-of-piece selector. Layers owner `voice.md` plus `formatting/<name>.md` or `structure/<name>.md`.

Writes: raw prose to stdout, then auto-runs `/check` on the draft.

Stops when: the generation completes and `/check` has surfaced any drift flags — no preamble, no metadata, no post-processing of the prose itself.

## Steps

1. Resolve the selector to a channel (linkedin, gmail, email, sms) or register (essay, memo, proposal, …) per the routing table below. A channel takes precedence over a same-named register.
2. Load owner `voice.md` plus the resolved formatting or structure file.
3. Compose the system prompt — voice first, then structure, then formatting — and draft the brief.
4. Return raw prose to stdout.
5. Auto-run `/check` on the draft (it reasons the prose against `check.md` relative to `voice.md`) and surface any drift flags before the owner acts.

## Canonical use cases

- Drafting an essay, memo, proposal, deck, post, SMS, or speech in the user's voice.
- Calibrating tone for a specific register before publishing.
- Producing voice-true prose where the generic template would otherwise read flat.

## Voice docs

The owner voice corpus lives at `wk_user/user-voice/`. `voice.md` is the live compounded writing. Destinations live in `formatting/`. Kinds of piece live in `structure/`.

Destinations live in `formatting/`: linkedin, gmail, email, sms, asana.

Kinds of piece live in `structure/`: essay, memo, proposal, speech, heartfelt, bio, and the rest of that folder.

## Routing

| Use case | Selector |
|----------|----------|
| LinkedIn post, public feed | linkedin (channel) |
| Email to send from Gmail | gmail (channel) |
| Plain professional or personal email | email (channel) |
| Text message | sms (channel) |
| Personal essays, reflections, journaling | essay |
| Client proposals, SOWs, engagement letters | proposal |
| Internal / executive memos | memo, business-memo |
| Slide content, decks | deck, business-ppt |
| Long-form research, whitepapers | whitepaper |
| Talks, speeches, toasts | speech |
| Vows, condolences, personal letters | heartfelt |
| Speaker bio, About page | bio |

A channel takes precedence over a same-named register.

## Auto-check

After drafting, `/write` auto-runs `/check` on the prose against `check.md` relative to `voice.md`. `/check` flags; it never blocks or rewrites.

## Samples

Drop writing in `wk_user/user-voice/samples/` (any format) or connect mail. The background learner compounds owner `voice.md`. No slash command. Chat trains Miyagi, not this tree.

## Write CLI

`node ~/robotdojo/agents/skills/write/write.js --voice <channel-or-register> --brief "<text>"`

Resolves the selector to `user-voice/formatting/<name>.md` or `user-voice/structure/<name>.md`, layers `user-voice/voice.md`, calls Sonnet, and returns prose to stdout. Then run `/check` on the output.

## Ingest CLI

`node ~/robotdojo/scripts/ingest-voices.js [--dry-run] [--source gmail:<email>]`

Classifies samples → augments owner voice profiles in `wk_user/user-voice/`.

## Output format

Raw prose to stdout. No metadata, no preamble. The caller decides how to render or post-process.
