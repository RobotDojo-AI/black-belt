# Suggestions queue

Append-only queue for revisions to human-authored canonical surfaces
(persona files at `agents/personas/*.md`, and skill files at `agents/skills/*/SKILL.md`).
Source files are edit-locked by the pre-commit gate; this is the only
inbox for proposed changes between sealed approvals.

## File-per-target

One file per protected canonical surface, named after its leaf:
- `agents/personas/Tantei.md` → `Tantei.md`
- `agents/skills/research/SKILL.md` → `research-SKILL.md` (dash-joined)

## Per-suggestion section

```markdown
## 2026-05-12T03:14:00Z — claude-opus-4-7
- source: agent-thread
- status: pending

Proposed addition to Failure modes:
> "Over-mapping. Mapping every file in the codebase when the story touches three modules."

(End suggestion)

---
```

Heading: `## <ISO-8601 timestamp> — <author>` — timestamp doubles as ID.
Key list (always two keys): `source`, `status`.
`source`: `agent-thread` | `manual` | `owner`.
`status`: `pending` | `applied (commit <sha>, story <story_id>)`.
Body: free-form markdown describing the proposed change.
Sentinel: `(End suggestion)` line marks the body's end.
Separator: `---` between suggestions.

## Promotion lifecycle

`/promote` enumerates only `status: pending` sections. On the owner's
explicit `yes`, the suggestion is applied:
- Heading gains `[APPLIED]` prefix: `## [APPLIED] 2026-05-12T03:14:00Z — claude-opus-4-7`.
- `status: pending` is rewritten to `status: applied (commit <sha>, story <story_id>)`.
- The full section stays in the file forever (append-only audit trail).
