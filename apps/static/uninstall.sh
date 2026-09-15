#!/usr/bin/env bash
# shellcheck shell=bash
#
# Robot Dojo — uninstaller
#
#   curl -fsSL https://robotdojo.ai/uninstall.sh | bash
#
# Stops the service, removes the launchd plist / systemd unit, and deletes
# ~/robotdojo and ~/.robotdojo. Prompts before deleting user data.
#
set -euo pipefail

ROBOTDOJO_HOME="${ROBOTDOJO_HOME:-$HOME/robotdojo}"
ROBOTDOJO_CONFIG="${ROBOTDOJO_CONFIG:-$HOME/.robotdojo}"

# WHY com.robotdojo.*: install.sh installs every plist under this namespace
# (st_bc949e7c). The uninstall pass removes every plist matching the prefix
# rather than hard-coding a single label so soft-deletes of additional
# LaunchAgents in future stories never leak files into ~/Library/LaunchAgents.
# The legacy pre-rename label was different; users upgrading from an old
# install may have an orphan plist with a non-com.robotdojo.* name — that's
# a one-time manual cleanup and isn't worth a fragile match here.
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
SYSTEMD_UNIT_NAME="robotdojo.service"
SYSTEMD_UNIT_PATH="$HOME/.config/systemd/user/${SYSTEMD_UNIT_NAME}"

if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_RED=$'\033[0;31m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_DIM=""
fi

ok()   { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf "  %s!%s %s\n" "$C_YELLOW" "$C_RESET" "$1" >&2; }
info() { printf "  %s•%s %s\n" "$C_DIM" "$C_RESET" "$1"; }

OS="$(uname -s)"

confirm() {
  local prompt="$1"
  if [[ ! -t 0 ]]; then
    # Non-interactive: only proceed if FORCE=1
    if [[ "${ROBOTDOJO_FORCE:-0}" == "1" ]]; then
      return 0
    fi
    printf "%sRefusing to destroy data in non-interactive mode.%s Re-run with ROBOTDOJO_FORCE=1.\n" "$C_RED" "$C_RESET" >&2
    exit 1
  fi
  printf "  %s%s%s [y/N] " "$C_BOLD" "$prompt" "$C_RESET"
  read -r reply </dev/tty || reply=""
  [[ "$reply" =~ ^[Yy]$ ]]
}

stop_macos() {
  local removed=0
  if [[ -d "$LAUNCH_AGENTS_DIR" ]]; then
    local plist
    for plist in "$LAUNCH_AGENTS_DIR"/com.robotdojo.*.plist; do
      [[ -f "$plist" ]] || continue
      launchctl unload "$plist" 2>/dev/null || true
      rm -f "$plist"
      ok "Removed $(basename "$plist")"
      removed=$((removed + 1))
    done
  fi
  if (( removed == 0 )); then
    info "No com.robotdojo.* launchd plists found"
  fi
}

stop_linux() {
  if [[ -f "$SYSTEMD_UNIT_PATH" ]]; then
    systemctl --user stop "$SYSTEMD_UNIT_NAME" 2>/dev/null || true
    systemctl --user disable "$SYSTEMD_UNIT_NAME" 2>/dev/null || true
    rm -f "$SYSTEMD_UNIT_PATH"
    systemctl --user daemon-reload 2>/dev/null || true
    ok "Removed systemd unit"
  else
    info "No systemd unit found"
  fi
}

printf "\n  %sRobot Dojo uninstaller%s\n\n" "$C_BOLD" "$C_RESET"

# 1. Stop service
if [[ "$OS" == "Darwin" ]]; then
  stop_macos
elif [[ "$OS" == "Linux" ]]; then
  stop_linux
fi

# 2. Remove install dir
if [[ -d "$ROBOTDOJO_HOME" ]]; then
  if confirm "Delete install dir $ROBOTDOJO_HOME?"; then
    rm -rf "$ROBOTDOJO_HOME"
    ok "Removed $ROBOTDOJO_HOME"
  else
    warn "Kept $ROBOTDOJO_HOME"
  fi
fi

# 3. Remove config dir (contains the database!)
if [[ -d "$ROBOTDOJO_CONFIG" ]]; then
  printf "\n  %s%s%s\n" "$C_RED" "⚠  $ROBOTDOJO_CONFIG contains your database and auth token." "$C_RESET"
  if confirm "Delete $ROBOTDOJO_CONFIG?"; then
    rm -rf "$ROBOTDOJO_CONFIG"
    ok "Removed $ROBOTDOJO_CONFIG"
  else
    warn "Kept $ROBOTDOJO_CONFIG (your data is safe)"
  fi
fi

printf "\n  %sRobot Dojo uninstalled.%s\n\n" "$C_GREEN" "$C_RESET"
