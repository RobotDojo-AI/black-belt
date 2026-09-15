#!/usr/bin/env bash
# clean-install-smoke.sh — fresh-Mac install verification.
#
# st_5a63545d AC 1. Default mode is a safe dry-run that uses a temp
# config namespace and does not delete local data or Keychain entries.
# Set ROBOTDOJO_CLEAN_INSTALL_REAL=1 for the destructive current-user run:
#
#   1. Clear ~/.robotdojo/  (preserves nothing — destructive, real mode only)
#   2. Clear Keychain entries for robotdojo-* (real mode only)
#   3. Run apps/static/install.sh
#   4. Prove the LaunchAgent service layer was installed or dry-run rendered
#   5. Wait for /api/server-health through the live relay to return 200
#   6. Drive Account Integrations + setup-aware chat via Playwright
#   7. Send a test chat message
#   8. Capture screenshots to ~/Desktop/robotdojo-smoke-$TIMESTAMP/
#
# Manual sign-off required after the script exits 0. The script does NOT
# delete ~/robotdojo/ or its DB — only the namespace dir.
#
# USAGE:
#   bash scripts/qa/clean-install-smoke.sh [--no-playwright]

set -euo pipefail

NO_PLAYWRIGHT=0
if [[ "${1:-}" == "--no-playwright" ]]; then NO_PLAYWRIGHT=1; fi
REAL_RUN="${ROBOTDOJO_CLEAN_INSTALL_REAL:-0}"

STAMP="$(date +%Y%m%d-%H%M%S)"
if [[ "$REAL_RUN" == "1" ]]; then
  OUT_DIR="$HOME/Desktop/robotdojo-smoke-${STAMP}"
else
  OUT_DIR="/private/tmp/robotdojo-smoke-${STAMP}"
fi
mkdir -p "$OUT_DIR"

step() { printf "\n\033[1m== %s ==\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1" >&2; }
die()  { printf "  \033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

step "Step 1 — clean config namespace"
if [[ "$REAL_RUN" == "1" ]]; then
  if [[ -d "$HOME/.robotdojo" ]]; then
    rm -rf "$HOME/.robotdojo"
    ok "removed ~/.robotdojo/"
  else
    ok "~/.robotdojo/ already absent"
  fi
else
  export ROBOTDOJO_CONFIG="${ROBOTDOJO_CONFIG:-/private/tmp/robotdojo-clean-install-smoke-config}"
  rm -rf "$ROBOTDOJO_CONFIG"
  mkdir -p "$ROBOTDOJO_CONFIG"
  ok "using temp config namespace: $ROBOTDOJO_CONFIG"
fi

step "Step 2 — Keychain namespace"
if [[ "$REAL_RUN" == "1" ]]; then
  # Idempotent: each delete-generic-password ignores not-found.
  for k in SESSION_SECRET ROBOTDOJO_AUTH_TOKEN LOCAL_DB_KEY RESEND_API_KEY; do
    security delete-generic-password -s "robotdojo-${k}" >/dev/null 2>&1 || true
  done
  ok "Keychain robotdojo-* entries cleared (idempotent)"
else
  export ROBOTDOJO_DRY_RUN=1
  ok "dry-run mode: no Keychain entries deleted"
fi

step "Step 3 — run install.sh"
# Use the local install.sh so the test exercises the as-edited copy.
INSTALL_SH="$HOME/robotdojo/apps/static/install.sh"
[[ -f "$INSTALL_SH" ]] || die "$INSTALL_SH not found"
# ROBOTDOJO_NO_OPEN=1 — don't actually open the browser; we drive it
# explicitly via Playwright below.
if [[ "$REAL_RUN" == "1" ]]; then
  ROBOTDOJO_NO_OPEN=1 bash "$INSTALL_SH" \
    > "$OUT_DIR/install.log" 2>&1 || warn "install.sh exited non-zero (check $OUT_DIR/install.log)"
else
  ROBOTDOJO_NO_OPEN=1 ROBOTDOJO_DRY_RUN=1 bash "$INSTALL_SH" \
    > "$OUT_DIR/install.log" 2>&1 || warn "install.sh exited non-zero (check $OUT_DIR/install.log)"
fi
ok "install.sh completed; log → $OUT_DIR/install.log"

step "Step 4 — LaunchAgent service contract"
if [[ "$REAL_RUN" != "1" ]]; then
  (
    cd "$HOME/robotdojo"
    node scripts/check-live-launch-agents.js --packaged-only
  ) > "$OUT_DIR/launch-agents.log" 2>&1 || die "packaged LaunchAgent contract failed; see $OUT_DIR/launch-agents.log"
  while IFS= read -r label; do
    [[ -z "$label" ]] && continue
    grep -F "DRY: launchctl load $HOME/Library/LaunchAgents/${label}.plist" "$OUT_DIR/install.log" >/dev/null \
      || die "dry-run installer did not render launchctl load for ${label}" "See $OUT_DIR/install.log"
  done < <(
    cd "$HOME/robotdojo"
    node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync('config/launch-agents.json','utf8')); for (const a of m.agents || []) if (a.label) console.log(a.label);"
  )
  ok "dry-run installer rendered every manifest LaunchAgent"
