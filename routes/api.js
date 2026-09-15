/**
 * REST API — timeline, search, labels, topics, conversations, usage, stubs.
 * Domain routes split into: network.js, health.js, accounts.js, billing.js
 */
import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import { LRUCache } from 'lru-cache';
import { Hono } from 'hono';
import { putFile, getFile } from '../lib/upload-store.js';
import { INBOX } from '../lib/drop-folder/paths.js';
import { getPersonTimeline, getTimelineStats } from '../lib/timeline-schema.js';
import { search, searchAll } from '../lib/rag-search.js';
import { getAttributedTranscript } from '../lib/transcript-segments.js';
import { confirmAndLearn } from '../lib/transcript-attribution.js';
import db from '../lib/db.js';
import {
  searchConversations,
  searchConversationsRanked,
  searchCompanies,
  deleteTestConversations,
  getUsageByDay,
  getUsageByDayAndModel,
  getUsageByDayAndPurpose,
  getTodayUsage,
} from '../lib/api-queries.js';

import { getReferralCandidates } from '../lib/referral.js';
import config, { availabilitySet } from '../lib/config.js';
import { requireAdmin } from '../lib/middleware-auth.js';
import { founderAppsEnabled } from '../lib/app-registry.js';
import { extractAndPersistEntities } from '../lib/entity-nodes.js';
import { generateTopicContext } from '../lib/topic-context.js';
import { distillOrGenerateTopicContext } from '../lib/topic-distill.js';
import { getTopicsHierarchy, getLabels, createTopic, updateTopic, deleteTopic, batchOrder, getTopicContext, updateTopicContext, patchLabel, createLabel, deleteLabel } from '../lib/topics.js';
import { ensureTopicWorkbench } from '../lib/topic-workbench-seed.js';
import { abandonTopicWorkbenches } from '../lib/workbenches.js';
import { createConversation, listConversations, getConversation, archiveConversation, updateConversationTags, updateConversationTitle, deleteConversation, getInboxCount, updateActionStatus, replaceMessages } from '../lib/conversations.js';
import { findOrCreateLiveConversation, listTopicHistory, recapTopic, subjectKey } from '../lib/topic-live-thread.js';
import { beginTopicChatSession } from '../lib/topic-session.js';
import { applyAtDefine } from '../lib/topic-at-define.js';
import { isOllamaReachable, listOllamaModels } from '../lib/ollama-lifecycle.js';
import { CHAT_MODEL_LANES } from '../lib/chat-models.js';
import { chatModelLane, keychainHasKey, selectableModels } from '../lib/models-picker.js';
import { getConversationByShortId } from '../lib/content-queries.js';
import { isConversationVisible } from '../lib/conversation-visibility.js';
import { readSupervisorCheckpoint } from '../lib/supervisor-status.js';

const _require = createRequire(import.meta.url);

function withDeferredReclassification(result) {
  if (!result || result.ok !== true) return result;
  return { ...result, reclassify_pending: true };
}

async function withTopicWorkbench(result) {
  if (!result || result.ok !== true || !result.slug) return result;
  const workbench = await ensureTopicWorkbench(db, result.slug, {
    maxFiles: 1000,
    ...(process.env.ROBOTDOJO_REPO_ROOT ? { repoRoot: process.env.ROBOTDOJO_REPO_ROOT } : {}),
  });
  if (workbench?.skipped) {
    return {
      ...result,
      workbench_ready: false,
      workbench_skipped: true,
    };
  }
  return {
    ...result,
    workbench_id: workbench.workbench_id,
    workbench_ready: true,
  };
}

function topicErrorStatus(error) {
  if (error === 'not_found') return 404;
  if (error === 'validation_error' || error === 'slugs_required' || error === 'mixed_parent' || error === 'incomplete_sibling_set') return 400;
  return 409;
}

const routes = new Hono();

const MAX_FETCH_BYTES = 1_000_000;

function sanitizeUploadName(name) {
  const raw = basename(String(name || 'upload'));
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\w .@()+,=\-]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return `upload-${crypto.randomUUID()}`;
  }
  return cleaned;
}

