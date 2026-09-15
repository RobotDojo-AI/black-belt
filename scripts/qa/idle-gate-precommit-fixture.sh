#!/usr/bin/env bash
# scripts/qa/idle-gate-precommit-fixture.sh — st_f6315f0b AC 10 / VC 10
#
# Asserts: scripts/check-idle-gated.js exits non-zero with a clear
# IDLE_GATED-missing message when given a com.robotdojo.*.plist whose
# entrypoint script does not declare the constant.
#
# Strategy:
#   1. Create a tmp dir with:
#        - a fixture entrypoint script (no IDLE_GATED declaration)
#        - a fixture plist whose ProgramArguments points at the script
#   2. Invoke check-idle-gated.js with the plist path as an argument
#      (fixture mode — bypasses the `git diff --cached` lookup).
#   3. Assert the exit code is >= 1 AND stderr contains the expected
#      "IDLE_GATED-missing" / "add IDLE_GATED" message.
#
# Exit 0 with single OK line on pass.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR=$(mktemp -d /tmp/qa-idle-gate-precommit-XXXXXX)
cleanup() { rm -rf "$TMP_DIR" 2>/dev/null || true; }
trap cleanup EXIT

# 1. Fixture entrypoint (NO IDLE_GATED declaration).
FIXTURE_SCRIPT="$REPO_ROOT/tmp/fixture-no-idle-gated-$$.js"
mkdir -p "$REPO_ROOT/tmp"
cat > "$FIXTURE_SCRIPT" <<'EOF'
#!/usr/bin/env node
// Intentionally NO export const IDLE_GATED — the hook must reject this.
console.log('fixture worker');
EOF

# 2. Fixture plist that references the bad script.
FIXTURE_PLIST="$TMP_DIR/com.robotdojo.fixture-no-idle-gated.plist"
cat > "$FIXTURE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.robotdojo.fixture-no-idle-gated</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$FIXTURE_SCRIPT</string>
  </array>
</dict>
</plist>
EOF

# 3. Run the hook in fixture mode.
HOOK_OUTPUT=$(node "$REPO_ROOT/scripts/check-idle-gated.js" "$FIXTURE_PLIST" 2>&1 || true)
HOOK_EXIT=$?
# bash subshell + `|| true` always returns 0; capture the real exit via $?
# of the subshell command pipeline. Use $PIPESTATUS-like trick:
node "$REPO_ROOT/scripts/check-idle-gated.js" "$FIXTURE_PLIST" >/dev/null 2>&1
HOOK_EXIT=$?

# Cleanup the fixture script before assertions so a FAIL exit still cleans up.
rm -f "$FIXTURE_SCRIPT" 2>/dev/null || true

# Assertion 1: exit code is non-zero.
if [ "$HOOK_EXIT" -eq 0 ]; then
  echo "FAIL: hook exited 0 (expected non-zero) for plist with missing IDLE_GATED"
  echo "$HOOK_OUTPUT"
  exit 1
fi

# Assertion 2: stderr contains the IDLE_GATED-missing message.
# The hook prints "[check-idle-gated] FAIL: …" + "Fix: add `export const IDLE_GATED …`".
# We match either fragment to be robust against future message edits.
if ! echo "$HOOK_OUTPUT" | grep -qE 'IDLE_GATED[- ]missing|add[[:space:]]+\`?(export\s+const\s+)?IDLE_GATED'; then
  echo "FAIL: hook output does not contain expected IDLE_GATED-missing message"
  echo "--- hook output ---"
  echo "$HOOK_OUTPUT"
  exit 1
fi

# Final OK line — single line matching the plan VC regex.
echo "OK: hook blocked commit with exit $HOOK_EXIT and IDLE_GATED-missing error message"
exit 0
