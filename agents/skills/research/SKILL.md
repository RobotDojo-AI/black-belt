---
name: research
description: Run internal and external research for an approved framing, then stop for /scope.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: pipeline
---

# /research
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Research the active story. One artifact, explicit approval, then stop. Do not auto-invoke /scope.

## Contract

Reads: approved `framing` stage, `00-scope.md`.

Produces: `01-research.md` with `## Internal`, `## External`, and `## Recommendation`; sealed `research` stage.

Stops with: GO/NO-GO and `Next: /scope`.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Persona Routing

- Tantei maps the codebase and writes `## Internal`.
- Hakase researches external prior art and writes `## External`.
- Miyagi synthesizes `## Recommendation`.
- Bunshin is mandatory mini-QC before `01-research.md` is presented or sealed.
- Spawn budget: `effort: 'medium'`, ceiling 60 tool calls. Report actuals on return.

## Retrieval ladder

Hakase's brief carries this. Climb only as far as the question needs, and record where you stopped.

1. **Local first.** `user/files/research/` (the saved corpus), then the repo, database, and memory log. A question already answered locally generates no fetch. A cached hit is returned with its age stated, so the agent decides whether it is stale — the cache never decides silently.
2. **Direct fetch** of a known URL. Near-free.
3. **Low-cost search** via `robotdojo-BRAVE_API_KEY`, already in the keychain.
4. **Billed search tool.** Only after rung 3 was tried and found insufficient.

Size on evidence, not on a fixed fan-out: pull a small first batch, judge whether it answers the question, widen only if it does not, stop when more sources stop changing the answer.

Every fetched source is saved verbatim to `user/files/research/` with a sidecar recording its URL, fetch date, and content hash — the store is gitignored, so third-party documents cannot be committed. Paying twice for the same document is the failure this prevents.

`hakase_returned` carries `sources_pulled`, `stop_reason`, and `retrieval_rungs` alongside the tool-call ceiling, so one event line shows what the pass spent on both axes.

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

1. Require approved framing:

```bash
if [ -z "${STORY_ID:-}" ]; then
  STORY_ID=$(node ~/robotdojo/scripts/active-story.js --stage research) || exit 1
fi
STORY_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --require framing --story "$STORY_ID"
RC=$?
if [ "$RC" -eq 2 ]; then
  # Predecessor sealed but not yet countersigned. Invoking THIS exact-next skill
  # IS the countersign (st_6f81e248). Auto-approve, then continue.
  node ~/robotdojo/scripts/story-gate.js --approve framing --story "$STORY_ID" || exit 1
elif [ "$RC" -ne 0 ]; then
  # Exit 1: predecessor not sealed at all -> wrong/skipped stage. HALT.
  exit "$RC"
fi
# RC == 0: predecessor fully signed already. Proceed. --approve is idempotent.
cat "$STORY_DIR/00-scope.md"
```

2a. Retrieve relevant prior decisions + lessons (history grounding — emits no stage event):

```bash
PRIOR=$(node ~/robotdojo/scripts/related-context.js --story "$STORY_ID" --format markdown 2>/dev/null \
  || echo "_history retrieval unavailable — proceed on framing + code_")
```

   Paste `$PRIOR` verbatim into the Tantei brief below under a "Prior decisions (retrieved)" heading. It is the ranked candidate list — past stories/defects/work plus memory-log lessons — carrying supersession flags and on-demand pointers. Do NOT bulk-read the archive: Tantei opens only the pointed artifacts/entries it judges relevant.

2. Before spawning Tantei, emit a `tantei_spawned` event via `emitStageEvent` from `lib/stage-events.js` (`stage: 'research'`, `agent: 'miyagi'`, non-empty `subagent_return_id`). After Tantei returns, emit `tantei_returned` with the same ID.

   Brief for Tantei: Quote the approved `## Framing` sentence from `00-scope.md` verbatim — don't make Tantei re-derive the goal from a persona-file default. Map code/data surfaces relevant to it. Ground the map in the retrieved Prior decisions: open the pointed artifacts on demand for the top candidates, carry any SUPERSEDED or FAILED flag forward, and state plainly when nothing bears on this area. Write only `## Internal` to `{story_dir}/01-research.md`: files, symbols, dependencies, risks, mismatch with framing, and a `### Prior decisions` subsection — per Tantei's own Output contract.

   **Tantei skip** — only for net-new greenfield (no codebase to map): present rationale to owner, stop for explicit approval, then emit `tantei_skipped` with `owner_approval: '<owner verbatim>'`.

3. Spawn Hakase. Emit `hakase_spawned` (`agent: 'miyagi'`, non-empty `subagent_return_id`), spawn Hakase to research external prior art relevant to the story framing. After Hakase returns, emit `hakase_returned` (`agent: 'hakase'`, same ID).

   Brief for Hakase: Quote the approved `## Framing` sentence from `00-scope.md` verbatim. Research external prior art, named patterns, frameworks, and anti-patterns relevant to it. Write only `## External` to `{story_dir}/01-research.md`, per Hakase's own Output contract — every external claim needs a real citation.

   **Gate rule**: the research seal requires `hakase_spawned` + `hakase_returned` in the trail (both events, non-empty `subagent_return_id`). No skip path exists for Hakase — external research is required on every story.

4. Append the recommendation:

```markdown
## Recommendation

GO or NO-GO: {verdict}

{1-3 bullets explaining what research changes about scope.}
```

5. Run Bunshin QC on the research artifact (mandatory — research is in BUNSHIN_REQUIRED). When Bunshin returns PASS, record the verdict and seal:

```bash
node ~/robotdojo/scripts/story-gate.js --record-bunshin research --verdict PASS --file "$STORY_DIR/01-research.md" --story "$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --seal research --file "$STORY_DIR/01-research.md" --story "$STORY_ID"
node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.stage='research-sealed'; m.updated_at=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

Print only:

```text
Research sealed for {story_id}: {GO|NO-GO}.
Say "yes" or invoke the next stage to proceed.
Next: /scope
```
