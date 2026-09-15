---
name: plan
description: Convert approved scope into an implementation plan with runnable verification criteria.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: pipeline
---

# /plan
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Plan the active story. One artifact, explicit approval, then stop. Do not auto-invoke /build.

## Contract

Reads: approved `scope` stage, `00-scope.md`, `01-research.md`.

Produces: `02-plan.md`; sealed `plan` stage.

Stops with: plan summary and `Next: /build`.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Persona Routing

- Miyagi writes S plans.
- Ori writes or reviews M/L plans when architecture, schema, API, data flow, or multi-phase build order matters.
- Tantei can be re-spawned only for missing codebase facts.
- Katagami is not spawned in /plan.
- Spawn budget: `effort: 'medium'`, ceiling 40 tool calls. Report actuals on return.

## Required Sections

`02-plan.md` must contain exactly these load-bearing sections:

```markdown
# {story outcome}

## Outcome

## Approach

## How ACs are satisfied

## Test strategy

## Failure manifest

## 10/10 self-audit
```

The `## 10/10 self-audit` section is the seal contract enforced by `check-self-audit-section.js`. Write it using this exact template — three blockquoted questions, the waiver as a NESTED blockquote (`> >`) quoting the owner's verbatim words when a gap exists, or `none required` when there is none. The 4-question quality bar (weakest point / missing dependency / length / structure) is PRE-FLIGHT REASONING that feeds these answers — never the section format itself:

```markdown
## 10/10 self-audit

> **What does 10/10 look like for this artifact?**
> {one honest paragraph naming the strongest version of this plan}

> **What is the gap between 10/10 and what is shipping?**
> {name the specific gap; OR "None." followed by ≥1 substantive sentence on what the strongest-version check surfaced}

> **Owner's waiver:**
> > "{owner's verbatim words approving the specific gap — a NESTED blockquote referencing a keyword from the gap; if there is no gap, write: none required}"
```

## Verification Criteria Rules

- A constraint must name something checkable — a file or a command. "Don't make things up" isn't a constraint yet.
- Every numbered AC from `00-scope.md` maps to at least one criterion.
- Each machine criterion is one `- ` line in this exact format (single source of truth — `lib/criteria-parser.js`; consumed by both `scripts/story-gate.js` seal validation and `scripts/criteria-runner.js`):
  - `- <description> → \`<command>\``
  - The description before the arrow MUST be non-empty. A line of the form `- → \`cmd\`` is rejected as malformed — the gate will fail and the runner will skip it.
  - The arrow `→` is flanked by whitespace.
  - The command lives in backticks; it must contain no embedded backticks and no newlines.
- Run every command once before sealing.
- If a criterion cannot be machine-verified, write it as `**Manual QA:** ...` and name the exact observable check.
- No command may pass when the user-facing outcome is broken.

## Bunshin QC

- Required before presenting or sealing this stage artifact.
- Run Bunshin in a fresh named context with the artifact path, the draft owner-facing approval prompt, the approved framing/scope, and the specific stage risks.
- Bunshin must audit both the artifact and owner-facing presentation.
- Owner-facing presentation must follow the compact `config/agent-voice/formatting/coding-agent.md` worked-example shape: summary, numbered items when useful, conclusion/decision, next step.
- The user-facing block must be max 18 meaningful lines, plain English, and owner-value first.
- Technical verification must not lead the user-facing block.
- Bunshin returns JSON with `verdict: "PASS" | "FAIL"` and literal-line findings.
- On FAIL, revise the artifact and rerun Bunshin before presenting it.
- If the tool cannot honestly run a named Bunshin context, block the stage or record the user's explicit waiver. Miyagi self-audit is not Bunshin approval.

## Steps

1. Require approved scope:

```bash
if [ -z "${STORY_ID:-}" ]; then
  STORY_ID=$(node ~/robotdojo/scripts/active-story.js --stage plan) || exit 1
fi
STORY_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --require scope --story "$STORY_ID"
RC=$?
if [ "$RC" -eq 2 ]; then
  # Predecessor sealed but not yet countersigned. Invoking THIS exact-next skill
  # IS the countersign (st_6f81e248). Auto-approve, then continue.
  node ~/robotdojo/scripts/story-gate.js --approve scope --story "$STORY_ID" || exit 1
elif [ "$RC" -ne 0 ]; then
  # Exit 1: predecessor not sealed at all -> wrong/skipped stage. HALT.
  exit "$RC"
fi
# RC == 0: predecessor fully signed already. Proceed. --approve is idempotent.
```

1b. Retrieve relevant prior decisions + lessons (history grounding — emits no stage event):

```bash
PRIOR=$(node ~/robotdojo/scripts/related-context.js --story "$STORY_ID" --format markdown 2>/dev/null \
  || echo "_history retrieval unavailable — proceed on scope + research_")
```

   Paste `$PRIOR` verbatim into the Ori brief below under a "Prior decisions (retrieved)" heading. It is the ranked candidate list — past stories/defects/work plus memory-log lessons — carrying supersession flags and on-demand pointers. Do NOT bulk-read: Ori opens only the pointed artifacts/entries it judges relevant.

2. If M or L, spawn Ori before drafting.

   Brief for Ori: quote framing, ACs, recommendation verbatim; design/review per Ori's Output contract. Ground the design in the retrieved Prior decisions + lessons above — open the pointed artifacts and memory entries for the top candidates on demand; do not rebuild on a superseded decision or repeat a settled mistake, and when a decision re-litigates a surfaced one, cite it and state why it now changes.

   S plans: Miyagi drafts directly.

   Draft `02-plan.md`. Present the plan and verification criteria. Stop unless the user approves them.

3. On approval, seal:

```bash
node ~/robotdojo/scripts/story-gate.js --record-bunshin plan --verdict PASS --file "$STORY_DIR/02-plan.md" --story "$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --seal plan --file "$STORY_DIR/02-plan.md" --story "$STORY_ID"
node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.stage='plan-sealed'; m.updated_at=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

4. Stop. Print only:

```text
Plan sealed for {story_id}. {N} verification criteria.
Say "yes" or invoke the next stage to proceed.
Next: /build
```
