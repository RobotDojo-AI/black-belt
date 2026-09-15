---
name: scope
description: Draft acceptance criteria and out-of-scope items for an approved research stage.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: pipeline
---

# /scope
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Scope the active story. One artifact, explicit approval, then stop. Do not auto-invoke /plan.

## Contract

Reads: approved `research` stage, `00-scope.md`, `01-research.md`.

Produces: `## Acceptance criteria` and `## Out of scope` appended to `00-scope.md`; sealed `scope` stage.

Stops with: numbered ACs and `Next: /plan`.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Rules

- If the user has not approved the exact AC list in the current exchange, present the ACs and stop.
- ACs are user-observable outcomes. Verification commands belong in /plan.
- No existence-only ACs.
- No agent-created deferrals. Out-of-scope items require the user's explicit approval.
- If an AC says all/every/each, scope must cover the whole class.

## Bunshin QC

- Required before presenting or sealing this stage artifact.
- Run Bunshin in a fresh named context with the artifact path, the draft owner-facing approval prompt, the approved framing/scope, and the specific stage risks.
- Bunshin must audit both the artifact and owner-facing presentation.
- Owner-facing presentation must follow the compact `config/agent-voice/formatting/coding-agent.md` worked-example shape: summary, numbered items when useful, conclusion/decision, next step.
- The user-facing block must be max 18 meaningful lines, plain English, and owner-value first.
- Technical verification must not lead the user-facing block.
- Bunshin returns JSON with `verdict: "PASS" | "FAIL"` and literal-line findings.
- OOS: per-item finding required (rework-cost flag or clearance). Empty findings = FAIL.
- On FAIL, revise the artifact and rerun Bunshin before presenting it.
- If the tool cannot honestly run a named Bunshin context, block the stage or record the user's explicit waiver. Miyagi self-audit is not Bunshin approval.

## Steps

1. Require approved research:

```bash
if [ -z "${STORY_ID:-}" ]; then
  STORY_ID=$(node ~/robotdojo/scripts/active-story.js --stage scope) || exit 1
fi
STORY_DIR="$HOME/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --require research --story "$STORY_ID"
RC=$?
if [ "$RC" -eq 2 ]; then
  # Predecessor sealed but not yet countersigned. Invoking THIS exact-next skill
  # IS the countersign (st_6f81e248). Auto-approve, then continue.
  node ~/robotdojo/scripts/story-gate.js --approve research --story "$STORY_ID" || exit 1
elif [ "$RC" -ne 0 ]; then
  # Exit 1: predecessor not sealed at all -> wrong/skipped stage. HALT.
  exit "$RC"
fi
# RC == 0: predecessor fully signed already. Proceed. --approve is idempotent.
cat "$STORY_DIR/00-scope.md"
cat "$STORY_DIR/01-research.md"

# st_8745309c — session-conflict surface (non-blocking).
# Capture for inclusion in the scope artifact's preamble when WARN.
SAFE_TO_START_OUT=$(node ~/robotdojo/scripts/check-session-conflicts.js --story "$STORY_ID" 2>/dev/null || echo "")
case "$SAFE_TO_START_OUT" in
  WARN:*)
    printf '%s\n' "$SAFE_TO_START_OUT" ;;
esac
```

2. Present the exact numbered ACs and out-of-scope list. Stop unless the user approves them. If the conflict check above emitted WARN, include the reason in the scope preamble so the user sees it at the point of approval.

   Use the deterministic renderer so the presented shape matches `config/agent-voice/formatting/coding-agent.md` without depending on model memory:

   ```bash
   node ~/robotdojo/scripts/render-scope.js "$STORY_DIR/00-scope.md"
   ```

3. On approval, append the ACs, the out-of-scope list, and the canonical `## 10/10 self-audit` section, then seal.

   The self-audit section is the seal contract enforced by `check-self-audit-section.js` — append the template below (Q1/Q2/Q3 + the waiver as a nested `> >` owner quote, or `none required`).

```bash
cat >> "$STORY_DIR/00-scope.md" << 'EOF'

---

## Acceptance criteria

1. {observable outcome}
2. {observable outcome}

## Out of scope

1. {explicit exclusion or "None."}

## 10/10 self-audit

> **What does 10/10 look like for this artifact?**
> {one honest paragraph naming the strongest version of this scope}

> **What is the gap between 10/10 and what is shipping?**
> {name the specific gap; OR "None." followed by ≥1 substantive sentence on what the strongest-version check surfaced}

> **Owner's waiver:**
> > "{owner's verbatim quote referencing a keyword from the gap; or write: none required}"
EOF
node ~/robotdojo/scripts/story-gate.js --record-bunshin scope --verdict PASS --file "$STORY_DIR/00-scope.md" --story "$STORY_ID"
node ~/robotdojo/scripts/story-gate.js --seal scope --file "$STORY_DIR/00-scope.md" --story "$STORY_ID"
node -e "const fs=require('fs'); const p='$STORY_DIR/meta.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.stage='scope-sealed'; m.updated_at=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z'); fs.writeFileSync(p, JSON.stringify(m,null,2));"
```

4. Stop. Print only:

```text
Scope sealed for {story_id}. {N} ACs.
Say "yes" or invoke the next stage to proceed.
Next: /plan
```
