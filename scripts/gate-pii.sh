#!/usr/bin/env bash
# Refuse commits that carry first-user identity or tracked private substrate.
#
# The guard is deliberately narrow. It catches leaks that can make the public
# repo depend on one private operator, while allowing ordinary product fixtures
# such as example email addresses and local-data path docs. Private owner
# patterns must live outside Git in .git/info/private-identity-patterns or in
# ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS.
#
# Usage:
#   gate-pii.sh                      scan files staged for the current commit
#   gate-pii.sh --all                scan every tracked file
#   gate-pii.sh --files a.js b.js    scan the named files. --files consumes every
#                                    remaining argument (a path may look like a
#                                    flag), so it goes LAST.
#   gate-pii.sh --require-patterns   refuse (exit 3) when zero patterns loaded,
#                                    combinable with any of the above. Set only
#                                    by the publication step: pre-commit and
#                                    fresh clones keep today's silent no-op.

set -euo pipefail

EXCLUDED='^(node_modules/|\.build/|databases/|user/|config/yc-domains\.json$|config/surnames-top-25K\.json$|config/nicknames\.json$)'
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# ── argument parsing ─────────────────────────────────────────────────────────
# Flags used to be positional ("$1" tested against --all / --files), which meant
# a second flag could only ever be ignored. --require-patterns has to be
# combinable with --all — the publication step passes both — so parse properly.
MODE="staged"
REQUIRE_PATTERNS=0
FILE_ARGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) MODE="all"; shift ;;
    --require-patterns) REQUIRE_PATTERNS=1; shift ;;
    --files) MODE="files"; shift; FILE_ARGS="$*"; break ;;
    *) FILE_ARGS="${FILE_ARGS:+$FILE_ARGS }$1"; shift ;;
  esac
done

PATTERNS=()

if [[ -n "${ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS:-}" ]]; then
  while IFS= read -r pattern; do
    [[ -n "$pattern" ]] && PATTERNS+=("$pattern")
  done <<< "$ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS"
fi

# The owner's patterns live OUTSIDE git (.git/info/ is never archived), which is
# what keeps them out of the published copy — and is also why a run inside an
# exported tree loads zero of them and exits 0 having compared nothing. The env
# override is the bridge: the publication step points this at the REAL repo's
# file so the export is scanned against the owner's patterns without those
# patterns ever being written into the artifact being published.
PRIVATE_PATTERN_FILE="${ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS_FILE:-$REPO_ROOT/.git/info/private-identity-patterns}"
if [[ -f "$PRIVATE_PATTERN_FILE" ]]; then
  while IFS= read -r pattern; do
    [[ -z "$pattern" || "$pattern" =~ ^[[:space:]]*# ]] && continue
    PATTERNS+=("$pattern")
  done < "$PRIVATE_PATTERN_FILE"
fi

PATTERN_COUNT=${#PATTERNS[@]}

# --require-patterns: refuse to report clean on zero configuration.
#
# This check runs BEFORE the empty-file-set early exit on purpose. A blind run
# with nothing to compare against is the failure being closed; whether it also
# happened to have no files to compare is irrelevant to that verdict. Exit 3
# (not 1) so a caller can tell "the gate is misconfigured" from "the gate found
# a leak" — the two need different fixes.
#
# Pre-commit and fresh clones never pass this flag, so their zero-pattern no-op
# stays exactly as designed.
if [[ $REQUIRE_PATTERNS -eq 1 && $PATTERN_COUNT -eq 0 ]]; then
  echo "ERROR: gate-pii --require-patterns: zero private-identity patterns loaded." >&2
  echo "  looked for: $PRIVATE_PATTERN_FILE" >&2
  echo "  and \$ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS (unset or empty)" >&2
  echo "  A scan with no patterns compares nothing and would report clean. Refusing." >&2
  exit 3
fi

if [[ $REQUIRE_PATTERNS -eq 1 ]]; then
  echo "gate-pii: loaded $PATTERN_COUNT private-identity pattern(s) from $PRIVATE_PATTERN_FILE"
fi

if [[ "$MODE" == "all" ]]; then
  FILES=$(git ls-files | grep -Ev "$EXCLUDED" || true)
elif [[ "$MODE" == "files" ]]; then
  FILES="$FILE_ARGS"
else
  FILES=$(git diff --cached --name-only --diff-filter=ACMR | grep -Ev "$EXCLUDED" || true)
fi

if [[ -z "${FILES:-}" ]]; then
  exit 0
fi

FAIL=0
OUTPUT=""

for file in $FILES; do
  [[ -f "$file" ]] || continue

  _excl_check="$file"; _excluded=0
  while true; do
    echo "$_excl_check" | grep -qE "$EXCLUDED" && { _excluded=1; break; }
    [[ "$_excl_check" == */* ]] || break
    _excl_check="${_excl_check#*/}"
  done
  [[ $_excluded -eq 1 ]] && continue

  if ! grep -Iq . "$file" 2>/dev/null; then
    continue
  fi

  if [[ $PATTERN_COUNT -gt 0 ]]; then
    for pattern in "${PATTERNS[@]}"; do
      if grep -n -iE "$pattern" "$file" >/dev/null 2>&1; then
        match=$(grep -n -iE "$pattern" "$file" | head -3)
        OUTPUT+="  $file: matches private-identity pattern
$(echo "$match" | sed 's/^/    /')
"
        FAIL=1
      fi
    done
  fi
done

FAQ_BUNDLE="lib/public-chat/faq-bundle.js"
FAQ_SOURCES_CHANGED=$(echo "$FILES" | grep -E 'apps/static/faq/|scripts/bundle-faq\.js' | head -1 || true)
FAQ_BUNDLE_STAGED=$(echo "$FILES" | grep "$FAQ_BUNDLE" | head -1 || true)

if [[ "$MODE" != "all" ]] && [[ -n "$FAQ_SOURCES_CHANGED" || -n "$FAQ_BUNDLE_STAGED" ]]; then
  if command -v node &>/dev/null && [[ -f "scripts/bundle-faq.js" ]]; then
    node scripts/bundle-faq.js 2>/dev/null || true
    if ! git diff --exit-code "$FAQ_BUNDLE" &>/dev/null; then
      OUTPUT+="  $FAQ_BUNDLE: bundle is out of sync with FAQ sources — run 'node scripts/bundle-faq.js' and stage the result
"
      FAIL=1
    fi
  fi
fi

if [[ $FAIL -eq 1 ]]; then
  echo "ERROR: private identity detected in the following files:" >&2
  echo "$OUTPUT" >&2
  echo "" >&2
  echo "Commit aborted." >&2
  echo "" >&2
  echo "Remedies:" >&2
  echo "  - Move user-specific data under user/ or ~/.robotdojo/ and keep it gitignored" >&2
  echo "  - Replace first-user names with user, owner, account, or runtime identity" >&2
  echo "  - Regenerate public-truth and FAQ bundles after source edits" >&2
  exit 1
fi

exit 0
