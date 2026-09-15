#!/usr/bin/env node
/**
 * QA: foreground routes remain fast while passive jobs are deep and draining.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.ROBOTDOJO_ALLOW_PLAINTEXT ||= '1';
process.env.ROBOTDOJO_DB ||= join(mkdtempSync(join(tmpdir(), 'robotdojo-passive-foreground-')), 'qa.db');
process.env.ROBOTDOJO_LOCAL_DB_KEY ||= 'c'.repeat(64);
process.env.SESSION_SECRET ||= 'passive-foreground-latency-secret-32';
process.env.OLLAMA_HOST ||= 'http://example.invalid';
process.env.NODE_ENV ||= 'test';

import { Hono } from 'hono';

const maxMs = Number(process.argv.find((arg) => arg.startsWith('--max-ms='))?.split('=')[1] || 350);
const depth = Number(process.argv.find((arg) => arg.startsWith('--depth='))?.split('=')[1] || 600);

const { default: db } = await import('../../lib/db.js');
const { buildServer } = await import('../../lib/server.js');
const { default: accountsRoutes } = await import('../../routes/accounts.js');
const { default: setupRoutes } = await import('../../routes/setup.js');
const { default: sessionLogRoutes } = await import('../../routes/session-log.js');
const {
  drainPassiveJobs,
  enqueuePassiveJob,
  getPassiveJobSummary,
} = await import('../../lib/passive-jobs.js');

db.prepare('DELETE FROM passive_jobs').run();
for (let i = 0; i < depth; i += 1) {
  enqueuePassiveJob({
    jobType: 'drop_folder_import',
    uniqueKey: `qa:foreground-load:${i}`,
    targetType: 'file',
    targetId: `/tmp/foreground-load-${i}.json`,
  });
}

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: 'qa-user', email: 'qa@example.com', is_admin: true });
  c.set('belt', 'black');
  await next();
});
app.get('/chat', (c) => c.html(readFileSync(resolve('apps/chat/index.html'), 'utf8')));
app.get('/account', (c) => c.html(readFileSync(resolve('apps/account/index.html'), 'utf8')));
app.get('/account/:tab', (c) => c.html(readFileSync(resolve('apps/account/index.html'), 'utf8')));
app.route('/', accountsRoutes);
app.route('/', sessionLogRoutes);
app.route('/api/setup', setupRoutes);

const healthApp = await buildServer();

const backgroundDrain = drainPassiveJobs({
  worker: 'qa-foreground-drain',
  jobTypes: ['drop_folder_import'],
  limit: 60,
  handlers: {
    drop_folder_import: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { processed: true };
    },
  },
  pressureCheck: () => ({ ok: true }),
});

async function probe(name, fn, expect) {
  const started = Date.now();
  const value = await fn();
  const ms = Date.now() - started;
  const ok = ms <= maxMs && expect(value);
  return { name, ms, ok, detail: value?.status || value?.ok || null };
}

const probes = [];
probes.push(await probe('/api/server-health', async () => {
  const res = await healthApp.request('/api/server-health');
  const body = await res.json();
  return { status: res.status, body };
}, (value) => value.status === 200 || value.status === 503));

probes.push(await probe('/api/accounts/integration-cards', async () => {
  const res = await app.request('/api/accounts/integration-cards?refresh=1');
  const body = await res.json();
  return { status: res.status, ok: body.passive_jobs?.ok === true };
}, (value) => value.status === 200 && value.ok));

probes.push(await probe('/api/accounts/imports', async () => {
  const res = await app.request('/api/accounts/imports');
  const body = await res.json();
  return { status: res.status, ok: body.passive_jobs?.ok === true };
}, (value) => value.status === 200 && value.ok));

probes.push(await probe('/chat', async () => {
  const res = await app.request('/chat');
  const body = await res.text();
  return { status: res.status, useful: /chat|dojo|message/i.test(body) };
}, (value) => value.status === 200 && value.useful));

probes.push(await probe('/api/session-log/turn', async () => {
  const res = await app.request('/api/session-log/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'qa',
      threadId: 'foreground-latency',
      role: 'user',
      content: 'foreground latency probe',
    }),
  });
  const body = await res.json();
  return { status: res.status, ok: body.ok === true, queued: body.queued === true };
}, (value) => value.status === 202 && value.ok && value.queued));

await backgroundDrain;

const summary = getPassiveJobSummary({ jobTypes: ['drop_folder_import', 'session_log_turn'] });
const ok = probes.every((row) => row.ok);
process.stdout.write(JSON.stringify({
  ok,
  max_ms: maxMs,
  depth,
  probes,
  passive_jobs: summary,
}, null, 2) + '\n');
process.exit(ok ? 0 : 1);