function isPrivateIp(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a >= 224)
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80:') ||
      lower.startsWith('ff')
    );
  }
  return true;
}

async function assertFetchUrlAllowed(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('invalid_url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('invalid_protocol');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error('blocked_private_host');
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('blocked_private_host');
    return parsed;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('host_lookup_failed');
  }
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('blocked_private_host');
  }
  return parsed;
}

async function fetchWithSafeRedirects(initialUrl, maxRedirects = 4) {
  let current = initialUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const parsed = await assertFetchUrlAllowed(current);
    const res = await fetch(parsed.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'RobotDojo/1.0' },
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) return { res, finalUrl: parsed.href };
    const location = res.headers.get('location');
    if (!location) throw new Error('invalid_redirect');
    current = new URL(location, parsed.href).href;
  }
  throw new Error('too_many_redirects');
}

async function readTextLimited(res) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_FETCH_BYTES) throw new Error('response_too_large');
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, MAX_FETCH_BYTES);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FETCH_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error('response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

// --- Referral candidates ---

routes.get('/api/referral-candidates', (c) => {
  const limit = parseInt(c.req.query('limit') || '5');
  return c.json(getReferralCandidates(limit));
});

// --- Timeline ---

routes.get('/api/timeline/stats', (c) => {
  return c.json(getTimelineStats());
});

routes.get('/api/timeline/:personId', (c) => {
  const { personId } = c.req.param();
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const sourceType = c.req.query('source_type') || null;
  const events = getPersonTimeline(personId, { limit, offset, sourceType });
  return c.json({ events, count: events.length });
});

// --- Transcript attribution (st_8a841c68) ---

// Read a call's attributed turns + talk-share for the in-app conversation view.
routes.get('/api/transcripts/:id/attribution', (c) => {
  const { id } = c.req.param();
  const result = getAttributedTranscript(db, id);
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

// Pull-based human confirm of a turn's speaker. Sticks permanently and feeds
// the person's cross-call speech profile (the learning loop).
routes.post('/api/transcripts/:id/segments/:segmentId/confirm', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  const personId = body?.personId;
  if (!personId) return c.json({ error: 'personId required' }, 400);
  const segmentId = Number(c.req.param('segmentId'));
  if (!Number.isInteger(segmentId)) return c.json({ error: 'invalid segmentId' }, 400);
  try {
    const updated = await confirmAndLearn(db, segmentId, personId);
    return c.json({ ok: true, segment: updated });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// --- Search (RAG) ---

routes.get('/api/search', async (c) => {
  const q = c.req.query('q') || '';
  const topic = c.req.query('topic') || null;
  const limit = parseInt(c.req.query('limit') || '10');
  if (!q) return c.json({ results: [] });

  // RAG search (topic-scoped) — return legacy array format so existing callers aren't broken
  if (topic) {
    const ragResults = await search(q, { topic, limit });
    return c.json(ragResults);
  }

  // Unified search: conversations + companies + RAG.
  // st_01b16272: people are no longer part of the global search surface —
  // inline entity recognition is the only entity surface now. The former
  // people branch here queried a nonexistent `full_name` column (silently
  // swallowed by the catch below) and never actually returned anyone.
  const like = `%${q}%`;
  const perType = Math.max(3, Math.floor(limit / 3));
  const results = [];

  // Conversations
  try {
    const convRows = searchConversations(db, like, perType);
    for (const r of convRows) results.push({ type: 'conversation', id: r.id, name: r.title, updated_at: r.updated_at });
  } catch { /* table may not exist */ }

  // Companies
  try {
    const companyRows = searchCompanies(db, like, perType);
    for (const r of companyRows) results.push({ type: 'company', id: r.id, name: r.name });
  } catch { /* table may not exist */ }

  // RAG (no topic) — append top results
  try {
    const ragResults = await searchAll(q, { limit: perType });
    for (const r of ragResults) results.push({ type: 'chunk', id: r.id, name: r.metadata?.title || q, source_type: r.source_type });
  } catch { /* rag may not be configured */ }

  // Sort: conversations first (have updated_at), then by type, then alphabetical
  results.sort((a, b) => {
    const order = { conversation: 0, company: 1, chunk: 2 };
    const oa = order[a.type] ?? 3;
    const ob = order[b.type] ?? 3;
    if (oa !== ob) return oa - ob;
    return (a.name || '').localeCompare(b.name || '');
  });

  return c.json({ results: results.slice(0, limit) });
});

// --- Conversation thread search (st_01b16272) ---
// Chat's search box finds past conversations by title or message content —
// not people. Registered before /api/conversations/:id so Hono's dynamic
// param route doesn't swallow the literal "search" path segment.
routes.get('/api/conversations/search', (c) => {
  const q = (c.req.query('q') || '').trim();
  const limit = parseInt(c.req.query('limit') || '20');
  if (!q) return c.json({ results: [] });
  try {
    const results = searchConversationsRanked(db, q, limit);
    return c.json({ results });
  } catch (err) {
    console.warn('[api] /api/conversations/search failed:', err.message);
    return c.json({ results: [] });
  }
});

// --- Labels ---

routes.get('/api/labels', (c) => {
  c.header('Cache-Control', 'private, no-store');
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ labels: [], groups: [] });
  const result = getLabels(db, { includeRootLabels: belt === 'white' });
  const inboxCount = getInboxCount(db);
  return c.json({ ...result, inboxCount, fetched_at: new Date().toISOString() });
});

routes.patch('/api/labels/:tag_name', async (c) => {
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ error: 'not_supported' }, 400);
  const { visible, name, sort_order, parent } = await c.req.json().catch(() => ({}));
  const result = patchLabel(db, c.req.param('tag_name'), { visible, name, sort_order, parent });
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

routes.post('/api/labels', async (c) => {
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ error: 'not_supported' }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (!body.name?.trim()) return c.json({ error: 'name_required' }, 400);
  const result = createLabel(db, body);
  if (result.error) return c.json(result, 409);
  return c.json(await withTopicWorkbench(result));
});

routes.delete('/api/labels/:tag_name', async (c) => {
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ error: 'not_supported' }, 400);
  const result = deleteLabel(db, c.req.param('tag_name'));
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

routes.get('/api/preferences', (c) => {
  return c.json({});
});

// --- Topics ---

routes.get('/api/topics', (c) => {
  return c.json(getTopicsHierarchy(db));
});

routes.post('/api/topics', async (c) => {
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ error: 'not_supported' }, 403);
  let parsed;
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!parsed.slug || !parsed.label) return c.json({ error: 'validation_error' }, 400);
  const result = createTopic(db, parsed);
  if (result.error) return c.json(result, topicErrorStatus(result.error));
  return c.json(withDeferredReclassification(await withTopicWorkbench(result)));
});

