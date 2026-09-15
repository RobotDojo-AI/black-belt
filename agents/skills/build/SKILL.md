---
name: build
description: Execute an approved plan through Katagami, run criteria, and stop for /qa.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: pipeline
---

# /build
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Build the active story. One artifact, explicit approval, then stop. Do not auto-invoke /qa.

## Contract

Reads: approved `plan` stage and `02-plan.md`.

Produces: implementation changes, `03b-criteria.md`, `03-build.md`; sealed `build` stage.

Stops with: build result and `Next: /qa`.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Persona Routing

- Katagami always builds.
- Miyagi briefs Katagami with the full plan, all ACs, verification criteria, files likely touched, and failure manifest.
- Katagami returns only with working code, tests run, and a build report draft. A plan or TODO list is not a return.
- Spawn budget: `effort: 'medium'`, ceiling 80 tool calls. Report actuals on return.

## Rules

- No scope expansion. New adjacent work becomes a new story/defect unless the user amends scope.
- Do not touch `tests/specs/` unless the plan says the spec is authored in /build.
- Run `criteria-runner.js`; never edit `03b-criteria.md` by hand.
- Do not push unless the user explicitly approved it in this exchange.

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

1. Require approved plan:

```bash
if [ -z "${STORY_ID:-}" ]; then
  STORY_ID=$(node ~/robotdojo/scripts/active-story.js --stage build) || exit 1
fi
STORY_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --require plan --story "$STORY_ID"
RC=$?
if [ "$RC" -eq 2 ]; then
  # Predecessor sealed but not yet countersigned. Invoking THIS exact-next skill
  # IS the countersign (st_6f81e248). Auto-approve, then continue.
  node ~/robotdojo/scripts/story-gate.js --approve plan --story "$STORY_ID" || exit 1
elif [ "$RC" -ne 0 ]; then
  # Exit 1: predecessor not sealed at all -> wrong/skipped stage. HALT.
  exit "$RC"
fi
# RC == 0: predecessor fully signed already. Proceed. --approve is idempotent.
cat "$STORY_DIR/02-plan.md"
```

1b. Auto-branch before Katagami writes code (df_0bd64903 AC1). Delegate to the
    shared guard `story-branch.js --ensure`: no-op only when HEAD is already THIS
    story's branch; on main, a different story's branch, or detached HEAD it
    creates/switches to `story/<id>-<slug>` off HEAD. One story, one branch:

```bash
# df_0bd64903 AC1 — settle HEAD onto story/$STORY_ID-<slug> unless already there,
# replacing the old main-only guard whose `else` no-op pooled concurrent stories.
node ~/robotdojo/scripts/story-branch.js --ensure --story "$STORY_ID" \
  || echo "story-branch: --ensure could not settle the branch (continuing)."
```

1c. Generate build memory:

```bash
node ~/robotdojo/scripts/memory-context-packet.js --story "$STORY_ID" > "$STORY_DIR/memory-context.md"
```

