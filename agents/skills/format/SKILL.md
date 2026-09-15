---
name: format
description: Render a SEGS content array into a target document format (Google Docs memo style today). Used by build/distribute skills that produce proposal-style deliverables.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: tool
---

# Skill: format
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

Renders content segments into target output formats.

## Contract

Reads: a content file exporting a `SEGS` array + the target Google Doc id + the calling account.

Writes: the rendered document via Google Docs API; a JSON log under `~/robotdojo/user/logs/format/`.

Stops when: the render completes and the log is written.

## Steps

1. Read the content file at `--content` and import the `SEGS` array.
2. Resolve the target doc id and account credentials.
3. Render segments via the format renderer.
4. Write the run log to `~/robotdojo/user/logs/format/`.

## Canonical use cases

- Proposal documents in Google Docs memo style.
- One-off renders where Inter-font, bold-headers, filled-circle bullets are the target shape.
- Pipelines that emit `SEGS` arrays and need a deterministic doc-rendering step.

## Memo style

- Font: Inter, lineSpacing: 115
- Bold headers only (no Google Docs heading styles)
- Filled-circle bullets (● BULLET_DISC_CIRCLE_SQUARE preset). Nested `b2` / `b3` bullets indent to list level 1 and 2 (day → event → details).
- Blank-line spacers (not spaceAbove/spaceBelow)
- Page breaks via insertPageBreak

## CLI

```bash
node agents/skills/format/write.js \
  --doc <google-doc-id> \
  --account <email> \
  --content <path-to-content-file.js>
```

## Content files

Located at `user/files/format/content/` (gitignored — user-specific deliverables). Each exports a `SEGS` array. Add new content files locally; they are not committed.

## Traceability

Every run writes a JSON log to `~/robotdojo/user/logs/format/`:
```json
{
  "timestamp": "...",
  "docId": "...",
  "account": "...",
  "contentFile": "...",
  "segmentCount": 294,
  "exitStatus": 0
}
```

## Renderer API

```js
import { render } from './agents/skills/format/renderer.js';
await render(docId, accountEmail, segments);
```
