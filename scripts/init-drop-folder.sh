#!/usr/bin/env bash
# shellcheck shell=bash
#
# init-drop-folder.sh — create the Robot Dojo import drop zone.
#
# Creates only:
#   ~/robotdojo/user/inbox/          raw drop zone
#   ~/robotdojo/user/imports/.index/ watcher metadata
#
# User-facing organized files live under ~/robotdojo/user/files/{t1}/{t2}.
# The old Inbox/Processing/Processed/Errors folders are not launch architecture.

set -euo pipefail

ROOT="${ROBOTDOJO_DROP_ROOT:-$HOME/robotdojo/user/inbox}"
IMPORTS_ROOT="${ROBOTDOJO_USER_IMPORTS_ROOT:-$HOME/robotdojo/user/imports}"
USERFILES_ROOT="${ROBOTDOJO_FILES_ROOT:-$HOME/robotdojo/user/files}"

mkdir_secure() {
  local path="$1"
  local mode="$2"
  if [[ ! -d "$path" ]]; then
    mkdir -p "$path"
  fi
  chmod "$mode" "$path"
}

mkdir_secure "$ROOT"                 700
mkdir_secure "$IMPORTS_ROOT/.index"  700

mkdir_secure "$USERFILES_ROOT"       700
mkdir_secure "$USERFILES_ROOT/work"  700
mkdir_secure "$USERFILES_ROOT/family" 700
mkdir_secure "$USERFILES_ROOT/personal" 700
mkdir_secure "$USERFILES_ROOT/education" 700
mkdir_secure "$USERFILES_ROOT/newsletters" 700

echo "[init-drop-folder] ready at: $ROOT"
echo "[init-drop-folder] user files ready at: $USERFILES_ROOT"
