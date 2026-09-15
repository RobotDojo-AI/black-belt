---
name: topic
description: Universal Topic opener. Resolves a topic by name, loads its live substrate (INDEX/SYNTHESIS/LOG/SESSION-STATUS) at open, and writes a 4-section Decision/Why/Citations/Next-session-anchors synthesis to the topic's LOG.md and SESSION-STATUS.md at close. Same last state and next steps as the web Recap. Supersedes /work.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: tool
---

# /topic
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Universal Topic opener and closer. One ritual for every topic: resolve the topic, load substrate + latest synthesis at open, write a 4-section synthesis at close. Append-only. Web Recap reads the same latest_state and next_action.

## Contract

Reads on open: the topic name (topic slug, person, company, or place). The name is resolved fuzzily (case-insensitive; spaces and hyphens interchangeable) and the topic's live resume payload is loaded — its current question, latest_state, next_action, and indexed substrate (`INDEX.md` / `SYNTHESIS.md` / `LOG.md` / `SESSION-STATUS.md`).

Writes on open: a session record at `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/{work_id}/` with `meta.json`, `stage-hashes.json`, `00-scope.md`, and `open-payload.json` capturing the loaded resume payload.

Writes on close: a 4-section synthesis (Decision · Why · Citations · Next-session-anchors) appended to the resolved topic's `LOG.md`, with `SESSION-STATUS.md` updated. For a topic, the chat-readable topic-context copy in the database is also kept current so chat can recall the session's durable conclusions.

Stops when: open prints the topic id and the substrate citations; close writes the synthesis to the topic and prints the topic-session-close message.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Canonical use cases

- `/topic {name}` — open any registered topic: `health`, `coaching`, a topic slug, a person slug, a company slug. Substrate and synthesis history load automatically. Same last state as the web Recap.
- `/topic` (no argument) — exploratory work without binding to a topic. Use only when there is no existing topic to attach to.
- `/health` — same as `/topic health`. Not a separate skill.
- `/coach` — same as `/topic coaching`. Not a separate skill.
- `/work {name}` — same as `/topic {name}`. Not a separate skill.

## Steps

### Step 0: Aliases

If the user typed `/health`, run this skill as `/topic health`. If `/coach`, run as `/topic coaching`. If `/work {name}`, run as `/topic {name}`. Do not look for a health, coach, or work skill.

### Step 0b: Read canonical references

Read `architecture/sitemap.md` and `architecture/ontology.md` before any other action.

### Step 1: OPEN — initialize record + load substrate

```bash
# Set WORKBENCH to the topic name from `/topic <name>` (e.g. health, coaching, a topic/person/company slug).
# Leave empty only for unbound exploratory work. The agent substitutes the value; the `${1:-}` default
# is the no-argument (exploratory) fallback. WORKBENCH is the CLI flag name for story-init.
WORKBENCH="${1:-}"
# Bind the record to its topic at creation (df_974525f2): --workbench writes
# the binding the close backstop matches on, and it activates story-init's
# find-or-create dedup — if the UserPromptSubmit hook already opened a record
# for this topic, that record is reused instead of forking a second one.
# Exploratory opens (empty WORKBENCH) stay flagless.
WB_FLAG=(); [ -n "$WORKBENCH" ] && WB_FLAG=(--workbench "$WORKBENCH")
STORY_ID=$(node ~/robotdojo/scripts/story-init.js --type work \
  --domain "robotdojo" \
  "${WB_FLAG[@]}" \
  --name "${WORKBENCH:-exploratory}-$(date +%Y%m%d-%H%M%S)" \
  --desc "${WORKBENCH:-exploratory} session" \
  --quiet)
WORK_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$STORY_ID"
node -e "const fs=require('fs'); const p='$WORK_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.kanban='in-progress'; m.stage='work-open'; m.updated_at=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); fs.writeFileSync(p, JSON.stringify(m,null,2));"

cat > "$WORK_DIR/00-scope.md" << EOF
# Work: ${WORKBENCH:-exploratory}

## Original request

> "{the user's exact words, verbatim}"
EOF

if [ -n "$WORKBENCH" ]; then
  # Resolve + open via the live topic path: fuzzy name resolution, self-registers
  # new topics, indexes for RAG, returns the resume payload. Ambiguous names or
  # failed opens exit non-zero — stop and surface, never guess.
  ROBOTDOJO_ALLOW_PLAINTEXT=1 node ~/robotdojo/scripts/workbench-open.js \
    --target "$WORKBENCH" --json > "$WORK_DIR/open-payload.json"
fi

echo "$STORY_ID"
echo "Topic session open."
```

### Step 2: Cite from the substrate

For topic-bound sessions, read `$WORK_DIR/open-payload.json`. The resume fields
live under `.payload` (the file is `{ ok, created, errors, indexed, payload, contract }`).
In the first response:

- Quote ≥5 verbatim words from `payload.latest_state` or `payload.current_question` — the topic's loaded prior context.
- Name the `payload.next_action` (the anchor for where this session picks up).
- Name ≥1 item from `payload.deep_links` or `payload.indexed_substrate` (the indexed substrate this topic exposes — `INDEX.md` / `SYNTHESIS.md` / `LOG.md` / `SESSION-STATUS.md` and substrate files).

