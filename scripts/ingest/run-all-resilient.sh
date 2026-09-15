#!/usr/bin/env bash
#
# scripts/ingest/run-all-resilient.sh — st_8c7b7a6b self-heal wrapper
#
# Runs scripts/ingest/run-all.js in a retry loop: if the script exits
# non-zero AND there are still unembedded chunks remaining, wait a
# back-off interval and retry. This survives:
#
#   - local embedding model load failures that exhaust the in-process retry
#   - transient process failures that kill the parent node process
#   - any other transient infra failure
#
# Exits 0 only when:
#   (a) run-all.js exits 0 (clean finish), OR
#   (b) there are zero unembedded chunks remaining (work is done even
#       if the last run failed somewhere downstream)
#
# Exits 1 only after MAX_ATTEMPTS have been exhausted AND chunks still
# unembedded.
#
# Usage:
#   ROBOTDOJO_ALLOW_PLAINTEXT=1 bash scripts/ingest/run-all-resilient.sh

set -u

MAX_ATTEMPTS="${MAX_ATTEMPTS:-12}"   # 12 attempts × 60s backoff ≈ 12 retries over 12+ hours
BACKOFF_SECS="${BACKOFF_SECS:-60}"
LOG_PREFIX="${LOG_PREFIX:-/tmp/run-all-resilient}"

attempt=0
while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  echo "[resilient] attempt $attempt/$MAX_ATTEMPTS starting at $(date -u +%H:%M:%S)"

  log="${LOG_PREFIX}-${attempt}.log"
  node "$(dirname "$0")/run-all.js" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}

  remaining=$(ROBOTDOJO_ALLOW_PLAINTEXT=1 node --input-type=module -e "
    import db from '$(dirname "$0")/../../lib/db.js';
    const r = db.prepare(\"SELECT COUNT(*) AS n FROM chunks WHERE embedded=0 AND skip_embed=0 AND topic IS NOT NULL\").get();
    process.stdout.write(String(r.n));
  " 2>/dev/null || echo "unknown")

  echo "[resilient] attempt $attempt: exit=$rc remaining=$remaining"

  if [ "$rc" -eq 0 ] || [ "$remaining" = "0" ]; then
    echo "[resilient] success at attempt $attempt"
    exit 0
  fi

  echo "[resilient] backing off ${BACKOFF_SECS}s before next attempt"
  sleep "$BACKOFF_SECS"
done

echo "[resilient] exhausted $MAX_ATTEMPTS attempts — giving up"
exit 1