1d. Retrieve area-relevant prior decisions + lessons (semantic — distinct from 1c's continuity packet):

```bash
PRIOR=$(node ~/robotdojo/scripts/related-context.js --story "$STORY_ID" --format markdown 2>/dev/null \
  || echo "_history retrieval unavailable — proceed on plan + code_")
```

   Inject `$PRIOR` into the Katagami brief under a "Prior decisions (retrieved — area-relevant)" heading. This answers "what past lesson or decision bears on THESE files"; step 1c's `memory-context.md` answers "where are we in the arc." They are two different tools — keep both blocks labeled.

2. Spawn Katagami with the full brief: `02-plan.md`, AC list, criteria, files touched, failure manifest — plus `"$STORY_DIR/memory-context.md"` and the retrieved Prior decisions block from step 1d. Read the pointed artifacts and memory entries for the top candidates on demand; do not re-implement something a prior story settled or reintroduce a bug a memory lesson already recorded as broken.

3. When Katagami returns, run:

```bash
node ~/robotdojo/scripts/criteria-runner.js --plan "$STORY_DIR/02-plan.md" --story "$STORY_DIR"
```

4. If criteria fail, return failures to Katagami. Do not seal.

5. If criteria pass, write `03-build.md` ending with the `## 10/10 self-audit` section (seal contract enforced by `check-self-audit-section.js`):

```markdown
# Build Report

Commit: {commit or "uncommitted"}
Criteria: {N/N passed}
Tests: {commands run}

## Shipped

{user-visible outcome}

## Deviations

{None, or explicit scope-approved deviation}

## 10/10 self-audit

> **What does 10/10 look like for this artifact?**
> {one honest paragraph naming the strongest version of this build}

> **What is the gap between 10/10 and what is shipping?**
> {name the specific gap; OR "None." followed by ≥1 substantive sentence on what the strongest-version check surfaced}

> **Owner's waiver:**
> > "{owner's verbatim quote referencing a keyword from the gap; or write: none required}"
```

5b. Early PII + voice check at build (st_a5baa72c AC7): gate-pii.sh over touched
    PRODUCT files (`lib/`/`routes/`/`scripts/`/`apps/`/`api/` in `meta.touches`)
    + `03-build.md` — not the gitignored story artifacts (they legitimately
    quote the owner). Also runs the print-to-owner voice gate when persona/skill
    files are touched. A hit BLOCKS the seal:

```bash
# st_a5baa72c AC7 — early PII over touched product files + 03-build.md.
PII_FILES=$(node -e "
  const fs=require('fs');
  const m=JSON.parse(fs.readFileSync('$STORY_DIR/meta.json','utf8'));
  const t=Array.isArray(m.touches)?m.touches:[];
  const prod=t.filter(p=>/^(lib|routes|scripts|apps|api)\//.test(p));
  prod.push('$STORY_DIR/03-build.md');
  process.stdout.write(prod.map(p=>p.startsWith('/')?p:('$HOME/robotdojo/'+p)).join(' '));
")
if [ -n "$PII_FILES" ]; then
  if ! bash "$HOME/robotdojo/scripts/gate-pii.sh" --files $PII_FILES; then
    echo "[build] BLOCKED — owner PII detected in touched product files. Fix before sealing." >&2
    exit 1
  fi
fi
# Voice gate when persona/skill files are touched.
VOICE_TARGETS=$(node -e "
  const fs=require('fs');
  const m=JSON.parse(fs.readFileSync('$STORY_DIR/meta.json','utf8'));
  const t=Array.isArray(m.touches)?m.touches:[];
  const has=t.some(p=>/^agents\/(skills|personas)\//.test(p));
  process.stdout.write(has?'1':'');
")
if [ -n "$VOICE_TARGETS" ]; then
  if ! node "$HOME/robotdojo/scripts/check-print-voice.js" "$HOME/robotdojo/agents/skills/" "$HOME/robotdojo/agents/personas/"; then
    echo "[build] BLOCKED — banned voice patterns in print-to-owner blocks. Fix before sealing." >&2
    exit 1
  fi
fi
```

6. Git commit step (st_8745309c). Stage `meta.touches` files, commit with a stage-attributed message. Errors print and continue — the seal does not depend on the commit:

```bash
# st_8745309c auto-commit; st_a5baa72c AC5 releases active-build claims first (self-excludes via ROBOTDOJO_ACTIVE_STORY).
export ROBOTDOJO_ACTIVE_STORY="$STORY_ID"
node -e "import('$HOME/robotdojo/lib/active-builds.js').then(m=>m.releaseAllForStory('$STORY_ID')).catch(()=>{})" || true
TOUCHES=$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$STORY_DIR/meta.json','utf8')); const t=Array.isArray(m.touches)?m.touches:[]; const r=t.filter(p=>!p.startsWith('/')); process.stdout.write(r.join('\\n'));")
if [ -n "$TOUCHES" ]; then
  echo "$TOUCHES" | while IFS= read -r f; do
    [ -e "$HOME/robotdojo/$f" ] && git -C "$HOME/robotdojo" add -- "$f" || true
  done
  # Also stage the build artifact + criteria.
  git -C "$HOME/robotdojo" add -- "$STORY_DIR/03-build.md" "$STORY_DIR/03b-criteria.md" 2>/dev/null || true
  if git -C "$HOME/robotdojo" diff --cached --quiet; then
    echo "build-commit: nothing staged — skipping commit."
  elif ! node ~/robotdojo/scripts/story-branch.js --assert --story "$STORY_ID"; then
    # df_0bd64903 AC1 — commit-time HEAD assertion.
    echo "build-commit: BLOCKED — HEAD is not this story's branch; refusing wrong-branch commit (see above)." >&2
  elif node "$HOME/robotdojo/scripts/check-preseal-protected-touches.js" --story "$STORY_ID" --fail-if-unapproved; then
    if git -C "$HOME/robotdojo" commit -m "build($STORY_ID): seal build stage"; then
      # df_0bd64903 AC4 — record the branch tip.
      HEAD_SHA=$(git -C "$HOME/robotdojo" rev-parse HEAD 2>/dev/null || echo "")
      [ -n "$HEAD_SHA" ] && node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.head_sha='$HEAD_SHA'; fs.writeFileSync(p, JSON.stringify(m,null,2));"
    else
      echo "build-commit: commit failed (continuing)."
    fi
  else
    echo "build-commit: deferred — protected file(s) need your build approval (see above). Commits automatically once you approve."
  fi
fi
```

7. Seal and stop:

```bash
node ~/robotdojo/scripts/story-gate.js --record-bunshin build --verdict PASS --file "$STORY_DIR/03-build.md" --story "$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --seal build --file "$STORY_DIR/03-build.md" --story "$STORY_ID"
node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.stage='build-sealed'; m.updated_at=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

8. Present the build summary through the deterministic renderer so the shape matches `config/agent-voice/formatting/coding-agent.md` without depending on model memory:

```bash
node ~/robotdojo/scripts/render-build-summary.js "$STORY_DIR/03-build.md"
```

Print only:

```text
Build sealed for {story_id}. Criteria {N/N}.
{if protected files touched: state count — approving authorizes them.}
Say "yes" or invoke the next stage to proceed.
Next: /qa
```
