#!/usr/bin/env node
/**
 * verify-agent-personas.js
 * Checks that GET /api/accounts/agent-personas returns 6 personas
 * in canonical order (Miyagi,Tantei,Hakase,Ori,Katagami,Bunshin)
 * with kanji, role, and body (>=500 chars) on each.
 * Exits 0 on PASS, 1 on FAIL.
 * Pre-build: will fail because the endpoint does not exist yet — that is expected.
 */

import { execSync } from 'child_process';
import config from '../../lib/config.js';

const CANONICAL_ORDER = 'Miyagi,Tantei,Hakase,Ori,Katagami,Bunshin';

let apiKey;
try {
  apiKey = execSync('security find-generic-password -s "robotdojo-ROBOTDOJO_AUTH_TOKEN" -w', {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
} catch {
  console.error('FAIL: could not read ROBOTDOJO_AUTH_TOKEN from Keychain');
  process.exit(1);
}

let raw;
try {
  raw = execSync(
    `curl -sk -H "Authorization: Bearer ${apiKey}" "https://localhost:${config.ports.app}/api/accounts/agent-personas"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
} catch (e) {
  console.error('FAIL: curl request failed:', e.message);
  process.exit(1);
}

let personas;
try {
  personas = JSON.parse(raw);
} catch {
  console.error('FAIL: response is not valid JSON:', raw.slice(0, 200));
  process.exit(1);
}

if (!Array.isArray(personas)) {
  console.error('FAIL: expected array, got:', typeof personas);
  process.exit(1);
}

const order = personas.map(p => p.displayName).join(',');
if (order !== CANONICAL_ORDER) {
  console.error('FAIL order:', order, '(expected:', CANONICAL_ORDER + ')');
  process.exit(1);
}

const badPersona = personas.find(p => !p.kanji || !p.role || !p.body || p.body.length < 500);
if (badPersona) {
  console.error('FAIL missing fields/body on:', badPersona.displayName,
    '— kanji:', !!badPersona.kanji, 'role:', !!badPersona.role, 'body length:', badPersona.body?.length);
  process.exit(1);
}

console.log('PASS: 6 personas, canonical order, full bodies');
process.exit(0);