// Static topic paths MUST be registered before /:slug.
routes.post('/api/topics/at-define', async (c) => {
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ error: 'not_supported' }, 403);
  let parsed;
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const result = applyAtDefine(db, {
    text: parsed.text,
    currentTopicSlug: parsed.currentTopicSlug || null,
  });
  if (!result?.ok) return c.json(result || { error: 'invalid_at_define' }, 400);
  return c.json(result);
});

// batch-order MUST be registered before /:slug — Hono matches /:slug first otherwise
routes.put('/api/topics/batch-order', async (c) => {
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ error: 'not_supported' }, 403);
  let parsed;
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!Array.isArray(parsed.slugs) || parsed.slugs.length === 0) return c.json({ error: 'slugs_required' }, 400);
  const parent_slug = Object.prototype.hasOwnProperty.call(parsed, 'parent_slug') ? (parsed.parent_slug ?? null) : undefined;
  const result = batchOrder(db, { parent_slug, slugs: parsed.slugs });
  if (result.error) return c.json(result, topicErrorStatus(result.error));
  return c.json(result);
});

routes.put('/api/topics/:slug', async (c) => {
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ error: 'not_supported' }, 403);
  let parsed;
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const result = updateTopic(db, c.req.param('slug'), parsed, generateTopicContext);
  if (!result) return c.json({ error: 'not_found' }, 404);
  if (result.error) return c.json(result, topicErrorStatus(result.error));
  return c.json(withDeferredReclassification(result));
});

