---
name: qa
description: Verify an approved build against scope, plan, tests, smoke, and production browser checks when relevant.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: pipeline
---

# /qa
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

QA the active story. One artifact, explicit approval, then stop. Do not auto-invoke /close.

## Contract

Reads: approved `build` stage, `00-scope.md`, `02-plan.md`, `03-build.md`, `03b-criteria.md`.

Produces: `04-qa.md`; sealed `qa` stage.

Stops with: PASS/FAIL and `Next: /close` on PASS.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Rules

- QA certifies user-facing behavior, not only code shape.
- A skipped in-scope check is FAIL unless the user explicitly approves the skip.
- Browser QA runs on production for UI/public route changes.
- Vercel-deployed UI/public route changes require deployment freshness proof before browser production QA counts: expected git SHA, deployment URL or alias, `scripts/check-vercel-deployment-freshness.js` PASS output, and screenshots from that verified deployment. The checker fetches `<deploymentUrl>/version.json` (written locally by `scripts/deploy-vercel.sh` before each `vercel --prod` upload) and compares the served SHA to the expected SHA — no Vercel git metadata required.
- If QA fails, stop and return the failing evidence to /build.
- Do not mark story done here. /close does that.
- Spawn budget: `effort: 'medium'`, ceiling 60 tool calls. Report actuals on return.

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

1. Require approved build:

```bash
if [ -z "${STORY_ID:-}" ]; then
  STORY_ID=$(node ~/robotdojo/scripts/active-story.js --stage qa) || exit 1
fi
STORY_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --require build --story "$STORY_ID"
RC=$?
if [ "$RC" -eq 2 ]; then
  # Predecessor sealed but not yet countersigned. Invoking THIS exact-next skill
  # IS the countersign (st_6f81e248). Auto-approve, then continue.
  node ~/robotdojo/scripts/story-gate.js --approve build --story "$STORY_ID" || exit 1
elif [ "$RC" -ne 0 ]; then
  # Exit 1: predecessor not sealed at all -> wrong/skipped stage. HALT.
  exit "$RC"
fi
# RC == 0: predecessor fully signed already. Proceed. --approve is idempotent.
```

2. Map each AC to a QA check. Write the falsifying condition for each AC before running checks.

3. Run, as applicable:

```bash
node --test tests/*.test.js
node ~/robotdojo/scripts/criteria-runner.js --plan "$STORY_DIR/02-plan.md" --story "$STORY_DIR"
curl -sk https://localhost:4338/api/server-health
```

4. For UI/public route changes, run production Chrome QA with screenshots. Localhost browser QA is not enough. If the route is Vercel-deployed, first run:

```bash
node ~/robotdojo/scripts/check-vercel-deployment-freshness.js --expected-sha <sha> --deployment-url <url> --write-inspect "$STORY_DIR/vercel-inspect.json"
```

The QA artifact must record the expected SHA, deployment URL or alias, freshness PASS output, and screenshot paths.

5. Write `04-qa.md`. The `## 10/10 self-audit` section is the seal contract enforced by `check-self-audit-section.js` — three blockquoted questions, the waiver as a NESTED blockquote (`> >`) quoting the owner's verbatim words when a gap exists, or `none required` when there is none. The 4-question quality bar (weakest point / missing dependency / length / structure) is PRE-FLIGHT REASONING that feeds these answers — never the section format itself. Place the self-audit section before the `VERDICT:` line:

```markdown
# QA Report

Story: {story_id}

## AC Coverage

1. AC 1 — PASS/FAIL — evidence

## Checks

1) Tests: PASS — {summary}
2) Criteria: PASS — {summary}
3) Smoke: PASS — {summary}
4) Browser production: PASS/FAIL/SKIP — {summary, expected SHA + deployment URL/freshness proof when Vercel-deployed, screenshot paths, and approval if skipped}

## 10/10 self-audit

> **What does 10/10 look like for this artifact?**
> {one honest paragraph naming the strongest version of this QA pass}

> **What is the gap between 10/10 and what is shipping?**
> {name the specific gap; OR "None." followed by ≥1 substantive sentence on what the strongest-version check surfaced}

> **Owner's waiver:**
> > "{owner's verbatim words approving the specific gap — a NESTED blockquote referencing a keyword from the gap; if there is no gap, write: none required}"

VERDICT: PASS
```

6. Git push step (st_8745309c). Push the current feature branch to origin so the close stage's merge can land. Errors print and continue — the seal is independent of the network push:

```bash
# st_8745309c — auto-push at /qa seal.
CUR_BRANCH=$(git -C "$HOME/robotdojo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ -n "$CUR_BRANCH" ] && [ "$CUR_BRANCH" != "HEAD" ] && [ "$CUR_BRANCH" != "main" ]; then
  git -C "$HOME/robotdojo" push -u origin "$CUR_BRANCH" || echo "qa-push: push failed for $CUR_BRANCH (continuing)."
else
  echo "qa-push: on main, detached HEAD, or no branch — skipping push (auto-push runs only on feature branches)."
fi
```

7. Seal and stop:

```bash
node ~/robotdojo/scripts/story-gate.js --record-bunshin qa --verdict PASS --file "$STORY_DIR/04-qa.md" --story "$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --seal qa --file "$STORY_DIR/04-qa.md" --story "$STORY_ID"
node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.stage='qa-sealed'; m.verdict='PASS'; m.updated_at=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

Print only:

```text
QA sealed for {story_id}. VERDICT: {PASS|FAIL}.
Say "yes" or invoke the next stage to proceed.
Next: /close
```
