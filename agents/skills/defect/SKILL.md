---
name: defect
description: Start a bug report. Creates the defect record and auto-invokes /framing, which presents a framing sentence and stops for owner approval.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: pipeline
---

# /defect
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Start a defect. Intake creates the record, then auto-invokes /framing — the single forward hop into the first pipeline stage (st_6f81e248). Do not diagnose, research, scope, plan, build, QA, or close from intake. Framing itself presents a framing sentence and stops for owner approval, preserving the explicit owner gate on every stage seal.

## Contract

Reads: the user's bug report, optional trace to a story/AC, optional `--domain`.

Produces: `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/{defect_id}/meta.json`, `stage-hashes.json`, `00-scope.md` with `## Original report`.

Stops with: the defect id, then auto-invokes /framing which presents a framing sentence and stops for approval.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Steps

1. Pick the domain. Default to `robotdojo` unless the user named another domain.
2. Create the record:

```bash
DEFECT_ID=$(node ~/robotdojo/scripts/story-init.js \
  --type defect \
  --domain "{domain}" \
  --name "{kebab-symptom}" \
  --desc "defect: {observable symptom}" \
  --quiet)
DEFECT_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$DEFECT_ID"
node -e "const fs=require('fs'); const p='$DEFECT_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.kanban='in-progress'; m.stage='init'; m.updated_at=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

3. Write the stub. Use only facts the user gave; write `Unknown` for missing repro details.

```bash
cat > "$DEFECT_DIR/00-scope.md" << 'EOF'
# Defect: {slug}

## Original report

> "{the user's exact words, verbatim}"

## Repro

1. {known step or Unknown}
2. Expected: {expected behavior or Unknown}
3. Actual: {actual behavior or Unknown}

## Trace

Story/AC: {story id + AC, or Unknown}
EOF
```

4. Print the defect id, then immediately execute the /framing skill steps with `STORY_ID="$DEFECT_ID"` already set (read `00-scope.md`, draft the defect framing, present, and stop for owner approval). Do not re-infer the active record after intake. Defect framing writes `## Defect framing`, not the story `## Framing` heading. Framing is NOT pre-approved — it presents and halts. The "do not auto-invoke" prohibition exists to prevent skipping stages; framing is the first stage, not a skip.

```text
{defect_id}
Auto-invoking /framing with STORY_ID={defect_id}.
```
