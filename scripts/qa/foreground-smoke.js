#!/usr/bin/env node
process.env.ROBOTDOJO_ALLOW_PLAINTEXT ||= '1';
process.env.ROBOTDOJO_DB ||= ':memory:';
process.env.ROBOTDOJO_LOCAL_DB_KEY ||= 'e'.repeat(64);
process.env.SESSION_SECRET ||= 'foreground-smoke-session-secret-32b';
process.env.OLLAMA_HOST ||= 'http://example.invalid';
process.env.ROBOTDOJO_GRANOLA_DIR ||= '/tmp/robotdojo-foreground-smoke-granola';
process.env.ROBOTDOJO_OAUTH_TEST_MEMORY_STORE ||= '1';

// Keep this smoke focused on foreground route latency. A fresh macOS Keychain
// read can consume the whole 1500ms budget before the in-memory route work runs.
for (const name of [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_AI_API_KEY',
  'XAI_API_KEY',
  'NOTION_API_KEY',
  'NOTION_TOKEN',
  'ASANA_PAT',
  'ASANA_PAT_SECONDARY',
  'BRAVE_API_KEY',
  'ELEVENLABS_API_KEY',
  'OURA_PAT',
  'MICROSOFT_TENANT_ID',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
]) {
  process.env[name] ||= `smoke-${name.toLowerCase()}`;
}

import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { default: db } = await import('../../lib/db.js');
const { default: accountsRoutes } = await import('../../routes/accounts.js');
const { default: setupRoutes } = await import('../../routes/setup.js');
const { queueOAuthSync } = await import('../../lib/oauth-sync-queue.js');

const maxMs = Number(process.argv.find((arg) => arg.startsWith('--max-ms='))?.split('=')[1] || 1500);

queueOAuthSync(db, 'google', 'smoke-founder@example.com');
queueOAuthSync(db, 'microsoft', 'smoke-founder@example.com');

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: 'smoke-user', email: 'smoke@example.com' });
  await next();
});
app.get('/chat', (c) => c.html(readFileSync(resolve('apps/chat/index.html'), 'utf8')));
app.get('/account', (c) => c.html(readFileSync(resolve('apps/account/index.html'), 'utf8')));
app.get('/account/:tab', (c) => c.html(readFileSync(resolve('apps/account/index.html'), 'utf8')));
app.route('/', accountsRoutes);
app.route('/api/setup', setupRoutes);

const probes = [
  { name: 'chat shell', path: '/chat', expect: /chat|dojo|message/i },
  { name: 'account integrations shell', path: '/account/integrations', expect: /account|integrations|dojo/i },
  { name: 'account/import status', path: '/api/accounts/integration-cards', expect: /queued|workspace|cards|sections/i },
  { name: 'imports API', path: '/api/accounts/imports', expect: /freshness|dropFolderRows|queued|ready/i },
];

const failures = [];
const results = [];

for (const probe of probes) {
  const started = Date.now();
  const res = await app.request(probe.path);
  const ms = Date.now() - started;
  const body = await res.text();
  const ok = res.status >= 200 && res.status < 400 && ms <= maxMs && probe.expect.test(body);
  results.push({ name: probe.name, path: probe.path, status: res.status, ms, ok });
  if (!ok) {
    failures.push(`${probe.name}: status=${res.status} ms=${ms} useful=${probe.expect.test(body)}`);
  }
}

if (failures.length) {
  console.error('[foreground-smoke] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
}

console.log(`[foreground-smoke] ok — ${results.map((r) => `${r.name} ${r.ms}ms`).join(', ')}`);
