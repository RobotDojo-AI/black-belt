#!/usr/bin/env bash
# scripts/worktree-init.sh — st_8745309c.
#
# Idempotent one-shot setup that isolates a git worktree's Claude Code
# session from the main checkout's production database.
#
# Behavior:
#
#   1. Detect worktree: `.git` is a FILE (git worktrees) OR
#      ROBOTDOJO_WORKTREE=1 is set in the environment.
#   2. Compute a stable temp databases path:
#        /tmp/robotdojo-wt-<worktree-basename>/databases
#   3. Create that directory.
#   4. Write the override into the worktree's .env.local so the next
#      `claude` launch sourced from .env.local picks it up:
#        ROBOTDOJO_DATABASES_ROOT=/tmp/robotdojo-wt-<name>/databases
#        ROBOTDOJO_WORKTREE=1
#
# Re-running is safe — existing .env.local entries with the same keys are
# replaced; other keys are preserved.
#
# Exit codes:
#   0 — worktree initialized OR script ran in main checkout (no-op).
#   1 — usage/IO error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Detect worktree: .git file (not directory) OR explicit env flag.
is_worktree() {
  if [ "${ROBOTDOJO_WORKTREE:-}" = "1" ]; then
    return 0
  fi
  if [ -f "$REPO_ROOT/.git" ] && [ ! -d "$REPO_ROOT/.git" ]; then
    return 0
  fi
  return 1
}

if ! is_worktree; then
  echo "worktree-init: main checkout detected — no isolation needed." >&2
  exit 0
fi

WORKTREE_NAME="$(basename "$REPO_ROOT")"
DB_ROOT="/tmp/robotdojo-wt-${WORKTREE_NAME}/databases"
mkdir -p "$DB_ROOT"

ENV_FILE="$REPO_ROOT/.env.local"
TMP_FILE="${ENV_FILE}.tmp.$$"

# Preserve any existing lines that are NOT the keys we manage. Then append
# the managed values. This keeps unrelated overrides intact across re-runs.
if [ -f "$ENV_FILE" ]; then
  grep -v -E '^(ROBOTDOJO_DATABASES_ROOT|ROBOTDOJO_WORKTREE)=' "$ENV_FILE" > "$TMP_FILE" || true
else
  : > "$TMP_FILE"
fi

{
  echo "# st_8745309c — set by scripts/worktree-init.sh, edits below survive re-runs."
  echo "ROBOTDOJO_DATABASES_ROOT=$DB_ROOT"
  echo "ROBOTDOJO_WORKTREE=1"
} >> "$TMP_FILE"

mv "$TMP_FILE" "$ENV_FILE"

echo "worktree-init: isolation configured."
echo "  worktree:               $REPO_ROOT"
echo "  ROBOTDOJO_DATABASES_ROOT=$DB_ROOT"
echo "  .env.local written:     $ENV_FILE"
echo ""
echo "Next: launch Claude Code in this worktree. The wrapper (or your shell)"
echo "must source .env.local so the env reaches lib/db.js."
