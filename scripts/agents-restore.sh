#!/bin/bash
# scripts/agents-restore.sh — bring the LaunchAgents back after a full stop.
#
# st_4312c9c0. The owner stopped everything to take API spend to zero. The set
# that was running is recorded at ~/.robotdojo/state/agents-before-shutdown.txt
# so restoring is one command instead of remembering 18 labels.
#
#   bash scripts/agents-restore.sh           # restore everything that was running
#   bash scripts/agents-restore.sh server    # restore one, by label suffix
#
# The no-background-spend switch stays wherever it was set — restoring an agent
# does NOT re-enable background API spend. Clear that separately, per agent, with
#   /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:ROBOTDOJO_NO_AUTONOMOUS_SPEND" \
#     ~/Library/LaunchAgents/com.robotdojo.<name>.plist
set -u
LIST="$HOME/.robotdojo/state/agents-before-shutdown.txt"
UID_NUM=$(id -u)
FILTER="${1:-}"

[ -f "$LIST" ] || { echo "no restore list at $LIST"; exit 1; }

while read -r label; do
  [ -n "$label" ] || continue
  [ -n "$FILTER" ] && [[ "$label" != *"$FILTER"* ]] && continue
  plist="$HOME/Library/LaunchAgents/$label.plist"
  [ -f "$plist" ] || { echo "SKIP    $label (no plist)"; continue; }
  if launchctl list | grep -q "$label"; then
    echo "ALREADY $label"
  else
    launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null && echo "STARTED $label" || echo "FAILED  $label"
  fi
done < "$LIST"
