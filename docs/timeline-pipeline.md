# Timeline pipeline

The timeline pipeline runs as a background job. It is idempotent via
`raw_text_hash` — re-running processes only new or changed signals.

## Manual run

```bash
# Dry run — classify only, no writes, useful to estimate cost.
node scripts/timeline-pipeline.js --dry-run --limit=500

# Full catch-up on a recent window.
node scripts/timeline-pipeline.js --since=2025-01-01

# Full rebuild (slow; runs against every matching email).
node scripts/timeline-pipeline.js
```

## Scheduler (maintenance routines)

The timeline pipeline runs inside the entity pipeline's INGEST leg
(`scripts/maintenance-phases.js --phase INGEST`), scheduled continuously by
the `pipeline_ingest` routine (`lib/maintenance-routines.js`) — a
data-arrival trigger from sync drains plus a 15-minute freshness floor.
There is no timeline launchd label and no overnight batch (deleted by
st_fd14cdd4).

To run the timeline step ad-hoc, call the CLI directly (see *Manual run*
above).

## Scheduler (Hono / in-process)

If the robotdojo server grows a `lib/scheduler.js`, add an entry:

```js
scheduler.register('timeline:rebuild', 24 * 60 * 60 * 1000, async () => {
  const { default: run } = await import('../scripts/timeline-pipeline.js');
  // scripts/timeline-pipeline.js executes on import; refactor to export
  // main() before mounting in-process.
});
```

The script is currently written as a CLI entry point. To mount in-process,
split main() into an exported function (no top-level invocation) and call
it from the scheduler. This avoids process spawning on a long-running server.

## Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `ANTHROPIC_API_KEY` | yes (via Keychain as `robotdojo-ANTHROPIC_API_KEY`) | Haiku / Sonnet extraction |
| `GOOGLE_MAPS_API_KEY` | optional | Address Validation API for geocoding + verification |
| `ROBOTDOJO_DB` | optional | Override SQLite path (default: `~/.robotdojo/robotdojo.db`) |

## Verification

After the first run, spot-check:

```sql
SELECT doc_type, COUNT(*) FROM key_documents GROUP BY doc_type;
SELECT category, COUNT(*) FROM receipts GROUP BY category;
SELECT person_id, month_start, residency_type, dominant_source, source_count, ROUND(confidence, 2)
FROM address_timeline ORDER BY month_start DESC LIMIT 30;
```

Ground-truth address: whatever the user's current residence is (per their
own identity docs / config). Expect `primary_residence` rows with a
dominant_source in {document, receipt} and confidence ≥ 0.9.

## Cost discipline

- Haiku ~$1 / 1M input tokens. Classification snippet is ~1K tokens.
- Extraction snippet is ~12K tokens. Budget: ~$0.012 per extracted doc.
- A full backfill over 350K emails with ~10% match rate ≈ $40.
- Re-runs are near-free thanks to `raw_text_hash` dedup.
