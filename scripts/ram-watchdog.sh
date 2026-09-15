#!/bin/bash
# IDLE_GATED=false
# st_f6315f0b: the watchdog must always run, never gated on idle — its job
# is to detect runaway processes WHILE the user is active. Gating it would
# break its contract. (Bash convention for IDLE_GATED: a top-of-file
# `# IDLE_GATED=false` or `# IDLE_GATED=true` comment, mirrored in JS by
# `export const IDLE_GATED = ...`. The registry check parses both forms.)
#
# RAM watchdog — runs every 60s via com.robotdojo.ramwatch launchd agent.
#
# What it does (in order, every run):
#   1. Kill orphaned claude sessions (PPID=1) + their child trees — always
#   2. Stop Colima if running with 0 containers for 3 consecutive runs (~3 min idle)
#   3. If free RAM < 40%: sudo purge to flush inactive pages
#   4. If free RAM < 10%: kill known offenders, then RSS sweep until > 15%
#
# Flags:
#   --dry-run          Log actions but execute nothing (for testing)
#   --mock-free-pct=N  Override RAM reading with N% free (for threshold testing)
#   --mock-no-memory   Simulate memory_pressure binary missing (for error path testing)

# No set -e: watchdog must be resilient — individual step failures must not abort the run.
set -uo pipefail

LOG=/tmp/ramwatch.log
DRY_RUN=0
MOCK_FREE_PCT=""
MOCK_NO_MEMORY=0
MOCK_CPU=""           # st_f6315f0b: "slot:c1,c2,c3" — inject fake per-slot CPU
MOCK_USER_ACTIVE=""   # st_f6315f0b: "1" forces user_active=1 (skip ioreg read)
SKIP_LAUNCHD_SIGNAL=0 # st_f6315f0b: fixture tests can skip real launchd signaling
ASANA_API_URL_OVERRIDE=""  # st_f6315f0b: redirect Asana POST in tests

for arg in "$@"; do
  case "$arg" in
    --dry-run)            DRY_RUN=1 ;;
    --mock-free-pct=*)    MOCK_FREE_PCT="${arg#*=}" ;;
    --mock-no-memory)     MOCK_NO_MEMORY=1 ;;
    --mock-cpu=*)         MOCK_CPU="${arg#*=}" ;;
    --mock-user-active=*) MOCK_USER_ACTIVE="${arg#*=}" ;;
    --skip-signal|--skip-bootout) SKIP_LAUNCHD_SIGNAL=1 ;;
    --asana-url=*)        ASANA_API_URL_OVERRIDE="${arg#*=}" ;;
  esac
done

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $1" >> "$LOG"; }

# OS-protected processes — removing these breaks the user's current session.
# st_f6315f0b expanded the set: interactive surfaces (Ghostty, Claude),
# launchd itself, and the robotdojo SERVER (com.robotdojo.server) join the
# kernel-essentials list. IDLE_GATED background workers (chunk-worker, sync,
# backup, etc.) are deliberately ABSENT — losing them is recoverable
# on the next launchd fire, so they are first-class kill candidates.
OS_PROTECTED="WindowServer|loginwindow|kernel_task|launchd|Ghostty|Claude|com.robotdojo.server"

# count_procs <pattern> — returns integer count, 0 if none; never exits non-zero
count_procs() { { pgrep -f "$1" 2>/dev/null || true; } | wc -l | tr -d ' '; }