routes.delete('/api/topics/:slug', async (c) => {
  const belt = c.get('belt');
  if (belt === 'demo') return c.json({ error: 'not_supported' }, 403);
  let confirm = false;
  try { const body = await c.req.json(); confirm = !!body?.confirm; } catch { /* no body */ }
  const slug = c.req.param('slug');
  const childSlugs = db.prepare('SELECT slug FROM user_topics WHERE parent_slug = ?').all(slug).map((r) => r.slug);
  const result = deleteTopic(db, slug, confirm);
  if (!result) return c.json({ error: 'not_found' }, 404);
  if (result.ok) {
    for (const gone of [slug, ...childSlugs]) abandonTopicWorkbenches(db, gone);
  }
  return c.json(withDeferredReclassification(result));
});

// --- Topic context docs ---

routes.get('/api/topics/:slug/context', (c) => {
  return c.json(getTopicContext(db, c.req.param('slug')));
});

routes.put('/api/topics/:slug/context', async (c) => {
  let parsed;
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  return c.json(updateTopicContext(db, c.req.param('slug'), parsed.content));
});

// POST /api/topics/:slug/context/refresh — BB-gated, AWAITS synthesis, returns result.
// Use this when the user explicitly requests a context regeneration (vs. fire-and-forget on PUT).
routes.post('/api/topics/:slug/context/refresh', async (c) => {
  const belt = c.get('belt');
  if (belt !== 'black') return c.json({ error: 'belt_required' }, 403);
  const slug = c.req.param('slug');
  try {
    // distillOrGenerateTopicContext() delegates straight to the untouched
    // generateTopicContext() while ROBOTDOJO_TOPIC_DISTILL_ENABLED / the
    // topic_distill.enabled config flag is off (the default) — same behavior,
    // same return contract. See lib/topic-distill.js for the owner cutover step.
    const result = await distillOrGenerateTopicContext(slug, db);
    if (!result) return c.json({ ok: true, skipped: true });
    return c.json({ ok: true, length: result.context_md.length });
  } catch (e) {
    console.warn('[api] /refresh failed:', e.message);
    return c.json({ error: 'synthesis_failed' }, 500);
  }
});

routes.get('/api/topics/:slug/live', async (c) => {
  const slug = String(c.req.param('slug') || '').trim();
  if (!slug) return c.json({ error: 'topic_slug_required' }, 400);
  try {
    const live = findOrCreateLiveConversation(db, slug);
    try {
      await beginTopicChatSession(db, { convId: live.conversationId, topicSlug: slug });
    } catch { /* session tracking is best-effort; live open must still return */ }
    return c.json(findOrCreateLiveConversation(db, slug));
  } catch (err) {
    if (err.code === 'topic_slug_required' || err.message === 'topic_slug_required') {
      return c.json({ error: 'topic_slug_required' }, 400);
    }
    return c.json({ error: 'live_failed', message: err.message }, 500);
  }
});

routes.get('/api/topics/:slug/history', (c) => {
  const slug = String(c.req.param('slug') || '').trim();
  if (!slug) return c.json({ error: 'topic_slug_required' }, 400);
  const q = String(c.req.query('q') || '');
  return c.json({
    topicSlug: slug,
    messages: listTopicHistory(db, slug, { q, limit: 80 }),
  });
});

