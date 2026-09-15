---
name: close
description: Close a QA-passed story without retrospective or generalization.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: pipeline
---

# /close
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Close the active story. No retrospective. No generalization. One artifact, then done. Invoking /close is the completion signal — it seals close, merges to main, and marks the story done ONLY once its code is verified on origin/main (else a loud `close-unmerged` state), in one pass. No separate approval step.

## Contract

Reads: approved `qa` stage, `04-qa.md`, `03-build.md`, `00-scope.md`.

Produces: `05-close.md`; sealed `close` stage; `meta.json.kanban = done` when the merge landed on origin/main, else `close-unmerged`.

Stops with: story closed.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Rules

- Do not mine process learnings.
- Do not edit skills.
- Do not spawn follow-up stories unless the user explicitly asks.
- Closing is one pass: seal, record the branch tip, merge, then approve. Step 1's QA gate still holds. (Done-only-if-landed and the no-separate-countersign rule are stated above.)

## Close QC

- Bunshin is optional for ordinary close (a formal wrapper over approved QA). Run it only if the close report adds new judgment, a waiver, failed-QA handling, rollback guidance, or product/architecture claims — in a fresh persona-bound context, transcript preserved. Miyagi self-audit is not Bunshin approval.

## Steps

0. **Topic / work session.** Same command as workbench close. For `type: work` (including `/topic`), write Decision/Why/Citations/Next-session-anchors to `$WORK_DIR/close-synthesis.md`, then:

```bash
if node ~/robotdojo/scripts/work-close.js --story "${STORY_ID:-}"; then
  exit 0
fi
```

1. Require approved QA:

```bash
if [ -z "${STORY_ID:-}" ]; then
  STORY_ID=$(node ~/robotdojo/scripts/active-story.js --stage close) || exit 1
fi
STORY_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --require qa --story "$STORY_ID"
RC=$?
if [ "$RC" -eq 2 ]; then
  # Predecessor sealed but not yet countersigned. Invoking THIS exact-next skill
  # IS the countersign (st_6f81e248). Auto-approve, then continue.
  node ~/robotdojo/scripts/story-gate.js --approve qa --story "$STORY_ID" || exit 1
elif [ "$RC" -ne 0 ]; then
  # Exit 1: predecessor not sealed at all -> wrong/skipped stage. HALT.
  exit "$RC"
fi
# RC == 0: predecessor fully signed already. Proceed. --approve is idempotent.
```

2. Write `05-close.md`:

```markdown
# Close Report

Story: {story_id}

## Shipped

{1-3 bullets naming what the user can now do}

## Evidence

- Build: `03-build.md`
- QA: `04-qa.md`

VERDICT: PASS
```

3. Seal close, then record the story-branch tip (df_0bd64903 AC2/AC4). Done is no
   longer written here — the gate derives it from the verified merge (step 4c).
   Record `head_sha` on the feature branch, before the merge, as the exact tip:

```bash
node ~/robotdojo/scripts/story-gate.js --seal close --file "$STORY_DIR/05-close.md" --story "$STORY_ID"
# df_0bd64903 AC4 — feature tip pre-merge; stays reachable after --no-ff, so 4c's is-ancestor check is exact.
HEAD_SHA=$(git -C "$HOME/robotdojo" rev-parse HEAD 2>/dev/null || echo "")
[ -n "$HEAD_SHA" ] && node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.head_sha='$HEAD_SHA'; fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

4. Git merge step (st_8745309c). Merge the feature branch into main and push. Errors print and continue — the seal is independent of git outcomes. A merge conflict here is AC7's intended behavior: the operator resolves it. Runs BEFORE the approval (4c) so done derives from a real merge:

```bash
# st_8745309c auto-merge to main; st_a5baa72c AC11 — `checkout main` destroys uncommitted
# WIP, so stash a dirty tree (incl. untracked) before and pop after. Errors continue; seal
# is independent of git outcomes.
FEATURE_BRANCH=$(git -C "$HOME/robotdojo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
MERGED=0
if [ -n "$FEATURE_BRANCH" ] && [ "$FEATURE_BRANCH" != "main" ] && [ "$FEATURE_BRANCH" != "HEAD" ]; then
  STASHED=0
  if ! git -C "$HOME/robotdojo" diff --quiet || ! git -C "$HOME/robotdojo" diff --cached --quiet; then
    if git -C "$HOME/robotdojo" stash push --include-untracked -m "pre-close-merge-stash-$(date +%s)"; then
      STASHED=1
      echo "close-merge: stashed dirty WIP before cross-branch checkout."
    fi
  fi
  if git -C "$HOME/robotdojo" checkout main 2>/dev/null \
    && git -C "$HOME/robotdojo" merge --no-ff "$FEATURE_BRANCH" -m "merge($STORY_ID): close $FEATURE_BRANCH" \
    && git -C "$HOME/robotdojo" push origin main; then
    MERGED=1
  else
    echo "close-merge: git step failed (continuing — operator may need to resolve conflicts)."
  fi
  if [ "$STASHED" = "1" ]; then
    git -C "$HOME/robotdojo" stash pop \
      && echo "close-merge: restored stashed WIP." \
      || echo "close-merge: stash pop needs manual resolution (your WIP is safe in 'git stash list')."
  fi
else
  echo "close-merge: on main or detached HEAD — skipping merge."
fi
```

4b. Agent-owned prod deploy (st_a5baa72c AC10). After a successful merge, deploy via
    `scripts/deploy-vercel.sh`, gated on a deployable touch
    (`apps/`,`routes/`,`api/`,`middleware.js`,`vercel.json`) and `MERGED=1` (pins the
    merged SHA). Others skip; errors continue — the seal is independent of the deploy:

```bash
# st_a5baa72c AC10 — agent-owned prod deploy, gated on deployable touch + merge.
DEPLOYABLE=$(node -e "
  const fs=require('fs');
  const m=JSON.parse(fs.readFileSync('$STORY_DIR/meta.json','utf8'));
  const t=Array.isArray(m.touches)?m.touches:[];
  const ok=t.some(p=>/^(apps|routes|api)\//.test(p)||p==='middleware.js'||p==='vercel.json');
  process.stdout.write(ok?'1':'0');
")
if [ "$DEPLOYABLE" = "1" ] && [ "$MERGED" = "1" ]; then
  echo "close-deploy: deployable surface + merge succeeded — deploying to prod."
  bash "$HOME/robotdojo/scripts/deploy-vercel.sh" || echo "close-deploy: deploy failed (continuing — close is already sealed)."
elif [ "$DEPLOYABLE" = "1" ]; then
  echo "close-deploy: deployable but merge did not succeed — skipping deploy (would pin a stale SHA)."
else
  echo "close-deploy: no deployable surface touched — skipping deploy."
fi
```

4c. Close approval — the gate is the SOLE done-authority (df_0bd64903 AC2/AC3).
    `--approve close` reads `head_sha` and asks `lib/merge-verify.js` if it is on
    origin/main: `kanban='done'` only if it landed, else the loud `close-unmerged`.
    The inline write sets timestamps/stage only, never the done flag:

```bash
node ~/robotdojo/scripts/story-gate.js --approve close --story "$STORY_ID"
# Timestamps + stage only — kanban is the gate's (done | close-unmerged); stamping
# it here would be the dual-write that caused the false-close.
node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); const now=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); m.stage='close-complete'; m.closed_at=now; m.updated_at=now; fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

4d. Refresh the kanban (st_fdd414de AC4). The gate having set the final kanban state,
    regenerate Queue lanes + `Last updated` and prepend one Recent-History line
    (hand-authored sections stay byte-for-byte). kanban.md is gitignored — LOCAL only,
    do NOT `git add` it. Non-fatal:

```bash
node ~/robotdojo/scripts/kanban-refresh.js --story "$STORY_ID" || echo "kanban-refresh: skipped (continuing)."
```

5. Print the outcome — done only if the code landed, else the loud unmerged state
   (df_0bd64903 AC3):

```bash
FINAL_KANBAN=$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$STORY_DIR/meta.json','utf8')); process.stdout.write(m.kanban||'');")
if [ "$FINAL_KANBAN" = "done" ]; then
  echo "Closed $STORY_ID. Verified on origin/main and marked done."
else
  echo "Closed $STORY_ID — SEALED but NOT landed (kanban=$FINAL_KANBAN). Land the merge, then re-run: story-gate.js --approve close --story $STORY_ID"
fi
```
