# scripts/robotdojo-session-title.zsh — st_8745309c AC2 + plain-English follow-on.
#
# Pure zsh snippet. Source this from ~/.zshrc (LAST among shell plugins so
# its precmd hook runs LAST and wins the title race against oh-my-zsh
# themes and iTerm2 shell integration that also emit OSC 0):
#
#   source ~/robotdojo/scripts/robotdojo-session-title.zsh
#
# What it does:
#
#   1. Defines _robotdojo_title_precmd() — emits the OSC 0 title string
#      "[<LABEL>] <PLAIN TITLE>" before every prompt. The label comes from
#      $ROBOTDOJO_SESSION_LABEL. The plain title comes from
#      scripts/robotdojo-title.js, which resolves the active story id to
#      a readable title (meta.title or slug → "Cross IDE Session
#      Coordination" style).
#
#   2. Wraps the `claude` binary with a shell function that
#      (a) sources .env.local if present in the current directory — picks
#          up ROBOTDOJO_DATABASES_ROOT for worktree isolation;
#      (b) parses --story <id> from claude's args to set
#          ROBOTDOJO_ACTIVE_STORY_ID at launch (overridden by an env var
#          if already set in the parent shell);
#      (c) auto-detects the active story when not set: if EXACTLY ONE
#          robotdojo-domain story has kanban=in-progress, uses it;
#          otherwise leaves the session idle (no guess);
#      (d) registers the precmd hook;
#      (e) sets the initial title with the resolved plain title;
#      (f) execs the real binary via `command claude`;
#      (g) deregisters the precmd hook on return.
#
# Launch-time only: terminal tab titles can only be set when the shell
# precmd fires; while claude is in the foreground, our precmd does not
# run. CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 prevents claude from
# clobbering the title we set at launch. The statusLine (separate
# script) is what updates inside the claude UI.
#
# OSC sequence: \033]0;<title>\007 sets BOTH the icon and window title.
# tmux passes the OSC through to the parent terminal emulator when
# set-titles is on (iTerm2 honors it by default).

autoload -Uz add-zsh-hook

# Path to the node helper that prints the plain-English title for a story.
# Resolved once at source time; the file lives next to this script.
_ROBOTDOJO_TITLE_HELPER="${HOME}/robotdojo/scripts/robotdojo-title.js"
_ROBOTDOJO_STORIES_DIR="${HOME}/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories"

