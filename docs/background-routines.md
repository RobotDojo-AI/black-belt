# Background Maintenance System

Robot Dojo background work follows one shape:

```text
Signal
→ Dirty marker / queue row
→ Planner
→ Budget / policy gate
→ Worker
→ Artifact write
→ History / ledger
→ Status
```

This covers sync, chunking, embedding, topic tagging, entity linking, topic context, entity context, workbench indexing, workbench promotion, backup, always-on maintenance routines, and trending upgrades.

## Registry

The canonical registry is `config/background-routines.json`.

Every routine declares owner, trigger, cadence, entrypoint, durable write targets, log paths, overlap guard, failure policy, context-write permission, RAG-write permission, backup-write permission, and status surface.

`scripts/check-background-routines.js` validates the registry.

## Queue

Dirty work is stored in `maintenance_queue`.

Examples:

- `topic:career / context_refresh / topic-description-edited`
- `company:<id> / context_refresh / workbench-promotion`
- `person:<id> / context_refresh / trending-upgrade`

Dirty markers set `needs_regen` on the target when applicable.

## Planner

The planner chooses model tier, priority, batch mode, and budget behavior.

Launch default:

- `$25` first-import enrichment cap
- batch by default
- all topics use Sonnet
- top 100 people, companies, and places use Sonnet
- middle tier uses Haiku while budget remains
- long tail uses CPU templates
- trending/referenced entities queue Sonnet upgrades over time
- full-corpus Sonnet requires explicit approval

## Distillation

Raw source data stays in imports, transcripts, files, PDFs, and databases.

RAG preserves evidence.

Workbench logs append.

Workbench `SYNTHESIS.md` and `INDEX.md` rewrite dense current state.

Canonical topic/entity context rewrites compact truth and records history. Raw chat is never appended directly into canonical context.

## Maintenance routines

The overnight batch was deleted (st_fd14cdd4). Recurring upkeep is declared in `lib/maintenance-routines.js` — one freshness window per routine. The server's supervisor probe enqueues any routine whose newest completed run is older than its window; the off-process maintenance worker (`scripts/supervisor-maintenance-worker.mjs`) drains them during idle/quiet windows in bounded slices via `scripts/maintenance-phases.js --phase NAME --max-seconds N`. Nothing waits for a clock time, and everything yields to chat.

## Status

`scripts/background-status.js` answers whether the system is safe to resume integrations.

It checks required product jobs, safe server environment, and loaded state.
