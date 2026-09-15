#!/usr/bin/env node
/**
 * verify-edit-targets.js
 * Checks that GET /api/accounts/edit-targets returns full (untruncated) file content:
 *   - user target: first 200 chars match user/workbenches/user/wk_user/USER.md verbatim
 *   - asana skill target: preview length matches the real file length (no 5000-char cap)
 * Exits 0 on PASS, 1 on FAIL.
 * Pre-build: will fail because the endpoint behaviour hasn't changed yet — expected.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import config from '../../lib/config.js';

const ROBOTDOJO = join(homedir(), 'robotdojo');

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
    `curl -sk -H "Authorization: Bearer ${apiKey}" "https://localhost:${config.ports.app}/api/accounts/edit-targets"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
} catch (e) {
  console.error('FAIL: curl request failed:', e.message);
  process.exit(1);
}

let j;
try {
  j = JSON.parse(raw);
} catch {
  console.error('FAIL: response is not valid JSON:', raw.slice(0, 200));
  process.exit(1);
}

// Check user target: first 200 chars must match real file
const youTargets = j.you?.targets || [];
const userTarget = youTargets[0];
if (!userTarget) {
  console.error('FAIL: no user target in you.targets');
  process.exit(1);
}
const userPreview = (userTarget.preview || '').slice(0, 200);
const userReal = readFileSync(join(ROBOTDOJO, 'user/workbenches/user/wk_user/USER.md'), 'utf8').slice(0, 200);
if (userPreview !== userReal) {
  console.error('FAIL: user target first-200 mismatch');
  console.error('  preview:', JSON.stringify(userPreview.slice(0, 80)));
  console.error('  real:   ', JSON.stringify(userReal.slice(0, 80)));
  process.exit(1);
}

// Check asana skill: preview must not be truncated at 5000
const skillTargets = (j['edit-targets']?.targets || j.skills?.targets || []);
const asanaTarget = skillTargets.find(t => t.id && t.id.includes('asana'));
if (asanaTarget) {
  let asanaReal;
  try {
    asanaReal = readFileSync(join(ROBOTDOJO, 'agents/skills/asana/SKILL.md'), 'utf8');
  } catch {
    console.error('FAIL: could not read agents/skills/asana/SKILL.md');
    process.exit(1);
  }
  if (asanaTarget.preview.length !== asanaReal.length) {
    console.error('FAIL: asana SKILL.md truncated — preview', asanaTarget.preview.length, 'vs file', asanaReal.length);
    process.exit(1);
  }
}

console.log('PASS: user first-200 match; asana not truncated');
process.exit(0);
