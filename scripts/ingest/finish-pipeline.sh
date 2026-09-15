#!/usr/bin/env bash
#
# scripts/ingest/finish-pipeline.sh — st_8c7b7a6b end-to-end orchestrator
#
# Runs the remaining pipeline phases in sequence without supervision:
#   1. resilient embed (covers any unembedded chunks)
#   2. T1→T2 iterative reclassifier (Pass 1..N + Sonnet regen of context_md)
#   3. global HNSW build (local Snowflake unified index)
#   4. re-enable launchd jobs + restart server + load topic-edit-watcher
#
# Each step blocks on the previous one's success. The whole script logs
# to /tmp/finish-pipeline.log and writes /tmp/finish-pipeline.done on
# clean exit (so a watcher can detect completion).
#
# Usage:
#   ROBOTDOJO_ALLOW_PLAINTEXT=1 \
#     ANTHROPIC_API_KEY="$(security find-generic-password -s 'robotdojo-ANTHROPIC_API_KEY' -w)" \
#     bash scripts/ingest/finish-pipeline.sh

set -u
exec > >(tee -a /tmp/finish-pipeline.log) 2>&1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

say() { echo "[finish] $(date -u +%H:%M:%S) $*"; }

# Wipe the done marker if a prior run left one stale.
rm -f /tmp/finish-pipeline.done

# -------- Phase 1: resilient embed --------
say "phase 1: resilient embed"
INGEST_CONCURRENCY=${INGEST_CONCURRENCY:-4} \
  MAX_ATTEMPTS=${MAX_ATTEMPTS:-20} \
  BACKOFF_SECS=${BACKOFF_SECS:-60} \
  bash scripts/ingest/run-all-resilient.sh
rc=$?
say "phase 1 exit=$rc"
if [ "$rc" -ne 0 ]; then
  say "FATAL: embed pipeline failed (rc=$rc) — aborting"
  exit 1
fi

# -------- Phase 2: T1→T2 reclassifier --------
say "phase 2: reclassifier"
node scripts/ingest/05-reclassify-chunks.js
rc=$?
say "phase 2 exit=$rc"
if [ "$rc" -ne 0 ]; then
  say "FATAL: reclassifier failed (rc=$rc) — refusing to build ANN over stale topic/context state"
  exit "$rc"
fi

# -------- Phase 3: global HNSW build --------
say "phase 3: HNSW build"
node scripts/build-global-hnsw.js
rc=$?
say "phase 3 exit=$rc"
if [ "$rc" -ne 0 ]; then
  say "FATAL: HNSW build failed (rc=$rc) — refusing to restart into degraded semantic retrieval"
  exit "$rc"
fi

# -------- Phase 4: re-enable launchd + restart server --------
say "phase 4: restart launchd jobs"
launchctl enable "gui/$(id -u)/com.robotdojo.server" 2>/dev/null || true
launchctl enable "gui/$(id -u)/com.robotdojo.chunk-worker" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/com.robotdojo.server.plist" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/com.robotdojo.chunk-worker.plist" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/com.robotdojo.topic-edit-watcher.plist" 2>/dev/null || true

# Wait briefly for the server to come up and confirm health.
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 3 https://localhost:4338/api/server-health 2>/dev/null || echo "000")
  say "post-start t+${i}*3s: http=$code"
  [ "$code" = "200" ] && break
done

# -------- Done --------
say "DONE — pipeline complete"
touch /tmp/finish-pipeline.done
exit 0
