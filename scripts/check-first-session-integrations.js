#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { LAUNCH_INTEGRATIONS, LAUNCH_STATES, requiredLaunchIntegrations } from '../lib/launch-integrations.js';

// The beta account-integrations page must PRESENT every one of these
// integration classes. This is a surface-presence assertion against the full
// launch sheet (LAUNCH_INTEGRATIONS) — NOT a claim that each is required:true.
const launchSurfaceIds = [
  'anthropic', 'openai', 'google-ai', 'ollama',
  'google-workspace', 'microsoft', 'apple-local',
  'asana', 'notion', 'granola', 'oura', 'apple-health',
  'github', 'backup', 'remote-access',
];

const surfaceIds = new Set(LAUNCH_INTEGRATIONS.map((i) => i.id));
const missing = launchSurfaceIds.filter((id) => !surfaceIds.has(id));
if (missing.length) throw new Error(`missing launch integrations on the account surface: ${missing.join(', ')}`);

// The true beta required/optional split. github / backup / remote-access are
// product-state cards that ship on the surface but stay required:false — a
// fresh local install cannot be forced to complete relay/backup/github (a
// stranger carries no relay bootstrap secret), so demanding them as
// required:true would wrongly mark first-run perpetually incomplete. Every
// other id on the launch sheet IS required for a complete first run. Asserting
// the split in both directions stops either side from silently drifting — the
// prior guard checked the required:true subset and so reddened on these three.
const OPTIONAL_PRODUCT_STATE = new Set(['github', 'backup', 'remote-access']);
const requiredIds = new Set(requiredLaunchIntegrations().map((i) => i.id));
for (const id of launchSurfaceIds) {
  const shouldBeRequired = !OPTIONAL_PRODUCT_STATE.has(id);
  if (shouldBeRequired && !requiredIds.has(id)) {
    throw new Error(`launch integration '${id}' must be required:true for first-run completion`);
  }
  if (!shouldBeRequired && requiredIds.has(id)) {
    throw new Error(`product-state card '${id}' must stay required:false — a fresh local install cannot be forced to complete it`);
  }
}

for (const item of LAUNCH_INTEGRATIONS) {
  if (!item.recovery || item.recovery.length < 20) throw new Error(`${item.id} missing useful recovery copy`);
  if (!item.substrate_type) throw new Error(`${item.id} missing substrate_type`);
}
if (!LAUNCH_STATES.includes('needs_permission')) throw new Error('launch states missing needs_permission');

const accountsRoute = readFileSync('routes/accounts.js', 'utf8');
for (const provider of ['asana', 'notion', 'oura', 'ollama']) {
  if (!accountsRoute.includes(provider)) throw new Error(`accounts route does not surface ${provider}`);
}
if (!/provider:\s*'imports'/.test(accountsRoute)) {
  throw new Error('accounts route must surface Imports as a Workspace account row');
}
if (/disableAndRemove/.test(accountsRoute)) {
  throw new Error('accounts route must not delete/disable Ollama when a cloud key is saved');
}

const migration = readFileSync('lib/migrations/079_restore_launch_required_integrations.sql', 'utf8');
for (const provider of ['notion', 'oura']) {
  if (!migration.includes(provider)) throw new Error(`catalog restoration missing ${provider}`);
}

process.stdout.write('[check-first-session-integrations] ok\n');