If `open-payload.json` is empty or `.ok` is false, the open failed — surface the error and stop; do not fabricate a citation.

Then begin the conversation.

Chat answers in ordinary spoken chat prose. Never print labeled fields. Recap is a normal message, not a button.

### Step 3: CLOSE — `/close` is the command

Closing a topic session uses `/close`, the same command that closed a workbench. Do not invent a second close command. `/close` drafts the 4-section resume, writes it to the topic log, and marks the work record done via `work-close.js`. The resume is for Miyagi, not a labeled recap card.

**Backstop first (st_862d73d1 AC1).** A `/topic` session cannot close without a tracked record. Before drafting the synthesis, require one — this is the surface-independent floor that holds even where the UserPromptSubmit hook does not run (web app, Cursor, a machine with no hook installed):

```bash
WORK_ID=$(node ~/robotdojo/scripts/active-story.js --work-stage "${WORKBENCH:-}") || {
  echo "BLOCKED — no tracked work record for this session. It was never opened with story-init.js (Step 1). Open the record before closing so the session is not untracked." >&2
  exit 1
}
```

When the user signals end-of-session, draft a synthesis in this shape:

```
# {Title}

_Session: {YYYY-MM-DD}_

## Decision
{one paragraph}

## Why
{mechanism + verbatim quote blockquotes for every load-bearing claim}

## Citations
- {≥1 corpus citation or verbatim ≥5-word quote}

## Next-session anchors
- {≥1 anchor for the next session}
```

### Step 4: Save the session back to the topic

The resolved topic `root` comes from the open payload via the tolerant reader
`scripts/work-open-payload-root.js` (df_974525f2). Write the synthesis to disk, then persist it.

**Write the synthesis to a file** so the append step has a known source:

```bash
SYNTH_FILE="$WORK_DIR/close-synthesis.md"
# Write the drafted 4-section synthesis (Decision / Why / Citations / Next-session anchors) to "$SYNTH_FILE".
```

**Append to LOG.md + update SESSION-STATUS.md** against the resolved topic root:

```bash
# Hard guard (df_974525f2): if the payload cannot be read or the resolved
# topic root does not exist on disk, STOP before any append — never write
# the synthesis to the repo root.
WB_ROOT=$(node ~/robotdojo/scripts/work-open-payload-root.js "$WORK_DIR/open-payload.json") && [ -d "$HOME/robotdojo/$WB_ROOT" ] || { echo "BLOCKED — work-open payload unreadable or topic root missing; fix the open record before closing." >&2; exit 1; }
WB_ABS="$HOME/robotdojo/$WB_ROOT"
DATE=$(date +%Y-%m-%d)

# LOG.md: append the session synthesis (LOG.md is guaranteed to exist by the topic scaffold).
printf '\n\n---\n\n## Work session %s\n\n' "$DATE" >> "$WB_ABS/LOG.md"
cat "$SYNTH_FILE" >> "$WB_ABS/LOG.md"

# SESSION-STATUS.md: record this session and the next-session anchor.
printf '\n## Session %s\n\nNext-session anchor: %s\n' "$DATE" "{the next-session anchor from the synthesis}" >> "$WB_ABS/SESSION-STATUS.md"

WB_ID=$(node ~/robotdojo/scripts/work-open-payload-root.js --id "$WORK_DIR/open-payload.json" 2>/dev/null)
[ -n "$WB_ID" ] && ROBOTDOJO_ALLOW_PLAINTEXT=1 node ~/robotdojo/scripts/workbench-synthesize.js --id "$WB_ID" --json
```

**Keep the chat-readable topic-context copy current (topics only).**
For a session whose primary attachment is a topic, upsert the database topic-context
cache so chat/RAG recalls this session's durable conclusions. Skip this for entity
(person/company/place) sessions — they have no `user_topics` row, and the LOG.md +
SESSION-STATUS.md writes above are their durable record.

```bash
# Same tolerant reader (df_974525f2), --topic mode: prints the primary topic
# attachment's target_id, or nothing for an entity session. A failed read
# yields an empty TOPIC_SLUG, which skips the upsert below.
TOPIC_SLUG=$(node ~/robotdojo/scripts/work-open-payload-root.js --topic "$WORK_DIR/open-payload.json" 2>/dev/null) || TOPIC_SLUG=""
if [ -n "$TOPIC_SLUG" ]; then
  ROBOTDOJO_ALLOW_PLAINTEXT=1 node --input-type=module -e "
    import db from '$HOME/robotdojo/lib/db.js';
    import { applyTopicContext } from '$HOME/robotdojo/lib/topic-context-apply.js';
    import fs from 'node:fs';
    const contextMd = fs.readFileSync('$SYNTH_FILE', 'utf8');
    const r = await applyTopicContext(db, { slug: '$TOPIC_SLUG', contextMd, sourceType: 'work-close', source: 'work-close' });
    console.log(JSON.stringify(r));
  "
fi
```

### Step 5: Confirm + close

Print the work-session-close message:

> Closed this topic session. Last state, why, citations, and next-session anchors are in the topic log. `/close` is the same command as workbench close; a pipeline story/defect close only runs when there is no open topic session and QA has passed.

## Aliases

`/health`, `/coach`, and `/work` are not skills. They are names for this skill. There are no stub skill files for them.