routes.get('/api/subjects/:kind/:id/live', async (c) => {
  const kind = String(c.req.param('kind') || '').trim().toLowerCase();
  const id = String(c.req.param('id') || '').trim();
  if (!kind || !id) return c.json({ error: 'subject_required' }, 400);
  try {
    const key = subjectKey(kind, id);
    const live = findOrCreateLiveConversation(db, key);
    try {
      await beginTopicChatSession(db, { convId: live.conversationId, topicSlug: key });
    } catch { /* session tracking is best-effort */ }
    return c.json(findOrCreateLiveConversation(db, key));
  } catch (err) {
    if (err.code === 'topic_slug_required' || err.message === 'topic_slug_required') {
      return c.json({ error: 'topic_slug_required' }, 400);
    }
    return c.json({ error: 'live_failed', message: err.message }, 500);
  }
});

routes.post('/api/topics/:slug/recap', async (c) => {
  const slug = String(c.req.param('slug') || '').trim();
  if (!slug) return c.json({ error: 'topic_slug_required' }, 400);
  try {
    const body = await recapTopic(db, slug);
    return c.json(body);
  } catch (err) {
    return c.json({ error: 'recap_failed', message: err.message }, 500);
  }
});


// --- Chat maintenance ---

// POST /api/chat/cleanup-test — admin-only: removes stub/test conversations with no messages.
// Intentionally not wired to startup — call manually via curl or admin UI when needed.
// Auth is enforced by the /api/* middleware; this endpoint adds no additional gate.
routes.post('/api/chat/cleanup-test', (c) => {
  const result = deleteTestConversations(db);
  return c.json({ deleted: result.changes });
});

// POST /api/admin/wal-checkpoint — compatibility proof endpoint for QA cleanup.
// Chat owns the foreground lane: this route must never run PRAGMA checkpoint work
// inline. The maintenance worker publishes checkpoint state off-process; the
// foreground route only reports the latest cached result.
routes.post('/api/admin/wal-checkpoint', (c) => {
  const checkpoint = readSupervisorCheckpoint(db);
  return c.json({ deleted: 0, checkpoint, foreground_checkpoint: false });
});

// --- Conversations CRUD ---

routes.post('/api/conversations', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  return c.json(createConversation(db, body));
});

