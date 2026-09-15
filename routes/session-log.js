/**
 * /api/session-log — endpoint for external AI tools (Claude Code, etc) to
 * POST chat turns and bookmarks into the user's hash-chained memory log.
 *
 * Auth: existing Bearer token from the local app (ROBOTDOJO_AUTH_TOKEN in
 * Keychain). Claude Code's hook script reads the same token and sends it.
 *
 * Shape:
 *   POST /api/session-log/turn
 *     { source, threadId, role, content, toolName?, summary? }
 *   POST /api/session-log/bookmark
 *     { source, threadId, summary, decisions?, nextSteps?, openQuestions? }
 *   POST /api/session-log/batch
 *     { entries: Array<{ kind: 'turn'|'bookmark', ...fields }> }
 */
import { Hono } from 'hono';
import {
  enqueueSessionLogBatch,
  enqueueSessionLogBookmark,
  enqueueSessionLogTurn,
  getSessionLogQueueStatus,
} from '../lib/session-log-queue.js';

const routes = new Hono();

const ALLOWED_ROLES = new Set(['user', 'assistant', 'tool', 'system']);
const MAX_BODY_CHARS = 200_000;  // a generous 200KB per turn — Claude Code transcripts can be long
const MAX_BATCH = 200;

function enqueueOrBusy(c, queued) {
  if (!queued.ok) {
    return c.json({
      ok: false,
      error: queued.error,
      queue: getSessionLogQueueStatus(),
    }, 429);
  }
  return c.json({
    ok: true,
    queued: true,
    job_id: queued.id,
    queue_depth: queued.depth,
    mode: queued.durable ? 'durable' : 'memory',
    durable: !!queued.durable,
    delayed: !!queued.delayed,
  }, 202);
}

function validateTurn(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.threadId || typeof body.threadId !== 'string') return 'threadId required';
  if (!body.role || !ALLOWED_ROLES.has(body.role)) return `role must be one of ${[...ALLOWED_ROLES].join(', ')}`;
  if (typeof body.content !== 'string') return 'content required (string)';
  if (body.content.length > MAX_BODY_CHARS) return `content exceeds ${MAX_BODY_CHARS} chars`;
  return null;
}

function validateBookmark(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.threadId || typeof body.threadId !== 'string') return 'threadId required';
  if (!body.summary || typeof body.summary !== 'string') return 'summary required';
  for (const k of ['decisions', 'nextSteps', 'openQuestions']) {
    if (body[k] !== undefined && !Array.isArray(body[k])) return `${k} must be array`;
  }
  return null;
}

routes.post('/api/session-log/turn', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const err = validateTurn(body);
  if (err) return c.json({ error: err }, 400);
  return enqueueOrBusy(c, enqueueSessionLogTurn(body));
});

routes.get('/api/session-log/status', (c) => {
  return c.json({ ok: true, queue: getSessionLogQueueStatus() });
});

routes.post('/api/session-log/bookmark', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const err = validateBookmark(body);
  if (err) return c.json({ error: err }, 400);
  return enqueueOrBusy(c, enqueueSessionLogBookmark(body));
});

// Batch endpoint — Claude Code's Stop hook can fire rapidly; one POST per
// turn across N events chains N log entries sequentially (each waits on the
// prior). Batch lets the hook send a whole session's worth in one call.
routes.post('/api/session-log/batch', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body || !Array.isArray(body.entries)) return c.json({ error: 'entries_required' }, 400);
  if (body.entries.length > MAX_BATCH) return c.json({ error: `batch exceeds ${MAX_BATCH} entries` }, 400);

  const results = [];
  const entries = [];
  for (const [index, entry] of body.entries.entries()) {
    if (entry.kind === 'turn') {
      const err = validateTurn(entry);
      if (err) { results.push({ ok: false, index, error: err }); continue; }
      entries.push(entry);
      results.push({ ok: true, index, queued: true });
    } else if (entry.kind === 'bookmark') {
      const err = validateBookmark(entry);
      if (err) { results.push({ ok: false, index, error: err }); continue; }
      entries.push(entry);
      results.push({ ok: true, index, queued: true });
    } else {
      results.push({ ok: false, index, error: `unknown kind: ${entry.kind}` });
    }
  }
  const ok = results.every((r) => r.ok);
  if (!ok) return c.json({ ok, results }, 207);
  return enqueueOrBusy(c, enqueueSessionLogBatch({ entries, source: body.source || 'unknown' }));
});
export default routes;
