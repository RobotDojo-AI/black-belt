---
name: kanban
description: Manage the story board. View columns, move stories, add backlog items. Miyagi's planning surface.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: tool
---

# /kanban
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

Manage the story board. Use it to choose what to work on next, not to run stages.

Continue as Miyagi. This skill adds process, not persona.

## Contract

Reads: the stories index under `~/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/`.

Writes: meta.json kanban-field updates when a story moves; a new backlog record when an idea is added.

Stops when: the board is displayed or the requested move/add completes.

## Canonical use cases

- Display the board to decide what to work on next.
- Move a story between columns (backlog → next → in-progress → done).
- Add a backlog idea via story-init.js (proper st_/df_/wk_ id).
- Prioritize the `next` column when more than three are queued.

---

## Columns

| Column | Meaning |
|--------|---------|
| `backlog` | Ideas — not yet scoped |
| `next` | Prioritized — ready to start |
| `in-progress` | Active story/defect/work |
| `done` | Closed by /close |

---

## Steps

Read the board, then run the requested move/add. Operations are in the Commands section below.

### Read the board

```bash
echo "=== STORY BOARD ===" && echo ""
for dir in ~/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/*/; do
  [ -f "$dir/meta.json" ] || continue
  node -e "
    const m=JSON.parse(require('fs').readFileSync('$dir/meta.json'));
    console.log(JSON.stringify({slug:m.slug,kanban:m.kanban||'unknown',stage:m.stage,description:m.description||'',verdict:m.verdict}));
  "
done | node -e "
  const lines=require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n').filter(Boolean);
  const stories=lines.map(l=>JSON.parse(l));
  const cols=['backlog','next','in-progress','done'];
  cols.forEach(col=>{
    const items=stories.filter(s=>s.kanban===col);
    if(items.length===0) return;
    console.log('');
    console.log('## '+col.toUpperCase());
    items.forEach(s=>{
      const noQA=col==='done'&&!require('fs').existsSync(require('path').join('$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories',s.slug,'04-qa.md'));
      const flag=noQA?' ⚠ no QA report':'';
      console.log('  • '+s.slug+(s.description?' — '+s.description:'')+flag);
    });
  });
  const unknown=stories.filter(s=>!cols.includes(s.kanban));
  if(unknown.length>0){
    console.log('');
    console.log('## UNTRACKED');
    unknown.forEach(s=>console.log('  • '+s.slug+' (kanban: '+s.kanban+')'));
  }
"
```

---

## Commands

**Add to backlog** — when the user gives an idea to hold:

```bash
# Add to backlog using story-init.js — assigns proper st_/df_/wk_ ID visible to all pipeline scripts
STORY_ID=$(node ~/robotdojo/scripts/story-init.js --type story --domain "{domain}" --name "{slug}" --desc "{one-line description}" --quiet)
echo "Added to backlog: $STORY_ID"
```

**Move a story** — set kanban field:

```bash
STORY_DIR=$(ls -td ~/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/*{slug}*/ | head -1)
node -e "
  const m=JSON.parse(require('fs').readFileSync('$STORY_DIR/meta.json'));
  m.kanban='{new-column}';
  const now=new Date().toISOString().replace(/\.\d{3}Z$/,'Z'); m.updated_at=now; require('fs').writeFileSync('$STORY_DIR/meta.json',JSON.stringify(m,null,2));
  console.log('Moved '+m.slug+' → {new-column}');
"
```

**Set next** — explicitly prioritize up to 3 stories:

Read current "next" column. If already 3 items, ask which to deprioritize before adding. This is a judgment call, not automatic — confirm with the user.

**Show index:**

```bash
cat ~/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/index.md 2>/dev/null || echo "No stories yet."
```

---

## Completion

Board displayed or story moved. No artifacts written unless a backlog item was added.
