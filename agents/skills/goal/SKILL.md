---
name: goal
description: Top-level goal router for Robot Dojo. Use when the user states an outcome in plain language and expects the system to choose the right tracked path: /defect for broken behavior, /story for product/code/documentation change, or /topic for durable exploratory work. /goal must delegate into those existing skills and must never build outside the approved /build pipeline.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: tool
---

# /goal
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Top-level outcome intake. The user can state the destination; Miyagi chooses the tracked Robot Dojo path and then the underlying skill owns the record, artifacts, gates, specialists, and proof.

## Contract

Reads: the user's goal, any named story/defect/topic id, and the selected downstream skill file.

Produces: no independent goal artifact. Delegates to exactly one of `/defect`, `/story`, or `/topic`; if continuing an existing tracked story/defect, delegates to exactly one next approved stage.

Stops with: the selected downstream skill's normal stopping point. For new story/defect work, this is the framing approval prompt. For topic work, this is the topic-session open/close result. For continued tracked work, this is one sealed stage and its next-step prompt.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Canonical use cases

- `/goal Fix the integrations page crash` routes to `/defect`.
- `/goal Add a top-level goal skill and update the Agents page` routes to `/story`.
- `/goal Continue the health topic and decide the next lab import shape` routes to `/topic health`.
- `/goal Continue st_12345678` runs the one next permitted stage for that tracked story/defect after the prior stage is approved.

## Steps

1. Read `architecture/sitemap.md` and `architecture/ontology.md`.
2. Preserve the user's goal verbatim. Do not rewrite it into implementation language before routing.
3. Choose the route:
   - Use `/defect` when the user describes broken behavior, a regression, a failed promise, a failing test, or "fix" work whose correct behavior is implied by an existing surface.
   - Use `/story` when the user asks for a new capability, product change, code change, documentation change, workflow improvement, or any build that must ship through `/build`.
   - Use `/topic {target}` when the user asks to think, research, decide, synthesize, or continue a topic without requesting a product change.
   - If the user names an existing story/defect id or says to continue the current tracked goal, resolve the active record and run only the next stage allowed by `story-gate.js`.
4. Load the selected downstream skill's `SKILL.md` completely and follow it verbatim. `/goal` is routing context only; the downstream skill owns all artifacts and gates.
5. For `/story` or `/defect`, pass the user's original goal as the original request/report, create the tracked record, auto-invoke `/framing`, and stop at the framing approval prompt. Do not continue to research, scope, plan, build, QA, or close without the normal owner approval.
6. For continued story/defect work, run one stage only:
   - `framing -> research -> scope -> plan -> build -> qa -> close`
   - If the predecessor is sealed but not countersigned, use the exact-next-stage approval path already documented in that stage skill.
   - If the predecessor is not sealed, stop and surface the gate block.
7. For `/topic`, open or close the topic through the `/topic` skill. If the session reveals a product change, route that change through a new `/story` or `/defect`; do not build from inside `/topic`.
8. Never edit application code, write build reports, run criteria, or claim QA from `/goal`. Implementation belongs to `/build`; certification belongs to `/qa`; final closure belongs to `/close`.
