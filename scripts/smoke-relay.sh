#!/usr/bin/env bash
# scripts/smoke-relay.sh — end-to-end verification that the tunnel is
# working, after the gateway has been deployed AND the main app has been
# restarted so tunnel-agent reconnects.
#
# Run from the robotdojo repo root, on the same Mac as the main app.

set -euo pipefail

RELAY="${RELAY:-https://relay.robotdojo.ai}"

echo "==> 1. Gateway health (should be 200 + ok)"
curl -fsS "$RELAY/health"; echo

echo
echo "==> 2. SNI tunnel count (should be >= 2 hot-spare connections after tunnel boots)"
HEALTH=$(curl -fsS "$RELAY/health")
echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
TCP_DEVICES=$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tcp_devices", "?"))' 2>/dev/null || echo '?')
TCP_CONNS=$(echo "$HEALTH" | python3 -c 'import json,sys; h=json.load(sys.stdin); print(h.get("tcp_connections", h.get("tcp_devices", "?")))' 2>/dev/null || echo '?')
if [[ "$TCP_DEVICES" == "0" ]]; then
  echo "FAIL: 0 SNI tunnels connected. Apex login cannot reach this Mac."
  echo "      Try: launchctl kickstart -k gui/\$(id -u)/com.robotdojo.tunnel"
  exit 1
fi
if [[ "$TCP_CONNS" != "?" && "$TCP_CONNS" -lt 2 ]]; then
  echo "WARN: only $TCP_CONNS SNI tunnel connected. Remote access works, but hot-spare redundancy is degraded."
  echo "      Try: launchctl kickstart -k gui/\$(id -u)/com.robotdojo.tunnel"
fi

echo
echo "==> 3. Resolve public login server name"
SLUG=$(node --input-type=module -e "
import db from './lib/db.js';
import { resolveLoginServerName } from './lib/device-name.js';
const r = db.prepare('SELECT user_slug FROM users WHERE is_admin=1 LIMIT 1').get();
console.log(resolveLoginServerName(r?.user_slug) || '');
" | awk 'NF { line=$0 } END { print line }')
if [[ -z "$SLUG" ]]; then
  echo "FAIL: no public login server name resolved."
  exit 1
fi
echo "server name: $SLUG"

echo
echo "==> 4. SNI test — https://$SLUG.robotdojo.ai/api/auth/probe should"
echo "    route through the blind TCP tunnel to the local HTTPS app."
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 "https://$SLUG.robotdojo.ai/api/auth/probe")
if [[ "$HTTP" != "200" ]]; then
  echo "    → HTTP $HTTP — SNI tunnel proxy failed."
  exit 1
fi
echo "    → HTTP 200 proves the public device subdomain reaches this Mac."

echo
echo "==> Smoke tests passed. Relay + SNI tunnel + local app all wired."
