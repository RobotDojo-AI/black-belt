#!/usr/bin/env bash
# Robot Dojo installer wrapper.
#
# Keep the launch installer in one place. The public installer lives at
# apps/static/install.sh; running ./install.sh from a clone executes that same
# path so developer and customer installs cannot drift.
#
# Optional opt-in: --with-session-title appends a single `source` line to
# ~/.zshrc that wires up the per-terminal session-title precmd hook
# (st_8745309c). Idempotent: re-running is safe; the line is added only
# when not already present. Without the flag, the installer behavior is
# unchanged from the canonical apps/static/install.sh path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# st_8745309c — optional session-title zshrc setup. Detect and strip the
# flag BEFORE handing off to apps/static/install.sh so the canonical
# installer does not see an unknown option.
WITH_SESSION_TITLE=0
FORWARDED=()
for arg in "$@"; do
  case "$arg" in
    --with-session-title) WITH_SESSION_TITLE=1 ;;
    *) FORWARDED+=("$arg") ;;
  esac
done

if [ "$WITH_SESSION_TITLE" = "1" ]; then
  ZRC="$HOME/.zshrc"
  SNIPPET="$SCRIPT_DIR/scripts/robotdojo-session-title.zsh"
  LINE="source $SNIPPET"
  if [ ! -f "$ZRC" ] || ! grep -Fq "robotdojo-session-title.zsh" "$ZRC"; then
    {
      echo ""
      echo "# st_8745309c — per-terminal Claude Code session title (idempotent)"
      echo "$LINE"
    } >> "$ZRC"
    echo "install: session-title hook appended to $ZRC"
  else
    echo "install: session-title hook already present in $ZRC — no change"
  fi
fi

exec "$SCRIPT_DIR/apps/static/install.sh" "${FORWARDED[@]+"${FORWARDED[@]}"}"
