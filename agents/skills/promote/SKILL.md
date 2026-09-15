---
name: promote
description: Move a pending suggestion from the queue into a human-authored canonical surface. Reads agents/suggestions/*.md, shows the diff, waits for explicit yes, writes via canonicalWrite, marks the suggestion applied, and appends a promotion memory entry.
type: tool
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
---

# /promote
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Miyagi is the orchestrating agent.

`/promote` moves a proposed revision from `agents/suggestions/` into a human-authored canonical surface. It is owner-countersigned, story-authorized, and writes through `canonicalWrite()` so the version chain extends.

---

## Contract

**Reads:** `architecture/sitemap.md`, `architecture/ontology.md`, `agents/suggestions/*.md`, the target canonical file, and `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/*/meta.json`.
**Produces:** updated canonical surface via `canonicalWrite`; updated queue file with `[APPLIED]` prefix on the promoted section; one memory log entry per promotion.
**Guarantees:** explicit owner `yes`; active story authorizes the target in `meta.json.touches`; queue is append-only; memory records prior and new sha.

## Canonical use cases

- Promote an already-captured suggestion into a canonical human-authored file.
- Require an active story touch authorization before changing the target file.
- Preserve the promotion trail in the suggestion queue and memory log.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

---

## Steps

1. Read `architecture/sitemap.md` and `architecture/ontology.md`.
2. Enumerate pending `agents/suggestions/*.md` sections with `status: pending`. If none exist, stop.
3. Present the numbered list and wait for the owner to choose one. If the owner chooses none, stop.
4. Construct the candidate by applying only the chosen suggestion. Show the owner:
   - The diff of source vs candidate.
   - A score preview by calling `scoreCandidate(prior, candidate, { class: 'human-authored' })` from `lib/canonical-write.js` and printing the JSON.
5. Stop unless the owner says `yes` verbatim. No inferred consent.
6. Verify an active story exists and lists the target file in `meta.json.touches`; if not, stop and ask for a story or amendment.
7. Write the candidate via `canonicalWrite(path, candidate, { source: 'promote', storyId })`.
8. If rejected, surface `r.reason` and stop. Do not retry without re-confirming with the owner.
9. If accepted, mark the queue section `[APPLIED]`, append a memory entry through `appendMemory()`, and return the summary.

Three lines only:

```text
Promoted suggestion to <target-path>
Prior sha: <prevSha> -> New sha: <newSha>
Memory entry: <filename>
```

No narration. No auto-advance to another skill.
