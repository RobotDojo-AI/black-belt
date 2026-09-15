#!/usr/bin/env bash
# scripts/robotdojo-statusline.sh — st_8745309c follow-on.
#
# Claude Code statusLine command. Claude pipes a single JSON object on
# stdin containing the current session_id (and other fields we ignore).
# We look that session up in the shared sessions.json registry to
# resolve label + story_id, then derive a plain-English title via the
# node helper and print:
#
#   "[<label>] <Plain Title>"   — when both label and a non-empty title resolve
#   "[<label>]"                  — when label resolves but no active story
#   ""                            — when this is not a robotdojo session
#
# Requirements per Claude Code statusLine contract:
#   - Read stdin (JSON)
#   - Print exactly one line to stdout (no trailing decoration)
#   - <100ms total runtime
#   - Never error visibly — silent degradation on any failure
#
# Performance: single node invocation (registry read + title derive) is
# ~40-60ms cold on a modern Mac. We do not pre-warm. If session is not
# in the registry, the script falls back to $ROBOTDOJO_SESSION_LABEL
# and exits without spawning node at all (zero cost path).

set -u
# NB: no `set -e` — we want every failure to fall through to empty output,
# not abort with stderr noise that Claude Code would render literally.

REPO_ROOT="${ROBOTDOJO_REPO_ROOT:-${HOME}/robotdojo}"
TITLE_HELPER="${REPO_ROOT}/scripts/robotdojo-title.js"

# Read the JSON payload from stdin. Claude Code always provides it; if
# stdin is empty (manual invocation), we still try the env fallback.
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat 2>/dev/null || true)
fi

# Extract session_id with a cheap grep — avoids jq dependency. The Claude
# Code statusLine payload has session_id as a top-level string field.
SESSION_ID=$(printf '%s' "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' \
  2>/dev/null)

# Look up label + story_id from the registry via a tiny node one-liner.
# Single spawn for both reads + title derivation. Output format:
#   <label>\t<title>
# Either field may be empty. Any failure prints nothing and we fall
# through to env-only rendering.
LOOKUP=""
if [ -n "${SESSION_ID:-}" ] && [ -r "$TITLE_HELPER" ]; then
  LOOKUP=$(SESSION_ID="$SESSION_ID" node --input-type=module -e "
    const sid = process.env.SESSION_ID;
    try {
      const reg = await import('${REPO_ROOT}/lib/session-registry.js');
      const lib = await import('${REPO_ROOT}/lib/work-item-title.js');
      const entry = reg.activeSessions().find(s => s.session_id === sid);
      const label = entry?.label || '';
      const storyId = entry?.story_id || '';
      const title = storyId ? lib.workItemTitle(storyId) : '';
      process.stdout.write(label + '\t' + title);
    } catch {
      process.stdout.write('\t');
    }
  " 2>/dev/null || true)
fi

LABEL=$(printf '%s' "$LOOKUP" | awk -F'\t' '{print $1}')
TITLE=$(printf '%s' "$LOOKUP" | awk -F'\t' '{print $2}')

# Fallback for story title: $ROBOTDOJO_ACTIVE_STORY_ID set by the shell
# wrapper at launch — the SAME source the tab title uses. Covers the common
# case where the session-log hook has not (yet) written this session into the
# registry, so the statusLine never goes label-only when the env knows the story.
if [ -z "${TITLE:-}" ] && [ -n "${ROBOTDOJO_ACTIVE_STORY_ID:-}" ] && [ -r "$TITLE_HELPER" ]; then
  TITLE=$(node "$TITLE_HELPER" "$ROBOTDOJO_ACTIVE_STORY_ID" 2>/dev/null || true)
fi

# Fallback for label: $ROBOTDOJO_SESSION_LABEL set by the shell wrapper at
# launch. If neither registry nor env yields a label, this is not a
# robotdojo session — print nothing and exit.
if [ -z "${LABEL:-}" ]; then
  LABEL="${ROBOTDOJO_SESSION_LABEL:-}"
fi

if [ -z "${LABEL:-}" ]; then
  # Not a robotdojo session — silent. Claude Code renders empty.
  exit 0
fi

if [ -n "${TITLE:-}" ]; then
  printf '[%s] %s' "$LABEL" "$TITLE"
else
  printf '[%s]' "$LABEL"
fi