# Read the active story id from $ROBOTDOJO_ACTIVE_STORY_ID first; fall back
# to the per-PID scratch file the session-log hook writes on every prompt.
_robotdojo_active_story() {
  if [[ -n "${ROBOTDOJO_ACTIVE_STORY_ID:-}" ]]; then
    print -r -- "$ROBOTDOJO_ACTIVE_STORY_ID"
    return
  fi
  local scratch="/tmp/robotdojo-session-$$.json"
  if [[ -r "$scratch" ]]; then
    # Cheap grep for the story_id key — avoids shelling out to jq.
    local sid
    sid=$(grep -oE '"story_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$scratch" 2>/dev/null | head -1 | sed -E 's/.*"story_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
    if [[ -n "$sid" && "$sid" != "null" ]]; then
      print -r -- "$sid"
      return
    fi
  fi
  print -r -- "idle"
}

# Resolve plain-English title from a story id. Shells out to the node
# helper which reads meta.json and applies the canonical derivation.
# Silent on failure: any error path returns empty.
_robotdojo_plain_title() {
  local sid="$1"
  [[ -z "$sid" || "$sid" == "idle" ]] && return
  if [[ -x "$_ROBOTDOJO_TITLE_HELPER" || -r "$_ROBOTDOJO_TITLE_HELPER" ]]; then
    node "$_ROBOTDOJO_TITLE_HELPER" "$sid" 2>/dev/null
  fi
}

# Auto-detect the active story when the operator has not set
# $ROBOTDOJO_ACTIVE_STORY_ID and has not passed --story to the wrapper.
#
# Rule: if EXACTLY ONE story under the robotdojo domain has
# kanban=in-progress, use it. Otherwise leave it as "idle" — never
# guess between multiple candidates.
#
# Implementation: grep across meta.json for both markers; collect the
# parent dir basenames; if the unique count is 1, print it. Pure zsh +
# grep + awk — no node spawn for this path so launch stays cheap.
_robotdojo_autodetect_story() {
  [[ -d "$_ROBOTDOJO_STORIES_DIR" ]] || return
  local matches
  matches=$(grep -lE '"kanban"[[:space:]]*:[[:space:]]*"in-progress"' \
    "$_ROBOTDOJO_STORIES_DIR"/*/meta.json 2>/dev/null \
    | while read -r f; do
        if grep -qE '"domain"[[:space:]]*:[[:space:]]*"robotdojo"' "$f" 2>/dev/null; then
          basename "$(dirname "$f")"
        fi
      done)
  local count
  count=$(print -r -- "$matches" | grep -c .)
  if [[ "$count" == "1" ]]; then
    print -r -- "$matches"
  fi
}

# precmd hook: fires before every prompt. Hold the title against any
# other plugin's emissions in the same precmd chain (we run last when
# this file is sourced last in .zshrc).
_robotdojo_title_precmd() {
  local label="${ROBOTDOJO_SESSION_LABEL:-?}"
  local story
  story=$(_robotdojo_active_story)
  local title
  title=$(_robotdojo_plain_title "$story")
  if [[ -n "$title" ]]; then
    printf '\033]0;[%s] %s\007' "$label" "$title"
  else
    printf '\033]0;[%s]\007' "$label"
  fi
}

# Wrap the `claude` binary. zsh function shadowing: `command claude`
# bypasses the function to call the real binary.
claude() {
  # 1. Source .env.local if present — picks up ROBOTDOJO_DATABASES_ROOT.
  if [[ -f .env.local ]]; then
    set -a
    source .env.local
    set +a
  fi

  # 1b. Auto-assign a session label if the operator didn't set one. Picks the
  #     lowest free single letter (A..Z) not held by a live registry session,
  #     so auto-started tabs get distinct labels with zero typing. Best-effort:
  #     falls back to A. A user-set ROBOTDOJO_SESSION_LABEL always wins.
  if [[ -z "${ROBOTDOJO_SESSION_LABEL:-}" ]]; then
    export ROBOTDOJO_SESSION_LABEL="$(node "${HOME}/robotdojo/scripts/robotdojo-next-label.js" 2>/dev/null || echo A)"
  fi

  # 2. Resolve active story id at launch.
  #    Order: existing env var → --story <id> arg → auto-detect.
  #    Args are scanned non-destructively; --story stays in $@ so claude
  #    ignores it unless it cares (it doesn't — it accepts unknown args).
  if [[ -z "${ROBOTDOJO_ACTIVE_STORY_ID:-}" ]]; then
    local i=1
    local n=$#
    while (( i <= n )); do
      if [[ "${@[$i]}" == "--story" && $((i + 1)) -le n ]]; then
        export ROBOTDOJO_ACTIVE_STORY_ID="${@[$((i + 1))]}"
        break
      fi
      i=$((i + 1))
    done
  fi
  if [[ -z "${ROBOTDOJO_ACTIVE_STORY_ID:-}" ]]; then
    local detected
    detected=$(_robotdojo_autodetect_story)
    if [[ -n "$detected" ]]; then
      export ROBOTDOJO_ACTIVE_STORY_ID="$detected"
    fi
  fi

  # 3. Register the precmd hook (idempotent — add-zsh-hook dedupes).
  add-zsh-hook precmd _robotdojo_title_precmd

  # 4. Emit the initial title now so it lands before claude prints anything.
  _robotdojo_title_precmd

  # 5. Run the real binary with all args.
  #    CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 (scoped to this invocation) stops
  #    Claude Code from clobbering our OSC title with its own "claude code -
  #    <message>" title. zsh precmd hooks do not fire during a running
  #    foreground session, so the only way to hold the title is to tell
  #    claude not to set it. Verified: code.claude.com/docs/en/terminal-config.
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 command claude "$@"
  local rc=$?

  # 6. Deregister so a post-claude shell does not keep overwriting titles
  #    of other tools. The hook will be re-added on the next claude launch.
  add-zsh-hook -d precmd _robotdojo_title_precmd

  return $rc
}
