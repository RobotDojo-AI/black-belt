---
name: framing
description: Draft and seal the user-value framing for an active story or defect.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: pipeline
---

# /framing
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Frame the active story or defect. One artifact, explicit approval, then stop. Do not auto-invoke /research.

## Contract

Reads: active story `00-scope.md` and `meta.json`.

Produces: `## Framing` for stories or `## Defect framing` for defects appended to `00-scope.md`; sealed `framing` stage.

Stops with: framed summary and `Next: /research`.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Rules

- If the user has not approved the exact framing in the current exchange, present the framing and stop.
- If the user explicitly approves the exact framing, append it, seal `framing`, and stop.
- Stories use: `As a [specific user], I want [felt capability] so that [human outcome].`
- Defects use: `[Expected behavior] is no longer true. Observable symptom: [symptom].`
- Frame from the user's point of view first: what they can do, feel, trust, avoid, or understand.
- Backend, process, database, deployment, and agent-work stories must still name the user-visible value they protect. Infrastructure is the means, never the framing.
- If the first honest framing is mostly technical, rewrite it until the user value is load-bearing. Put technical implementation language in research/scope/plan, not the framing sentence.
- Framing must name the class of problem, not only the triggering instance.

## Steps

1. Orient:

```bash
if [ -z "${STORY_ID:-}" ]; then
  STORY_ID=$(node ~/robotdojo/scripts/active-story.js --stage framing) || exit 1
fi
STORY_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$STORY_ID"
cat "$STORY_DIR/00-scope.md"
```

2. Present one framing sentence. Stop unless the user explicitly approves it.

3. On approval, append and seal:

```bash
FRAMING_HEADING=$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$STORY_DIR/meta.json','utf8')); process.stdout.write(m.type === 'defect' ? '## Defect framing' : '## Framing');")
cat >> "$STORY_DIR/00-scope.md" << EOF

---

$FRAMING_HEADING

**{approved framing sentence verbatim}**

{1-2 sentences explaining the user-visible done state.}
EOF
node ~/robotdojo/scripts/story-gate.js --seal framing --file "$STORY_DIR/00-scope.md" --story "$STORY_ID"
node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.stage='framing-sealed'; m.updated_at=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

4. Stop. Print only:

```text
Framing sealed for {story_id}.
Say "yes" or invoke the next stage to proceed.
Next: /research
```
