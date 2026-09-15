---
name: asana
description: Narrow-scope utility for Asana API operations during an active pipeline session — call-note writes, board cleanup, field application, dependency cleanup, and other ontology-bound moves grounded in asana-conventions.md.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
  - ~/robotdojo/user/files/asana-conventions.md
type: tool
---

# Skill: asana
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

Narrow-scope utility skill for Asana operations. Invoked WITHIN an active pipeline session (/story, /defect, /work) when Asana work is needed — not a pipeline entry point.

## Contract

Reads: the active session's intent + `~/robotdojo/user/files/asana-conventions.md` for the ontology.

Writes: Asana tasks/projects via the API; no local pipeline artifacts unless the session is recording outcomes.

Stops when: the requested operation completes, its results are reported, and affected entity context files are updated.

## Steps

1. Read `asana-conventions.md` for the live ontology.
2. Confirm the operation type. Surface a destructive-action plan if applicable.
3. Execute the Asana API calls in a batch.
4. Report results: success count, failures with reason, follow-up state changes (orphan dependencies, dedupe candidates).
5. Update entity context files when the operation changes canonical state.

## Canonical use cases

Call /asana when the active session needs:
- Post-call note creation in Asana (memo-style description, the ontology in asana-conventions.md)
- Board cleanup (dedupe duplicates, archive obsolete projects, remove unused custom fields, kill pre-intro cards)
- New card creation AFTER an intro is made (one card per intro, person OR company per the discipline rules)
- Custom field application (Vertical / Geography / Referrer)
- Removing dependency-function links between cards (the convention: @-mentions, not dependencies)
- API-level operations requiring the html_notes XML constraint or other Asana quirks

## What this skill reads

Reads `~/robotdojo/user/files/asana-conventions.md` for:
- Call-note ontology
- Card discipline rules
- Memo styling format
- API patterns and html_notes XML constraints
- Filter heuristics
- Pending stories that affect Asana behavior

## Operating principles

- **Bearer auth from Keychain.** Always: `ASANA_PAT=$(security find-generic-password -s "robotdojo-ASANA_PAT" -w)`. Never paste tokens inline.
- **Memo-style description writes.** No `<p>` at top level of html_notes — use inline `<strong>` followed by `<ul>`. Bold load-bearing labels only.
- **Verify before destructive ops.** Card deletion + project deletion are irreversible — surface explicit list before bulk delete unless user has authorized the full set in the current message.
- **Dedupe by name within a project.** Each entity = one canonical Asana representation. Multi-project membership OK if the entity legitimately belongs in multiple boards.
- **PII gate awareness.** Scripts in `/tmp/` that contain real names will trigger the PII detector hook on write (informational, not blocking on `/tmp/`). Identity files like `asana-conventions.md` must use generic placeholders.

## Common operation patterns

Embed in a Python script or bash + curl. Always batch related operations to minimize API calls.

```bash
ASANA_PAT=$(security find-generic-password -s "robotdojo-ASANA_PAT" -w)
WORKSPACE=<your-asana-workspace-gid>   # from config/asana-routing.json destinations.default.workspace (real gid lives in the gitignored config/asana-routing.user.json)
```

### Update task description (memo style)

```python
html = '<body><strong>Date</strong><ul><li>...</li></ul><strong>Quick summary</strong><ul><li>...</li></ul></body>'
api('PUT', f'/tasks/{gid}', {"data": {"html_notes": html}})
```

### Delete card

```python
api('DELETE', f'/tasks/{gid}')
```

### Set custom field

```python
api('PUT', f'/tasks/{gid}', {"data": {"custom_fields": {field_gid: enum_option_gid}}})
```

### Remove dependency between two cards

```python
api('POST', f'/tasks/{child_gid}/removeDependencies', {"data": {"dependencies": [parent_gid]}})
```

### Merge two projects (move tasks A → B, archive A)

```python
tasks = api('GET', f'/projects/{src}/tasks?limit=100&opt_fields=name,gid')[2]['data']
for t in tasks:
    api('POST', f'/tasks/{t["gid"]}/addProject', {"data": {"project": dst}})
    api('POST', f'/tasks/{t["gid"]}/removeProject', {"data": {"project": src}})
api('PUT', f'/projects/{src}', {"data": {"archived": True}})
```

### Remove custom field from project

```python
api('POST', f'/projects/{project_gid}/removeCustomFieldSetting', {"data": {"custom_field": field_gid}})
```

## Anti-patterns

- Creating per-name cards from a referral-call transcript (violates card-discipline rule).
- Using Asana dependency function for entity relationships (use @-mentions).
- Writing call-note descriptions with h1/h2 size variations (violates memo styling).
- Hard-deleting cards or projects without explicit user authorization in the current message.
- Pasting real personal names into identity files (violates PII gate).

## Output contract

When invoked, the skill should:
1. Read `asana-conventions.md` to ground in current rules.
2. Confirm the operation type and surface destructive-action plan if applicable.
3. Execute the Asana API calls in the appropriate batch.
4. Report results: success count, failures with reason, and any follow-up state changes (e.g., orphan dependencies, dedupe candidates).
5. Update relevant entity context files (`user/contexts/{people,companies,places}/<id>.md`) if the Asana action changes the canonical state (e.g., decision tier, drop reason).

## Pending architectural dependencies

- Auth-gated context rendering on `robotdojo.ai` — until shipped, Asana descriptions link entity context via `file://` paths, not styled web URLs.
- Entity-file UUID → proper-name slug rename — until shipped, entity references in Asana descriptions use UUID-form file paths.