# st_f6315f0b: idle gate sensor used by the per-slot CPU enforcer below.
# Returns integer seconds since last HID event. 0 on parse failure
# (treat as "user is active" — pessimistic by design). Honors --mock-user-active.
get_idle_seconds() {
  if [ -n "$MOCK_USER_ACTIVE" ]; then
    [ "$MOCK_USER_ACTIVE" = "1" ] && echo 0 || echo 9999
    return
  fi
  local out
  out=$(/usr/sbin/ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/{print int($NF/1000000000); exit}')
  echo "${out:-0}"
}

# --- Step 1: Always kill orphaned claude sessions (PPID=1) ---
# When a terminal closes, its children are reparented to PID 1 (launchd).
# An active session in an open terminal has a live terminal parent (PPID != 1).
ZOMBIE_COUNT=0
while IFS= read -r line; do
  PID=$(echo "$line" | awk '{print $1}')
  PROC_PPID=$(echo "$line" | awk '{print $2}')
  CMD=$(echo "$line" | awk '{$1=$2=""; sub(/^[[:space:]]+/, ""); print}')

  [ "$PROC_PPID" != "1" ] && continue
  echo "$CMD" | grep -qw "claude" || continue

  log "KILL zombie claude PID=$PID PPID=$PROC_PPID cmd=$CMD"
  if [ "$DRY_RUN" -eq 0 ]; then
    kill -9 "$PID" 2>/dev/null || true
    pkill -9 -P "$PID" 2>/dev/null || true
  fi
  ZOMBIE_COUNT=$((ZOMBIE_COUNT + 1))
done < <(ps -eo pid=,ppid=,command= 2>/dev/null || true)

[ "$ZOMBIE_COUNT" -eq 0 ] && log "claude: no zombies found"

# --- Step 2: Idle-Colima reaper ---
# Colima holds ~2GB wired RAM the kernel cannot reclaim. If it's running with
# zero containers for 3 consecutive watchdog runs (~3 min), stop it.
# Restart cost is ~10s via `colima start`, so over-eager stop is cheap.
COLIMA_BIN=$(command -v colima 2>/dev/null || true)
COLIMA_IDLE_FILE=/tmp/ramwatch-colima-idle-count
COLIMA_IDLE_THRESHOLD=3

if [ -n "$COLIMA_BIN" ]; then
  if "$COLIMA_BIN" status >/dev/null 2>&1; then
    CONTAINER_COUNT=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
    if [ "$CONTAINER_COUNT" = "0" ]; then
      IDLE_COUNT=$(cat "$COLIMA_IDLE_FILE" 2>/dev/null || echo "0")
      IDLE_COUNT=$((IDLE_COUNT + 1))
      log "colima: idle (0 containers) count=$IDLE_COUNT/$COLIMA_IDLE_THRESHOLD"
      if [ "$IDLE_COUNT" -ge "$COLIMA_IDLE_THRESHOLD" ]; then
        log "colima: stopping after $IDLE_COUNT idle runs"
        [ "$DRY_RUN" -eq 0 ] && "$COLIMA_BIN" stop >/dev/null 2>&1 &
        echo "0" > "$COLIMA_IDLE_FILE"
      else
        echo "$IDLE_COUNT" > "$COLIMA_IDLE_FILE"
      fi
    else
      log "colima: $CONTAINER_COUNT container(s) active, reset idle count"
      echo "0" > "$COLIMA_IDLE_FILE"
    fi
  else
    # Colima stopped or not initialized — keep counter at 0
    [ -f "$COLIMA_IDLE_FILE" ] && echo "0" > "$COLIMA_IDLE_FILE"
  fi
fi

# --- Step 2.5: robotdojo background worker CPU enforcer (st_f6315f0b) ---
# For every running com.robotdojo.* slot whose entrypoint declares
# IDLE_GATED=true:
#   1. Sample %CPU once (via `ps -o %cpu=` against the slot's PID).
#   2. Append the sample to a per-slot rolling window file
#      /tmp/robotdojo-watchdog-cpu/${slot}.samples (keep last 3).
#   3. If all 3 samples > 20% AND user is active (HIDIdleTime < 300) AND
#      slot is not OS_PROTECTED → terminate the current run + POST one Asana task
#      (12h dedup TTL via /tmp/robotdojo-watchdog-asana-${slot}.lock).
#
# The contract is "the watchdog acts on robotdojo's own family." Three
# consecutive samples means a single transient spike won't trigger.
# IDLE_GATED=false slots are NEVER booted (the server, the warmup probe,
# ram-watchdog itself, etc.).

CPU_SAMPLE_DIR=/tmp/robotdojo-watchdog-cpu
mkdir -p "$CPU_SAMPLE_DIR" 2>/dev/null || true

CPU_BURN_THRESHOLD=20    # percent of one core
CPU_SAMPLE_COUNT=3        # required consecutive over-threshold samples

USER_IDLE_SECONDS=$(get_idle_seconds)
USER_ACTIVE=$([ "$USER_IDLE_SECONDS" -lt 300 ] && echo 1 || echo 0)

# Enumerate every running com.robotdojo.* slot via launchctl list.
# Output format: "PID Status Label" (PID == "-" for not-running).
SLOTS=$(launchctl list 2>/dev/null | awk '$3 ~ /^com\.robotdojo\./ {print $1 "|" $3}' || true)

if [ -n "$MOCK_CPU" ]; then
  # Test injection: --mock-cpu="com.robotdojo.test:25,30,28"
  # Bypass live process scan; treat the mock as if SLOTS == that slot.
  MOCK_SLOT="${MOCK_CPU%%:*}"
  MOCK_SAMPLES="${MOCK_CPU#*:}"
  SLOTS="0|${MOCK_SLOT}"
fi

while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  SLOT_PID="${entry%%|*}"
  SLOT_LABEL="${entry#*|}"

  # Skip OS_PROTECTED entries. The server label is in OS_PROTECTED on purpose.
  if echo "$SLOT_LABEL" | grep -qE "$OS_PROTECTED"; then
    continue
  fi

  # Resolve the entrypoint script for this slot and check IDLE_GATED.
  PLIST_PATH="$HOME/Library/LaunchAgents/${SLOT_LABEL}.plist"
  [ ! -f "$PLIST_PATH" ] && continue

  # Extract the first ProgramArguments entry that looks like a repo script.
  # Use a quiet PlistBuddy read.
  EP_RAW=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$PLIST_PATH" 2>/dev/null \
    | tr -d '"' \
    | grep -oE "$HOME/robotdojo/[^[:space:]]+\.(js|sh)" \
    | head -1 || true)
  [ -z "$EP_RAW" ] && continue

  # Read IDLE_GATED declaration. JS or bash form. Only IDLE_GATED=true is
  # in scope — false means "let it run while user is active by design."
  if grep -qE 'export[[:space:]]+const[[:space:]]+IDLE_GATED[[:space:]]*=[[:space:]]*true' "$EP_RAW" 2>/dev/null; then
    SLOT_IDLE_GATED=true
  elif head -20 "$EP_RAW" 2>/dev/null | grep -qE '^#[[:space:]]*IDLE_GATED[[:space:]]*=[[:space:]]*true'; then
    SLOT_IDLE_GATED=true
  else
    SLOT_IDLE_GATED=false
  fi

  [ "$SLOT_IDLE_GATED" != "true" ] && continue

  # Sample %CPU. ps -o %cpu= prints just the value with no header.
  if [ -n "$MOCK_CPU" ]; then
    # The first call to this loop iteration uses the first mock sample, etc.
    # But the sample-window file must accumulate across calls. To simulate
    # three consecutive samples in ONE invocation (for tests), we directly
    # write the comma-separated list as the rolling-window contents.
    SAMPLE_FILE="$CPU_SAMPLE_DIR/${SLOT_LABEL}.samples"
    # Overwrite with the mocked samples (one per line for grep counting).
    echo "$MOCK_SAMPLES" | tr ',' '\n' > "$SAMPLE_FILE"
  else
    [ "$SLOT_PID" = "-" ] && continue       # slot loaded but not running
    SAMPLE=$(ps -p "$SLOT_PID" -o %cpu= 2>/dev/null | awk '{print $1; exit}' || echo "0")
    SAMPLE_INT=$(printf '%.0f' "$SAMPLE" 2>/dev/null || echo "0")
    SAMPLE_FILE="$CPU_SAMPLE_DIR/${SLOT_LABEL}.samples"
    # Append + keep only last N lines.
    echo "$SAMPLE_INT" >> "$SAMPLE_FILE"
    tail -n "$CPU_SAMPLE_COUNT" "$SAMPLE_FILE" > "${SAMPLE_FILE}.tmp" && mv "${SAMPLE_FILE}.tmp" "$SAMPLE_FILE"
  fi

  # Read back the rolling window and check if all N samples > threshold.
  WINDOW=$(cat "$SAMPLE_FILE" 2>/dev/null || echo "")
  N=$(echo "$WINDOW" | grep -c -v '^$' || true)
  OVER=$(echo "$WINDOW" | awk -v t="$CPU_BURN_THRESHOLD" '$1+0 > t {n++} END {print n+0}')

  if [ "$N" -ge "$CPU_SAMPLE_COUNT" ] && [ "$OVER" -ge "$CPU_SAMPLE_COUNT" ] && [ "$USER_ACTIVE" = "1" ]; then
    log "BURN $SLOT_LABEL: ${N} consecutive samples > ${CPU_BURN_THRESHOLD}% during active session (idle=${USER_IDLE_SECONDS}s)"
    log "TERMINATE $SLOT_LABEL"
    if [ "$DRY_RUN" -eq 0 ] && [ "$SKIP_LAUNCHD_SIGNAL" -eq 0 ]; then
      launchctl kill TERM gui/$UID/${SLOT_LABEL} 2>/dev/null || true
    fi

    # Asana POST — TTL-locked via lockfile so we don't spam on every cycle.
    ASANA_LOCK="/tmp/robotdojo-watchdog-asana-${SLOT_LABEL}.lock"
    ASANA_TTL_HOURS=12
    NOW=$(date +%s)
    POST_OK=0
    if [ -f "$ASANA_LOCK" ]; then
      LOCK_TS=$(cat "$ASANA_LOCK" 2>/dev/null || echo "0")
      AGE_HOURS=$(( (NOW - LOCK_TS) / 3600 ))
      [ "$AGE_HOURS" -ge "$ASANA_TTL_HOURS" ] && POST_OK=1
    else
      POST_OK=1
    fi

    if [ "$POST_OK" = "1" ]; then
      echo "$NOW" > "$ASANA_LOCK"
      # Where to POST. In production, default to the asana script wrapper.
      # In tests, the runner passes --asana-url=http://127.0.0.1:PORT/mock so
      # we can count POSTs without hitting the network.
      ASANA_URL="${ASANA_API_URL_OVERRIDE:-${ASANA_API_URL:-}}"
      if [ -n "$ASANA_URL" ]; then
        PAYLOAD="{\"title\":\"robotdojo-watchdog: ${SLOT_LABEL} CPU burn\",\"body\":\"${SLOT_LABEL} sustained > ${CPU_BURN_THRESHOLD}%% CPU for ${N} consecutive samples while user active (idle=${USER_IDLE_SECONDS}s). Terminated current run at $(date '+%Y-%m-%d %H:%M:%S'); launch agent remains loaded for the next scheduled start.\"}"
        if [ "$DRY_RUN" -eq 0 ]; then
          /usr/bin/curl -s -m 5 -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$ASANA_URL" >/dev/null 2>&1 || true
        fi
        log "ASANA POSTed task for $SLOT_LABEL"
      fi
    fi

    # Clear the rolling-window file so the slot isn't re-killed on the next
    # cycle if launchctl restarted it instantly.
    rm -f "$SAMPLE_FILE" 2>/dev/null || true
  fi
done <<< "$SLOTS"

# --- Read free RAM % ---
if [ -n "$MOCK_FREE_PCT" ]; then
  FREE_PCT="$MOCK_FREE_PCT"
  log "RAM: free=${FREE_PCT}% (mocked)"
elif [ "$MOCK_NO_MEMORY" -eq 1 ]; then
  log "RAM read failed — skipping pressure actions"
  exit 0
else
  FREE_PCT=$(/usr/bin/memory_pressure 2>/dev/null \
    | grep "System-wide memory free percentage" \
    | awk '{print $NF}' | tr -d '%' || true)

  if [ -z "$FREE_PCT" ]; then
    log "RAM read failed — skipping pressure actions"
    exit 0
  fi
  log "RAM: free=${FREE_PCT}%"
fi

# --- Step 3: Warning threshold (<40%) — purge inactive pages ---
if [ "$FREE_PCT" -lt 40 ]; then
  log "WARNING free=${FREE_PCT}% < 40% — running purge"
  [ "$DRY_RUN" -eq 0 ] && sudo /usr/sbin/purge &
fi

# --- Step 4: Critical threshold (<10%) — kill offenders + RSS sweep ---
if [ "$FREE_PCT" -lt 10 ]; then
  log "CRITICAL free=${FREE_PCT}% < 10% — killing known offenders"

  # Python multiprocessing-fork workers (from gcloud rsync leak)
  WORKERS=$(count_procs "multiprocessing-fork")
  if [ "$WORKERS" -gt 0 ]; then
    log "KILL $WORKERS Python multiprocessing-fork workers"
    [ "$DRY_RUN" -eq 0 ] && pkill -9 -f "multiprocessing-fork" 2>/dev/null || true
  fi

  # gcloud rsync processes
  GCLOUDS=$(count_procs "gcloud.*rsync")
  if [ "$GCLOUDS" -gt 0 ]; then
    log "KILL $GCLOUDS gcloud rsync processes"
    [ "$DRY_RUN" -eq 0 ] && pkill -9 -f "gcloud.*rsync" 2>/dev/null || true
  fi

  # Stale backup-to-gcp Node processes
  BACKUPS=$(count_procs "backup-to-gcp")
  if [ "$BACKUPS" -gt 0 ]; then
    log "KILL $BACKUPS backup-to-gcp processes"
    [ "$DRY_RUN" -eq 0 ] && pkill -9 -f "backup-to-gcp" 2>/dev/null || true
  fi

  # Purge after known-offender kills
  log "CRITICAL purge after offender sweep"
  [ "$DRY_RUN" -eq 0 ] && sudo /usr/sbin/purge &

  # RSS sweep: kill top-5 non-protected processes per round, up to 3 rounds
  ROUND=0
  CURRENT_FREE="$FREE_PCT"
  while [ "$CURRENT_FREE" -lt 10 ] && [ "$ROUND" -lt 3 ]; do
    ROUND=$((ROUND + 1))
    log "SWEEP round=$ROUND free=${CURRENT_FREE}%"

    # Get top-5 RSS consumers, excluding OS-protected processes and this script
    TOP_PIDS=$(ps -eo pid=,rss=,comm= 2>/dev/null \
      | { grep -vE "$OS_PROTECTED|ram-watchdog|launchd" || true; } \
      | sort -k2 -rn \
      | head -5 \
      | awk '{print $1 ":" $3 ":" $2}')

    [ -z "$TOP_PIDS" ] && break

    while IFS= read -r entry; do
      SWEEP_PID=$(echo "$entry" | cut -d: -f1)
      SWEEP_CMD=$(echo "$entry" | cut -d: -f2)
      SWEEP_RSS=$(echo "$entry" | cut -d: -f3)
      SWEEP_MB=$((SWEEP_RSS / 1024))
      log "SWEEP killing PID=$SWEEP_PID cmd=$SWEEP_CMD rss=${SWEEP_MB}MB"
      [ "$DRY_RUN" -eq 0 ] && kill -9 "$SWEEP_PID" 2>/dev/null || true
    done <<< "$TOP_PIDS"

    # Re-read free % after kills; break after one round in dry-run/mock mode
    if [ "$DRY_RUN" -eq 0 ] && [ -z "$MOCK_FREE_PCT" ]; then
      sleep 2
      CURRENT_FREE=$(/usr/bin/memory_pressure 2>/dev/null \
        | grep "System-wide memory free percentage" \
        | awk '{print $NF}' | tr -d '%' || true)
      [ -z "$CURRENT_FREE" ] && break
      log "SWEEP after round=$ROUND free=${CURRENT_FREE}%"
    else
      break
    fi
  done

  [ "$ROUND" -ge 3 ] && log "SWEEP max rounds reached — further action requires manual triage"
fi

log "watchdog done"