routes.get('/api/conversations', (c) => {
  return c.json(listConversations(db, {
    type: c.req.query('type'),
    all: c.req.query('all'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  }));
});

routes.post('/api/conversations/:id/archive', (c) => {
  const result = archiveConversation(db, c.req.param('id'), true);
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

routes.post('/api/conversations/:id/unarchive', (c) => {
  const result = archiveConversation(db, c.req.param('id'), false);
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

routes.get('/api/conversations/resolve/:shortId', (c) => {
  const shortId = String(c.req.param('shortId') || '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(shortId)) return c.json({ error: 'invalid_short_id' }, 400);
  const rows = getConversationByShortId(db, shortId);
  if (!rows.length) return c.json({ error: 'not_found' }, 404);
  const result = getConversation(db, rows[0].id);
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

routes.get('/api/conversations/:id', (c) => {
  const result = getConversation(db, c.req.param('id'));
  if (!result) return c.json({ error: 'not_found' }, 404);
  // st_abf246e4 — post-fetch visibility gate. getConversation stays unfiltered
  // (routes/chat.js calls it internally for cleanup-verify + mid-turn
  // streaming); a hidden row is 404'd here at the user-facing route only.
  if (!isConversationVisible(result)) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

routes.patch('/api/conversations/:id/title', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const result = updateConversationTitle(db, c.req.param('id'), body?.title);
  if (!result) return c.json({ error: 'not_found' }, 404);
  if (result.error === 'title_required') return c.json({ error: 'title_required' }, 400);
  return c.json(result);
});

const VALID_ACTION_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);

routes.patch('/api/conversations/:id/action', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { status, summary } = body;
  if (!VALID_ACTION_STATUSES.has(status)) {
    return c.json({ error: 'invalid_status' }, 400);
  }
  const result = updateActionStatus(db, id, { status, summary });
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json(result);
});

routes.patch('/api/conversations/:id/tags', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  return c.json(updateConversationTags(db, c.req.param('id'), body.tags));
});

routes.patch('/api/conversations/:id/messages', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  return c.json(replaceMessages(db, c.req.param('id'), body.messages || []));
});

routes.delete('/api/conversations/:id', (c) => {
  return c.json(deleteConversation(db, c.req.param('id')));
});

// --- Usage ---

// WHY: Usage aggregation queries scan the full token_usage table grouped by date/model/purpose.
// On a large DB this is expensive on every tab activation. Five-minute stale window covers
// the realistic refresh cycle — usage data changes only when new API calls are made.
const usageCache = new LRUCache({
  max: 20,
  ttl: 1000 * 60 * 5,       // 5 minutes
  allowStale: true,           // serve stale immediately while revalidating in background
  allowStaleOnFetchRejection: true, // keep serving if DB throws
  fetchMethod: async (key) => {
    const days = parseInt(key.split(':')[1] || '30');
    const byDay = getUsageByDay(db, days);
    const dailyByModel = getUsageByDayAndModel(db, days);
    const dailyByPurpose = getUsageByDayAndPurpose(db, days);
    const totalCents = byDay.reduce((s, d) => s + (d.cost_cents || 0), 0);
    const activeDays = byDay.filter(d => d.cost_cents > 0).length;
    const avgCentsPerDay = activeDays > 0 ? totalCents / activeDays : 0;
    return { byDay, dailyByModel, dailyByPurpose, totalCents, activeDays, avgCentsPerDay };
  },
});

routes.get('/api/usage/today', (c) => {
  try {
    const row = getTodayUsage(db);
    return c.json({ cost_cents: row?.cost_cents || 0, total_cost: (row?.cost_cents || 0) / 100, calls: row?.calls || 0 });
  } catch {
    return c.json({ cost_cents: 0, total_cost: 0, calls: 0 });
  }
});
routes.get('/api/usage/range', async (c) => {
  const days = parseInt(c.req.query('days') || '30');
  try {
    const data = await usageCache.fetch(`usage:${days}`);
    return c.json(data || { byDay: [], dailyByModel: [], dailyByPurpose: [], totalCents: 0, activeDays: 0, avgCentsPerDay: 0 });
  } catch {
    return c.json({ byDay: [], dailyByModel: [], dailyByPurpose: [], totalCents: 0, activeDays: 0, avgCentsPerDay: 0 });
  }
});


// --- Misc stubs ---

routes.get('/version', (c) => c.json({ version: '0.1.0', git: 'robotdojo' }));

// WHY filter by configured keys: the model picker should only surface providers
// the user has actually wired up. Legacy Grok names still resolve in chat, but
// the picker shows xAI and live xAI IDs so account state reflects reality.
// Ollama is excluded from the cloud picker (it's a host URL, not a key-based model).
const { ask: ASK, work: WORK, think: THINK } = CHAT_MODEL_LANES;

// Verified against platform.claude.com/docs/en/about-claude/pricing on 2026-07-27
const ALL_MODELS = [
  // Anthropic
  { key: 'claude-haiku',  name: 'Claude Haiku',  provider: 'Anthropic', providerKey: 'anthropic', isDefault: false,  pricing: { input_per_mtok: 1,  output_per_mtok: 5 },  ...chatModelLane(ASK) },
  { key: 'claude-sonnet', name: 'Claude Sonnet', provider: 'Anthropic', providerKey: 'anthropic', isDefault: false, pricing: { input_per_mtok: 3,  output_per_mtok: 15 }, ...chatModelLane(WORK) },
  { key: 'claude-opus',   name: 'Claude Opus',   provider: 'Anthropic', providerKey: 'anthropic', isDefault: false, pricing: { input_per_mtok: 5,  output_per_mtok: 25 }, ...chatModelLane(THINK) },
  // Google
  { key: 'gemini-flash-lite', name: 'Gemini Flash Lite', provider: 'Google', providerKey: 'google', isDefault: false, pricing: { input_per_mtok: 0.075, output_per_mtok: 0.30 }, ...chatModelLane(ASK) },
  { key: 'gemini-flash',      name: 'Gemini Flash',      provider: 'Google', providerKey: 'google', isDefault: false, pricing: { input_per_mtok: 0.30,  output_per_mtok: 2.50 }, ...chatModelLane(WORK) },
  { key: 'gemini-2.5-pro',    name: 'Gemini Pro',        provider: 'Google', providerKey: 'google', isDefault: false, pricing: { input_per_mtok: 1.25,  output_per_mtok: 10 },   ...chatModelLane(THINK) },
  // OpenAI
  { key: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI', providerKey: 'openai', isDefault: false, pricing: { input_per_mtok: 0.15, output_per_mtok: 0.60 }, ...chatModelLane(ASK) },
  { key: 'gpt-4o',      name: 'GPT-4o',      provider: 'OpenAI', providerKey: 'openai', isDefault: false, pricing: { input_per_mtok: 2.5,  output_per_mtok: 10 },   ...chatModelLane(WORK) },
  { key: 'o3-mini',     name: 'o3 Mini',     provider: 'OpenAI', providerKey: 'openai', isDefault: false, pricing: { input_per_mtok: 1.1,  output_per_mtok: 4.4 },  ...chatModelLane(THINK) },
  // xAI
  { key: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20 Non-reasoning', provider: 'xAI', providerKey: 'xai', isDefault: false, pricing: { input_per_mtok: 1.25, output_per_mtok: 2.5 }, ...chatModelLane(ASK) },
  { key: 'grok-4.3',                     name: 'Grok 4.3',               provider: 'xAI', providerKey: 'xai', isDefault: true, pricing: { input_per_mtok: 1.25, output_per_mtok: 2.5 }, ...chatModelLane(WORK) },
  { key: 'grok-4.20-0309-reasoning',     name: 'Grok 4.20 Reasoning',     provider: 'xAI', providerKey: 'xai', isDefault: false, pricing: { input_per_mtok: 1.25, output_per_mtok: 2.5 }, ...chatModelLane(THINK) },
];

// Thin facade (df_a00a336b Decision E): parse nothing, inject the picker's
// dependencies — the catalog, per-provider key presence, the live availability
// set, and the Ollama live probes — and return the assembled list. All
// selection logic (configured-provider filter, availability filter, Ollama
// prepend) lives in lib/models-picker.js.
routes.get('/api/models', async (c) => {
  return c.json(await selectableModels({
    allModels: ALL_MODELS,
    hasKey: keychainHasKey,
    availabilitySet,
    ollamaReachable: isOllamaReachable,
    listOllama: listOllamaModels,
  }));
});

routes.get('/api/warm', (c) => c.json({ ok: true }));
routes.get('/api/whoami', (c) => c.json({
  name: 'Robot Dojo',
  version: '0.1.0',
  belt: c.get('belt'),
  founder_apps: founderAppsEnabled(),
}));

// Restart — auth-gated. process.exit(0) lets launchd/pm2 restart the process.
// Shell polls /api/warm after sending this to detect when the server is back.
routes.post('/api/admin/restart', requireAdmin(), (c) => {
  console.info('[api] restart requested by authenticated user');
  setTimeout(() => process.exit(0), 100);
  return c.json({ ok: true, message: 'Restarting…' });
});

routes.post('/api/upload', async (c) => {
  // WHY dual auth check: c.get('user') is set by session-cookie auth only.
  // Bearer token auth passes through lib/auth.js requireAuth() middleware
  // (which calls next() without setting user). If an Authorization header is
  // present the middleware has already validated it — reaching this handler
  // means auth succeeded. Check both paths so CLI/script uploads work too.
  const hasBearerAuth = (c.req.header('Authorization') || '').startsWith('Bearer ');
  if (!c.get('user') && !hasBearerAuth) return c.json({ error: 'unauthenticated' }, 401);
  let form;
  try { form = await c.req.formData(); } catch { return c.json({ error: 'invalid_form_data' }, 400); }
  const file = form.get('file');
  if (!file) return c.json({ error: 'file_required' }, 400);

  const name = sanitizeUploadName(file.name || 'upload');
  const mimeType = file.type || 'application/octet-stream';
  const buf = Buffer.from(await file.arrayBuffer());
  const lname = name.toLowerCase();

  if (lname.endsWith('.pdf')) {
    try {
      const pdfParse = _require('pdf-parse');
      const parsed = await pdfParse(buf);
      const text = parsed.text.trim();

      // Fire-and-forget entity extraction — never blocks or breaks the response
      extractAndPersistEntities(text, name).catch(() => {});

      return c.json({ name, content: text, mimeType: 'text/plain', pages: parsed.numpages });
    } catch (e) {
      return c.json({ error: 'pdf_parse_failed', message: e.message }, 500);
    }
  }

  if (mimeType.startsWith('image/')) {
    const id = crypto.randomUUID();
    putFile({ id, name, mimeType, base64: buf.toString('base64') });
    return c.json({ name, fileId: id, mimeType, content: null });
  }

  // WHY XLSX lands in the drop-folder Inbox: the watcher picks it up and
  // routes it through route-xlsx.js → ingest-agency-xlsx.js subprocess.
  // We return immediately with status='queued' — the SSE channel emits
  // file_processed when ingestion completes.
  if (lname.endsWith('.xlsx') || lname.endsWith('.xls')) {
    const inboxPath = join(INBOX, name);
    await writeFile(inboxPath, buf);
    return c.json({
      name,
      content: null,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      status: 'queued',
    });
  }

  if (lname.endsWith('.docx') || mimeType.includes('wordprocessingml.document')) {
    try {
      const mammoth = (await import('mammoth')).default;
      const { value } = await mammoth.extractRawText({ buffer: buf });
      const text = (value || '').trim();
      // Fire-and-forget entity extraction — mirrors the PDF branch; never blocks the response.
      extractAndPersistEntities(text, name).catch(() => {});
      return c.json({ name, content: text, mimeType: 'text/plain' });
    } catch (e) {
      return c.json({ error: 'docx_parse_failed', message: e.message }, 500);
    }
  }

  // Legacy binary .doc is not readable by mammoth — give a clear, actionable message
  // instead of the generic unsupported error.
  if (lname.endsWith('.doc')) {
    return c.json({
      error: 'legacy_doc_unsupported',
      message: "Legacy .doc files aren't supported yet — save it as .docx or PDF and upload again.",
    }, 415);
  }

  return c.json({ error: 'unsupported_file_type' }, 400);
});

routes.get('/api/files/:id/raw', (c) => {
  if (!c.get('user')) return c.json({ error: 'unauthenticated' }, 401);
  const f = getFile(c.req.param('id'));
  if (!f) return c.json({ error: 'not_found' }, 404);
  const buf = Buffer.from(f.base64, 'base64');
  return new Response(buf, { headers: { 'content-type': f.mimeType, 'content-length': String(buf.length) } });
});

// --- URL fetch (safe remote fetch + HTML strip) ---

routes.post('/api/fetch-url', async (c) => {
  let url;
  try {
    const body = await c.req.json();
    url = body?.url;
  } catch {
    return c.json({ ok: false, error: 'invalid_request_body' }, 400);
  }

  if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'url_required' }, 400);

  let parsed;
  try { parsed = await assertFetchUrlAllowed(url); } catch (err) {
    const message = err?.message || 'invalid_url';
    const status = message === 'invalid_protocol' || message === 'invalid_url' ? 400 : 403;
    return c.json({ ok: false, error: message }, status);
  }

  try {
    const { res, finalUrl } = await fetchWithSafeRedirects(parsed.href);
    const raw = await readTextLimited(res);

    // Extract title
    const titleMatch = raw.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Strip HTML tags
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);

    return c.json({ ok: true, url: finalUrl, title, text });
  } catch (err) {
    const message = err?.message || 'fetch_failed';
    const status = message.startsWith('blocked_') ? 403 : 400;
    return c.json({ ok: false, error: message }, status);
  }
});

export default routes;