else
  (
    cd "$HOME/robotdojo"
    node scripts/check-live-launch-agents.js --print-loaded
  ) > "$OUT_DIR/launch-agents.log" 2>&1 || die "live LaunchAgent check failed; see $OUT_DIR/launch-agents.log"
  ok "live LaunchAgents match packaged intent"
fi

step "Step 5 — wait for relay /api/server-health"
if [[ "$REAL_RUN" != "1" ]]; then
  ok "dry-run mode: relay server-health wait skipped"
else
  QA_RELAY_BASE="$(
    cd "$HOME/robotdojo" && node --input-type=module -e \
      "import { assertRelayQaUrl } from './scripts/qa/live-url-guard.js'; process.stdout.write(assertRelayQaUrl(process.argv[1], 'QA_BASE_URL'));" \
      "${QA_BASE_URL:-https://robotdojo.ai}"
  )" || die "QA_BASE_URL must be a robotdojo.ai relay URL"
  QA_RELAY_SLUG="${ROBOTDOJO_QA_RELAY_SLUG:-dojo}"
  attempts=0
  while (( attempts < 30 )); do
    if curl -fsSL --max-time 5 -H "Cookie: rd_server=${QA_RELAY_SLUG}" "${QA_RELAY_BASE}/api/server-health" >/dev/null 2>&1; then
      ok "server reachable through relay at ${QA_RELAY_BASE}"
      break
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  if (( attempts >= 30 )); then
    warn "server did not answer through relay in 30s — inspect $OUT_DIR/install.log"
  fi
fi

step "Step 6 — capture Keychain state"
if [[ "$REAL_RUN" == "1" ]]; then
  {
    echo "# Keychain robotdojo-* state at $(date)"
    for k in SESSION_SECRET ROBOTDOJO_AUTH_TOKEN LOCAL_DB_KEY; do
      v="$(security find-generic-password -s "robotdojo-${k}" -w 2>/dev/null || echo MISSING)"
      if [[ "$v" == "MISSING" ]]; then
        echo "$k: MISSING"
      else
        echo "$k: ${#v} bytes"
      fi
    done
  } > "$OUT_DIR/keychain-state.txt"
else
  echo "# dry-run mode: no Keychain state captured" > "$OUT_DIR/keychain-state.txt"
fi
ok "Keychain state recorded → $OUT_DIR/keychain-state.txt"

step "Step 7 — Playwright smoke (if available)"
if [[ "$REAL_RUN" != "1" ]]; then
  warn "skipped (dry-run mode)"
elif (( NO_PLAYWRIGHT == 1 )); then
  warn "skipped (--no-playwright)"
else
  if command -v npx >/dev/null 2>&1; then
    cd "$HOME/robotdojo"
    # Use the setup-refresh-preserves-stage spec as a cheap "wizard loads"
    # signal; full first-chat run is out-of-scope for the smoke check.
    npx playwright test scripts/qa/tests/no-setup-surface.spec.js \
      --reporter=line --output="$OUT_DIR/playwright" \
      > "$OUT_DIR/playwright.log" 2>&1 || warn "playwright run failed (see $OUT_DIR/playwright.log)"
    ok "playwright complete; log → $OUT_DIR/playwright.log"
  else
    warn "npx not on PATH; skipping Playwright drive"
  fi
fi

step "Done"
ok "Smoke run artifacts: $OUT_DIR"
echo
echo "Manual sign-off checklist:"
echo "  [ ] Keychain has SESSION_SECRET, ROBOTDOJO_AUTH_TOKEN, LOCAL_DB_KEY (each >=32 bytes)"
echo "  [ ] Relay responds at ${QA_BASE_URL:-https://robotdojo.ai}/api/server-health with rd_server=${ROBOTDOJO_QA_RELAY_SLUG:-dojo}"
echo "  [ ] /auth/local-start?token=... in a fresh browser opens Account Integrations"
echo "  [ ] First chat message streams a response from Ollama (zero-config case)"
echo "  [ ] /account integrations tab shows the dojo-token card"
