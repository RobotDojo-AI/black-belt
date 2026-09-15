---
name: check
description: Auto-runs on a /write draft and reasons about whether it drifts from the owner's aspirational voice (base.md) per the drift tendencies (check.md) — catching judgment cases like under-selling or faint negativity, not just literal patterns — and surfaces the flags before the owner acts. Flags, never blocks; the owner edits. check.md is appendable.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: tool
---

# /check
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Miyagi is the orchestrating agent.

`/check` reads a draft and reasons about how it drifts from the owner's aspirational writing voice. It measures the draft against the owner's drift tendencies (`wk_user/user-voice/check.md`) relative to the aspirational base register (`wk_user/user-voice/voice.md`) and surfaces every drift it finds before the owner acts on the draft. It runs automatically on `/write` output.

It **reasons** — it does not pattern-match. The point of `/check` is to catch the judgment cases a `grep` cannot: a line that under-sells a true strength, a faintly negative or self-deprecating turn, a hedge that softens a real claim. A literal diminisher ("just," "a bit") is the easy case; the load-bearing case is tone the owner would not have used. When a tendency in `check.md` is a judgment call, treat it as one.

It **flags, it never blocks**. `/check` surfaces the drift and lets the owner decide. It does not rewrite the draft and does not gate the write.

---

## Contract

**Reads:** `architecture/sitemap.md`, `architecture/ontology.md`, the draft prose, `wk_user/user-voice/voice.md` (the aspirational target), and `wk_user/user-voice/check.md` (the tendencies to catch).

**Produces:** a short list of drift flags — each naming the line, the tendency it trips, and the lighter-touch fix — printed for the owner. Nothing is written to the draft.

**Stops when:** the flags are surfaced. The owner acts; `/check` does not.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

---

## Canonical use cases

- Auto-running on a `/write` draft to surface under-selling and faint negativity before the owner sees it as final.
- Reviewing prose the owner pasted in, against his own voice.
- Confirming a draft is clean after the owner edited away an earlier flag.

## Steps

1. Read `architecture/sitemap.md` and `architecture/ontology.md`.
2. Load the draft, `wk_user/user-voice/voice.md`, and `wk_user/user-voice/check.md`.
3. Reason line by line: for each tendency in `check.md`, decide whether the draft trips it. Judgment tendencies (under-selling, negativity, tone) are reasoned, not matched — a neutral-looking line can still trip the negativity tendency. Literal tendencies (specific diminishers) are caught too, but they are the floor, not the ceiling.
4. Surface the flags. For each: the offending line (quoted), the tendency name, and the lighter-touch fix. If the draft is clean, say so in one line.
5. Stop. Do not rewrite the draft. Do not block the write. The owner decides what to change.

## Auto-run from /write

`/write` invokes `/check` on its output as its last step. The CLI helper makes this runnable in a pipeline:

`node ~/robotdojo/agents/skills/check/check.js --draft <file>` (or pipe the draft on stdin)

It loads `voice.md` + `check.md`, reasons over the draft, and prints the flags. The owner reads the flags alongside the draft and edits. `check.md` is appendable — inferred chat feedback and new samples update the voice stack; the next `/check` run catches it.

## Output format

A short flag list to stdout, owner-facing. No rewrite of the draft, no preamble. One line per flag: quoted line, tendency, fix. "No drift flags." when clean.
