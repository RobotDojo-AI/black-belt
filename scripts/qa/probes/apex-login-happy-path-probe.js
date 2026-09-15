#!/usr/bin/env node
/**
 * st_fc3856d6 — apex login happy-path probe (AC 1).
 *
 * Verifies the full apex login flow against production
 * https://robotdojo.ai/api/auth/token with a valid token retrieved from
 * the operator's macOS Keychain.
 *
 * Pass criteria:
 *   - HTTP 200
 *   - Response body contains "redirect":"https://dojo.robotdojo.ai/chat"
 *   - Set-Cookie response header carries rdj_session (Mac session passthrough)
 *   - Set-Cookie response header carries rd_server (Bitwarden prefill)
 *
 * Exits 0 on pass, 1 on any failure with a diagnostic line. The probe
 * encapsulates multi-step curl logic in node to avoid shell-quoting
 * surprises in done criteria (per 02-plan.md test strategy).
 *
 * Slug under test: hardcoded to "dojo" — matches the operator's
 * installed slug and the criteria in 00-scope.md AC 1.
 */

import { execSync } from 'node:child_process';

const APEX_URL = 'https://robotdojo.ai/api/auth/token';
const SLUG = 'dojo';
const EXPECTED_REDIRECT = `https://${SLUG}.robotdojo.ai/chat`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function readKeychainToken() {
  try {
    return execSync(
      'security find-generic-password -s "robotdojo-ROBOTDOJO_AUTH_TOKEN" -w',
      { encoding: 'utf8' },
    ).trim();
  } catch (err) {
    fail(`Could not read ROBOTDOJO_AUTH_TOKEN from Keychain: ${err?.message || err}`);
  }
}

async function main() {
  const token = readKeychainToken();
  if (!token) fail('Keychain returned empty token');

  const res = await fetch(APEX_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server: SLUG, token }),
  });

  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    fail(`expected status 200, got ${res.status}; body: ${text.slice(0, 200)}`);
  }

  const body = await res.json().catch(() => ({}));
  if (body?.ok !== true) fail(`expected ok:true in body, got ${JSON.stringify(body)}`);
  if (body?.redirect !== EXPECTED_REDIRECT) {
    fail(`expected redirect=${EXPECTED_REDIRECT}, got ${body?.redirect}`);
  }

  // Node 18+ exposes Headers.getSetCookie(); fall back to .get() (joined
  // string) if not available. getSetCookie returns an array of cookies
  // even when joined comma-separated in transport.
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];

  const joined = setCookies.join(' | ');
  if (!/rdj_session=/.test(joined)) {
    fail(`expected rdj_session Set-Cookie passthrough, got: ${joined}`);
  }
  if (!/rd_server=/.test(joined)) {
    fail(`expected rd_server Set-Cookie, got: ${joined}`);
  }

  const latency = res.headers.get('x-apex-latency-ms');
  console.log(`ok — apex login happy path passes (latency: ${latency || '?'} ms)`);
}

main().catch((err) => fail(`probe threw: ${err?.message || err}`));
