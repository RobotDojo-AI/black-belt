/**
 * Chat streaming endpoint — thin HTTP facade.
 *
 * All DB operations and business logic live in lib/ modules. This file only:
 *   - Parses the request body
 *   - Calls lib functions
 *   - Sends the SSE response
 *
 * SSE event types:
 *   status      — { conversationId, hasRAG, toolCount }
 *   phase       — { name, degraded?, label? } — server lifecycle phase: connected |
 *                  assembling_context | searching_memory | calling_tools | streaming |
 *                  persisted | thinking. `degraded:true` + a plain-English `label` ride
 *                  the connected phase when lib/provider-health.js reads REPEATED
 *                  overload/rate-limit/5xx errors from Anthropic in the recent window
 *                  (st_b57e6ec5) — the indicator renders that label for the rest of the
 *                  turn instead of inventing its own copy. Gated OFF by default behind
 *                  isProviderHealthEnabled() (config/defaults.json providerHealth.enabled,
 *                  env ROBOTDOJO_PROVIDER_HEALTH_ENABLED) — see lib/provider-health.js for
 *                  why a latency-based signal was deliberately NOT shipped here.
 *   delta       — { text } — streaming text fragment
 *   tool_start  — { name, args } — tool execution beginning
 *   tool_done   — { name, result } — tool execution complete
 *   entity_recognized — { entities: [{id,name,type,n2,score}] } — inline recognition (st_f1a40461 AC9)
 *   secure_input — { provider, label } — frontend should render secure key input
 *   conv_saved  — { ok, conversationId }
 *   done        — { usage, cost_cents }
 *   error       — { message }
 *
 * Observability: every turn writes a row to chat_turn_metrics via
 * lib/observability/chat-turn.js. Errors are recorded with an `error_type`
 * taxonomy: 'llm_error' | 'simulated_stall' | 'simulated_error'.
 *
 * Test hooks (fail-closed):
 *   - process.env.ROBOTDOJO_CHAT_SIMULATE === '1' for local/unit tests
 *   - authenticated admin + x-robotdojo-qa-simulate: 1 for production QA
 *   ?simulate=stall    — emit status + phase:connected + persist a canned reply
 *                        to the DB, then HALT the stream (no `done` frame).
 *   ?simulate=error    — emit status + an SSE `error` frame, then close.
 *   ?simulate=degraded — force phase:connected's provider-health payload to
 *                        degraded (no metrics faked/written) and complete a
 *                        normal-shaped turn with a canned reply + `done`.
 */
import crypto from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { Hono } from 'hono';
import { streamChat } from '../lib/chat.js';
import { events as dropFolderEvents } from '../lib/drop-folder/watcher.js';
import { executeTool, getToolCount } from '../lib/chat-tools.js';
import { estimateCostCents } from '../lib/compute-tier.js';
import db from '../lib/db.js';
import { makeSender } from '../lib/sse.js';
import { writeConversationFile } from '../lib/transcripts.js';
import { getLabels } from '../lib/topics.js';
import { modelFor } from '../lib/model-lane.js';
import {
  upsertConversation,
  persistMessagesWithBusyRetry,
  runWithChatBusyRetry,
  inferTopicFromContent,
  getThreads,
  getThreadContext,
  appendThreadMessage,
  deleteThreadMessage,
  compressConversation,
  getConversation,
  purgeQaTestConversation,
} from '../lib/conversations.js';
import { findSavedFactForRecall } from '../lib/chat-tools/user-fact-store.js';
import { beginTopicChatSession, closeTopicChatSession } from '../lib/topic-session.js';
import { detectQueryEntities, getChatModel } from '../lib/chat-context.js';
// st_df0a8d71 D5 — direct-entity lookups run on the context worker thread with
// a REAL deadline, so sync SQL under writer contention can never stall the
// pre-model path (kill-switch: ROBOTDOJO_CONTEXT_WORKER=0 → inline).
import { buildDirectEntityAnswerSmart } from '../lib/chat/context-worker.js';
// @miyagi product guidance mode. Authenticated chat routes the mention to the
// same codebase-grounded FAQ stream as public docs, without enabling tools.
import { isAssistantMention, stripAssistantMentionFromMessages, streamAssistantMention } from '../lib/chat-tools/white/assistant-mention.js';
import { isFounderFeedbackMention, streamFounderFeedbackMention } from '../lib/chat-tools/white/founder-feedback.js';
import {
  newTurnId,
  startChatTurnDeferred,
  awaitTurnInsert,
  completeTurn,
  recordFirstToken,
  recordCompletion,
  recordError,
  recordMemoryContext,
  recordEnrichmentHealth,
  recordEgoBlock,
} from '../lib/observability/chat-turn.js';
// st_8c7b7a6b D5 — rolling TTFT estimator. Module-local state; no DB.
// recordTTFT() fires at first-delta; estimateTTFT() serves GET /api/chat/ttft-estimate.
import { recordTTFT, estimateTTFT } from '../lib/chat-ttft-estimator.js';
// st_8c7b7a6b D3 — speculative sonnet ping at request entry.
import {
  chatModelLaneKey,
  isProductionChatModel,
  providerNameForChatModel,
  resolveChatModelId,
} from '../lib/chat-models.js';
import { recordIntegrationJobHealth } from '../lib/oauth-sync-queue.js';
// st_2cd1af73 AC-1 — env-gated request-entry tracer. Zero cost unless
// ROBOTDOJO_CHAT_ENTRY_TRACE=1; names the dominant pre-first-frame term.
import { startEntryTrace, ENTRY_TRACE_ENABLED } from '../lib/chat/entry-trace.js';
import { parseRecallFactQuery, parseRememberFact } from '../lib/chat/memory-intent.js';
import {
  parseRelationshipCorrection,
  executeRelationshipCorrection,
  parseRelationshipQuestion,
  answerRelationshipQuestion,
} from '../lib/chat/relationship-intent.js';
import { recordViewerCorrection } from '../lib/viewer-corrections.js';
// st_b57e6ec5 — deterministic, read-only provider-health signal (overload/
// error rate only — see lib/provider-health.js for why latency was dropped
// from this signal) so the customer sees an honest note instead of blaming
// Robot Dojo for an upstream Anthropic error. Gated off by default —
// isProviderHealthEnabled() decides whether the normal path attaches it.
import { getProviderHealth, providerHealthMessage, isProviderHealthEnabled, PROVIDER_DEGRADED_MESSAGE } from '../lib/provider-health.js';
// st_8c7b7a6b — cookie-or-Bearer middleware for the two new endpoints so the
// behavioral spec (tests/specs/st_8c7b7a6b.test.js) can mount routes/chat.js
// directly without lib/server.js's global middleware in front. Mirrors the
// pattern documented in CLAUDE.md "Route auth — cookie-or-Bearer".
import { requireAuth as requireSessionOrBearer } from '../lib/middleware-auth.js';
import { recordChatAppActive } from '../lib/request-observer.js';

const routes = new Hono();

// Heartbeat interval — keeps the SSE connection alive through proxies and
// Vercel's 25s idle timeout. Sent as a comment so clients ignore it.
const HEARTBEAT_MS = 15000;
const CHAT_EVENTS_MAX_AGE_MS = Number(process.env.ROBOTDOJO_CHAT_EVENTS_MAX_AGE_MS || (process.env.VERCEL ? 8000 : 0));
const DIRECT_LOCAL_ANSWER_CHUNK_CHARS = 180;
const DIRECT_LOCAL_PERSIST_RETRY_MS = [100, 250, 500, 1000, 2000, 4000, 8000, 16000, 30000];
const _conversationPersistQueue = new Map();
const yieldFirstSseFrame = () => new Promise((resolve) => {
  if (typeof setImmediate === 'function') setImmediate(resolve);
  else setTimeout(resolve, 0);
});

function* chunkDirectLocalAnswer(text) {
  const body = String(text || '');
  for (let i = 0; i < body.length; i += DIRECT_LOCAL_ANSWER_CHUNK_CHARS) {
    yield body.slice(i, i + DIRECT_LOCAL_ANSWER_CHUNK_CHARS);
  }
}

function enqueueConversationPersist(conversationId, task) {
  const previous = _conversationPersistQueue.get(conversationId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tracked = current.finally(() => {
    if (_conversationPersistQueue.get(conversationId) === tracked) {
      _conversationPersistQueue.delete(conversationId);
    }
  });
  _conversationPersistQueue.set(conversationId, tracked);
  return tracked;
}

function parseViewerCorrectionContext(value) {
  if (!value) return null;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const parsed = JSON.parse(raw);
    return parsed?.mode === 'viewer_correction' ? parsed : null;
  } catch {
    return null;
  }
}

function viewerCorrectionTextFromMessage(value) {
  const lines = String(value || '')
    .replace(/```json[\s\S]*?```/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Correction for\b/i.test(line))
    .filter((line) => !/^Section:/i.test(line))
    .filter((line) => !/^Replace this line with the correction to record\.?$/i.test(line));
  return lines.join('\n').trim();
}
function qaSimulationAllowed(c) {
  if (process.env.ROBOTDOJO_CHAT_SIMULATE === '1') return true;
  const header = String(c.req.header('x-robotdojo-qa-simulate') || '').trim();
  const user = c.get('user');
  const session = c.get('session');
  return header === '1' && (Boolean(user?.is_admin) || session?.id === 'bearer');
}

function truthyQaFlag(value) {
  if (value === true || value === 1) return true;
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function qaTestChatRequested(c, body, _enabled) {
  const requested = truthyQaFlag(c.req.header('x-robotdojo-test-chat'))
    || truthyQaFlag(body?.qaTestChat)
    || truthyQaFlag(body?.testChat)
    || truthyQaFlag(body?.qaTest);
  // Cleanup is safe for any authenticated caller: it only deletes the current
  // test conversation. Fault injection remains separately gated by `enabled`.
  return Boolean(requested);
}

function testChatCleanupDelayMs() {
  const raw = Number(process.env.ROBOTDOJO_TEST_CHAT_CLEANUP_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 10_000;
}

function cleanupQaTestConversation(conversationId) {
  if (!conversationId) return;
  try {
    const { filePath, transcriptOrphaned } = purgeQaTestConversation(db, conversationId);
    if (filePath && transcriptOrphaned && existsSync(filePath)) unlinkSync(filePath);
  } catch (err) {
    console.warn('[chat] qa test conversation cleanup failed:', err?.message || err);
  }
}

// st_df0a8d71 — SELF-VERIFYING cleanup. Zero-residue is by definition, so the
// purge re-checks itself: after the first pass a delayed verify re-purges if
// the conversation row still exists (observed live: under back-to-back QA
// turns a small fraction of purges left the row behind with no error logged —
// a timing ghost this retry closes regardless of its cause) and the second
// pass warns loudly, so persistent residue can never be silent.
const QA_CLEANUP_VERIFY_DELAY_MS = 5_000;

function scheduleQaTestConversationCleanup(conversationId, delayMs = 0) {
  if (!conversationId) return;
  const timer = setTimeout(() => {
    cleanupQaTestConversation(conversationId);
    const verify = setTimeout(() => {
      try {
        if (getConversation(db, conversationId)) {
          console.warn(`[chat] qa test conversation ${conversationId} survived first purge — re-purging`);
          cleanupQaTestConversation(conversationId);
        }
      } catch { /* verification is best-effort; the purge itself already warns */ }
    }, QA_CLEANUP_VERIFY_DELAY_MS);
    if (typeof verify.unref === 'function') verify.unref();
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function parseQaEnrichmentFaults(c, body, enabled) {
  if (!enabled) return [];
  const raw = [
    c.req.query('qa_fault'),
    c.req.query('qaFault'),
    c.req.header('x-robotdojo-qa-fault'),
    body?.qaFault,
    body?.qaFaults,
    body?.enrichmentFaults,
  ].filter(Boolean);
  const values = [];
  for (const item of raw) {
    const parts = Array.isArray(item) ? item : String(item).split(/[\s,]+/);
    for (const part of parts) {
      const value = String(part || '').trim();
      if (value) values.push(value);
    }
  }
  return [...new Set(values)];
}

const PLACEHOLDER_CONTEXT_SLUGS = new Set([
  'all',
  'general',
  'needs-routing',
  'uncategorized',
]);

function isContextSlug(value) {
  if (typeof value !== 'string') return false;
  const slug = value.trim();
  if (!slug) return false;
  return !PLACEHOLDER_CONTEXT_SLUGS.has(slug.toLowerCase());
}

function normalizeContextSlugs(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.filter(isContextSlug).map(v => v.trim()))];
  }
  if (value && typeof value === 'object') {
    for (const key of ['slug', 'topic_slug', 'topicSlug', 'id', 'value']) {
      if (isContextSlug(value[key])) return [value[key].trim()];
    }
    return [];
  }
  return isContextSlug(value) ? [value.trim()] : [];
}

function publicToolResult(result = {}) {
  return Object.fromEntries(
    Object.entries(result || {}).filter(([k]) => !k.startsWith('_'))
  );
}

routes.get('/api/chat/events', (c) => {
  let aborted = false;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  function write(data) {
    if (aborted) return;
    writer.write(encoder.encode(data)).catch(() => {});
  }

  const heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);
  let maxAgeTimer;
  const handler = (evt) => {
    if (!evt?.type || !evt.type.startsWith('file_')) return;
    write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  dropFolderEvents.on('event', handler);
  write(': connected\n\n');

  function close() {
    if (aborted) return;
    aborted = true;
    clearInterval(heartbeat);
    if (maxAgeTimer) clearTimeout(maxAgeTimer);
    dropFolderEvents.off('event', handler);
    writer.close().catch(() => {});
  }

  if (CHAT_EVENTS_MAX_AGE_MS > 0) {
    maxAgeTimer = setTimeout(() => {
      write('event: server_timeout\ndata: {"ok":true}\n\n');
      close();
    }, CHAT_EVENTS_MAX_AGE_MS);
  }

  c.req.raw.signal?.addEventListener('abort', close);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

routes.post('/api/chat/stream', async (c) => {
  // Continue the middleware tracer's timeline when present (server.js stores
  // it on context for /api/chat/stream), so the activity-stamp + auth + rate
  // -limit middleware steps and the route's own steps flush as ONE line.
  const trace = c.get('entryTrace') || startEntryTrace('chat');
  trace.mark('route_enter');
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  trace.mark('json_parse');
  const { messages, conversationId, topic, context, thinking, injectedContext, files } = body;
  const requestedMode = body.mode === 'deep' || body.mode === 'fast' ? body.mode : undefined;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: 'messages_required' }, 400);
  }

  // Model resolution order:
  //   1. body.model — UI-selected model on this request (one-off override)
  //   2. user_settings.chat_model — persistent per-user preference
  //   3. config.models.chat — install default (Grok 4.3 / balanced)
  //
  // The UI model picker writes to user_settings.chat_model so subsequent
  // turns inherit that choice without echoing it in every request body.
  let model = body.model || null;
  let modelResolved = Boolean(model);
  function resolveModelForTurn() {
    if (!modelResolved) {
      modelResolved = true;
      // Thin-facade: getChatModel() lives in lib/chat-context.js — keeps
      // routes/ free of db.prepare calls (st_5a63545d AC 22). This read used to
      // happen before the first SSE frame; keep it behind status so SQLite
      // contention cannot make the UI look dead.
      const persisted = getChatModel(db);
      if (persisted && isProductionChatModel(persisted) && chatModelLaneKey(persisted) === 'ask') {
        model = persisted;
      }
    }
    return model;
  }
  trace.mark('model_resolve_deferred');

  const belt = c.get('belt') || 'white';
  // Session id — used by tools (e.g. request_credential) that must bind
  // state to the current signed-in browser session. May be null on
  // bearer-token flows where no browser session exists.
  const session = c.get('session');
  const sessionId = session?.id || null;
  const convId = conversationId || crypto.randomUUID();
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const title = lastUserMsg?.content?.slice(0, 100) || 'New conversation';
  const rememberFact = parseRememberFact(lastUserMsg?.content);
  const recallFactQuery = rememberFact ? null : parseRecallFactQuery(lastUserMsg?.content);
  // st_df0a8d71 D4 — deterministic relationship/employer correction, same
  // route-side shape as rememberFact. Parse only; resolution + the
  // code-validated graph write live in lib/chat/relationship-intent.js.
  const relationshipCorrection = rememberFact || recallFactQuery
    ? null
    : parseRelationshipCorrection(lastUserMsg?.content);
  // st_df0a8d71 QA fix — reverse-direction relationship questions ("Who is my
  // mother-in-law?") answer from the GRAPH deterministically, BEFORE any
  // entity-card path can fire (the live defect: the question's "law" token
  // entity-matched an unrelated surname and the direct-entity card hijacked
  // the answer). Closed vocabulary; unmatched questions flow to the model.
  const relationshipQuestion = rememberFact || recallFactQuery || relationshipCorrection
    ? null
    : parseRelationshipQuestion(lastUserMsg?.content);
  const viewerCorrection = parseViewerCorrectionContext(injectedContext);

  // Upsert conversation — topic_slug captured on INSERT only; preserved on CONFLICT.
  // st_6360589a: also resolve the topic's display name and pass through as
  // tagName so upsertConversation writes `tags=[name]` inline at INSERT.
  // Previously the browser's doSend() made a secondary PATCH /tags call after
  // the first turn — that round-trip is now eliminated and the create-time
  // write is a single SQL transaction. `tags` JSON shape is unchanged
  // (a one-element array of the display name), so all downstream readers
  // (topics.js, taxonomy.js, imports-snapshot.js) keep working.
  //
  // st_2cd1af73 AC-1 (residual): this upsert is a SYNCHRONOUS write on the single
  // SQLCipher writer. Run inline before the stream's first `status` frame it
  // blocked TTFT for SECONDS whenever a turn landed during the embed daemon's
  // write transaction (a 27.7s `INSERT INTO conversations` hold was captured).
  // convId is already computed synchronously (crypto.randomUUID above), so the
  // status frame needs NOTHING from the DB. We therefore DEFER the whole upsert —
  // including the getLabels() topic-name read it depends on — to the next
  // macrotask via setImmediate, off the pre-first-token path. persistMessages at
  // stream end awaits this promise first (ensureConversationRow) so the
  // conversation row is guaranteed present before the messages insert.
  const explicitContextSlugs = normalizeContextSlugs(context);
  let contextSlugs = explicitContextSlugs;
  let topicSlug = contextSlugs[0] || null;
  let contextSlugsResolved = explicitContextSlugs.length > 0;
  function resolveContextSlugs() {
    if (!contextSlugsResolved) {
      contextSlugsResolved = true;
      // st_df0a8d71 AC-6 — QA fault `topic_inference` (admin-gated and
      // fail-closed exactly like every other qa fault: parseQaEnrichmentFaults
      // returns [] unless the simulate gate is on). It skips content-based
      // topic inference so the turn runs the pinned no-slug worst case — the
      // uniform configuration the fact quiz grades against. A "no-topic" chat
      // is otherwise NOT guaranteed topicless (inference can attach a slug).
      if (enrichmentFaults.includes('topic_inference')) {
        contextSlugs = [];
        topicSlug = null;
        return contextSlugs;
      }
      const inferredContextSlug = lastUserMsg?.content
        ? inferTopicFromContent(lastUserMsg.content, db)?.slug || null
        : null;
      contextSlugs = inferredContextSlug ? [inferredContextSlug] : [];
      topicSlug = contextSlugs[0] || null;
    }
    return contextSlugs;
  }
  const chatType = body.chat_type === 'action' ? 'action' : 'chat';
  let _conversationRowPromise = null;
  let qaTestChat = false;
  function ensureConversationRow() {
    if (_conversationRowPromise) return _conversationRowPromise;
    _conversationRowPromise = new Promise((resolve) => {
      setImmediate(async () => {
        try {
          let topicTagName = null;
          if (topicSlug) {
            const allLabels = getLabels(db);
            topicTagName = allLabels?.labels?.find(l => l.slug === topicSlug)?.name || null;
          }
          // st_abf246e4 — stamp origin='test' at creation for qa/test chats so
          // the visibility predicate hides-and-preserves them by provenance
          // (never a title heuristic). qaTestChat is resolved before this
          // deferred row insert fires, so the closure reads the final value.
          await runWithChatBusyRetry(
            db,
            () => upsertConversation(db, { id: convId, title, model, topicSlug, topicSlugs: contextSlugs, tagName: topicTagName, chatType, origin: qaTestChat ? 'test' : null }),
            { label: 'chat:upsertConversation' },
          );
        } catch (err) {
          // Observability/persistence is best-effort here — a failed upsert must
          // not break the stream. persistMessages will INSERT the conversation
          // row implicitly via its own path if needed; log so it is visible.
          console.error('[chat] deferred upsertConversation failed:', err.message);
        }
        resolve();
      });
    });
    return _conversationRowPromise;
  }
  let requestModel = null;
  let requestProvider = null;
  function resolveModelMetadata() {
    const selectedModel = resolveModelForTurn();
    requestModel = resolveChatModelId(selectedModel);
    requestProvider = providerNameForChatModel(selectedModel);
    return selectedModel;
  }
  const recordProviderRuntimeHealth = (status, error = null) => {
    if (!requestProvider) return;
    try {
      if (status === 'ok') {
        recordIntegrationJobHealth(db, requestProvider, 'ok');
      } else {
        recordIntegrationJobHealth(db, requestProvider, 'error', { error });
      }
    } catch {
      // Integration status is observability; it must never break chat.
    }
  };

  // ── Test simulation hooks (fail-closed) ────────────────────────────────────
  // Read process.env at REQUEST TIME so flipping the env between requests
  // works in tests without restarting the module. Production QA must be
  // authenticated admin traffic with an explicit header; query string alone is
  // inert, so normal users cannot accidentally trigger simulated failures.
  const simulateParam = c.req.query('simulate');
  const simulateGateOn = qaSimulationAllowed(c);
  // st_b57e6ec5 — 'degraded' joins 'stall'/'error' as a documented, gated
  // test hook: it forces the provider-health signal to 'degraded' for THIS
  // request only (no DB write, no real metrics touched) so the honest
  // slow-provider banner can be verified in the browser without waiting
  // for, or faking, a real Anthropic outage.
  const simulateMode = simulateGateOn && (simulateParam === 'stall' || simulateParam === 'error' || simulateParam === 'degraded')
    ? simulateParam
    : null;
  const enrichmentFaults = parseQaEnrichmentFaults(c, body, simulateGateOn);
  qaTestChat = qaTestChatRequested(c, body, simulateGateOn);

  // Per-turn observability — st_2cd1af73 AC-1 (residual): the turn id is now
  // produced SYNCHRONOUSLY with zero DB (newTurnId = crypto.randomUUID), and the
  // row INSERT is DEFERRED to the next macrotask (startChatTurnDeferred, fired
  // inside the stream AFTER the status frame). The old startChatTurn() ran a
  // synchronous INSERT here, before the first frame, where it could block for
  // seconds behind the SQLCipher writer during embed-daemon writes. record*
  // helpers buffer their UPDATE until the deferred INSERT lands, so no turn is
  // lost and ttft_ms still attaches even if a token arrives before the row.
  const turn_id = newTurnId();
  trace.mark('start_chat_turn');

  // st_8c7b7a6b D5 — capture request start for the rolling TTFT estimator.
  // We feed the in-process estimator from the first-delta callback so the
  // /api/chat/ttft-estimate endpoint reflects real network conditions.
  const _requestStartMs = Date.now();

  // st_8c7b7a6b D3, narrowed for launch stability: speculative provider pings
  // are useful only after an idle gap. Firing one beside every real turn creates
  // a second provider call competing with the user's stream, and deterministic
  // local memory writes do not need a provider socket at all.
  trace.mark('warmup_ping_deferred');

  const stream = new ReadableStream({
    start(controller) {
      let heartbeat = null;
      void (async () => {
      trace.mark('stream_start');
      const send = makeSender(controller);
      const firstFramePadding = new TextEncoder().encode(`: ${' '.repeat(2048)}\n\n`);
      const sendFirstFramePadding = () => {
        try { controller.enqueue(firstFramePadding); } catch {}
      };
      const closeStream = () => {
        try { controller.close(); } catch {}
      };
      let fullContent = '';
      let tokenCount = 0;
      const toolCalls = [];
      let firstTokenRecorded = false;
      // Provider-reported usage (incl. cache_creation/cache_read tokens) —
      // captured via the onMetric.completion callback wired below. We keep
      // both the route-computed estimate AND the provider truth so the SSE
      // `done` frame can still send the friendlier counts while metrics
      // record the actual numbers from the model.
      let providerUsage = null;
      let providerResponseModel = null;
      let providerResponseProvider = null;
      let localAnswer = false;
      const enrichmentEvents = [];
      let finalizeTurnInBackground = false;

      function markFirstToken() {
        if (firstTokenRecorded) return;
        recordFirstToken(turn_id);
        // st_8c7b7a6b D5 — feed the in-process rolling estimator.
        // We use the route-side request start because the metrics row also
        // stamps its own request_start_ms; both align.
        try { recordTTFT(requestModel || model || modelFor('balanced'), Date.now() - _requestStartMs); } catch {}
        firstTokenRecorded = true;
        // st_fd14cdd4 — flush the post-status timing line (no-op when tracing is
        // disabled). The ctx.* marks fed by onTiming name the per-layer / phase
        // ms between the status frame and the first token.
        trace.flush('first_token', 'ctx-trace');
      }

      const hbEncoder = new TextEncoder();
      heartbeat = setInterval(() => {
        try { controller.enqueue(hbEncoder.encode(': heartbeat\n\n')); } catch {}
      }, HEARTBEAT_MS);

      // Whether tools are ACTUALLY active for this turn (st_fd14cdd4). Chat tools
      // are off for launch (owner-directed): the gate requires BOTH an explicit
      // body.useTools and ROBOTDOJO_ENABLE_CHAT_TOOLS=1. Computed ONCE here so the
      // status frame's toolCount and the chatOpts.useTools below cannot drift —
      // they are the same boolean. (The normal-path block re-reads `useTools`
      // from this const rather than recomputing the expression.)
      const useTools = body.useTools === true && process.env.ROBOTDOJO_ENABLE_CHAT_TOOLS === '1';
      const deterministicToolCount = rememberFact || viewerCorrection || relationshipCorrection ? 1 : 0;

      // Status event — always first frame.
      //
      // toolCount reports the ACTUAL number of tools active for THIS turn, not
      // the belt's POTENTIAL catalog. The old frame sent getToolCount(belt)
      // unconditionally — Black Belt advertised "53" even though zero tools ran,
      // which read as a regression ("tools reverted") when none had. Report the
      // belt catalog only when agentic tools are genuinely active. Explicit
      // "remember this" turns still report 1 because the route will run add_fact
      // deterministically and emit real tool frames.
      // hasRAG is filled after context assembly; first status is provisional.
      // Lying "true" here made the UI claim retrieval ran on empty fast turns.
      send({
        type: 'status',
        conversationId: convId,
        hasRAG: false,
        toolCount: useTools ? getToolCount(belt) : deterministicToolCount,
        belt,
      });
      sendFirstFramePadding();
      // st_2cd1af73 — the pre-first-frame gap ends HERE. Everything above this
      // mark is the synchronous request-entry term AC-1 targets.
      trace.mark('status_sent');
      trace.flush();
      await yieldFirstSseFrame();
      trace.mark('status_flushed');

      // st_2cd1af73 AC-1 (residual): NOW that the status frame has flushed, kick
      // off the two deferred DB writes that used to sit on the pre-first-token
      // path. Both run on the next macrotask (setImmediate inside the helpers),
      // so neither blocks the frame the client is already reading:
      //   - startChatTurnDeferred → INSERT the chat_turn_metrics row. record*
      //     helpers buffer until it lands; we await it before persist.
      //   - ensureConversationRow → deferred upsertConversation (+ its getLabels
      //     read). persistMessages awaits it so the conversation row exists.
      resolveContextSlugs();
      resolveModelMetadata();
      trace.mark('post_status_resolve');

      startChatTurnDeferred(turn_id, {
        conversation_id: convId,
        provider_name: requestProvider,
        request_model: requestModel || model || null,
        belt,
      });
      ensureConversationRow();

      // ── ?simulate=error short-circuit ──────────────────────────────────────
      // Documented test hook. Emits an error frame and closes. No model call,
      // no persist, no done. Observability records error_type='simulated_error'.
      if (simulateMode === 'error') {
        send({ type: 'phase', name: 'connected' });
        send({ type: 'error', message: 'simulated error (test hook)' });
        recordEgoBlock(turn_id, { present: false, chars: 0 }); // AC-7 convention: simulated turn, no prompt assembled
        recordError(turn_id, {
          error_type: 'simulated_error',
          error_message: 'simulated error (test hook)',
          recovery_path: 'none',
        });
        // Let the deferred INSERT land so the buffered recordError UPDATE flushes
        // (no lost turn), then release the per-turn buffers.
        await awaitTurnInsert(turn_id);
        completeTurn(turn_id);
        if (qaTestChat) scheduleQaTestConversationCleanup(convId);
        clearInterval(heartbeat);
        closeStream();
        return;
      }

      // ── ?simulate=stall short-circuit ──────────────────────────────────────
      // Documented test hook. Persists a canned assistant message to the DB
      // (mirrors the real path's persist step) and then HALTS the stream —
      // emits no `done` frame, doesn't close the controller via a `done`
      // event. The client treats a close-without-done as recoverable and
      // rehydrates the persisted message. Observability records
      // error_type='simulated_stall', recovery_path='db_rehydrate'.
      if (simulateMode === 'stall') {
        send({ type: 'phase', name: 'connected' });
        try {
          // Conversation row must exist before persist — await the deferred upsert.
          await ensureConversationRow();
          const cannedAssistant = '[stall-simulated response — rehydrated from DB]';
          await persistMessagesWithBusyRetry(db, { convId, userMessage: lastUserMsg, assistantContent: cannedAssistant, toolCalls: [] });
          send({ type: 'phase', name: 'persisted' });
          send({ type: 'conv_saved', ok: true, conversationId: convId });
        } catch {}
        recordEgoBlock(turn_id, { present: false, chars: 0 }); // AC-7 convention: simulated turn, no prompt assembled
        recordError(turn_id, {
          error_type: 'simulated_stall',
          error_message: 'simulated stall (test hook)',
          recovery_path: 'db_rehydrate',
        });
        await awaitTurnInsert(turn_id);
        completeTurn(turn_id);
        if (qaTestChat) scheduleQaTestConversationCleanup(convId, testChatCleanupDelayMs());
        clearInterval(heartbeat);
        // Close WITHOUT emitting `done` — the whole point of the stall sim.
        closeStream();
        return;
      }

      // ── ?simulate=degraded short-circuit ────────────────────────────────────
      // Documented test hook (st_b57e6ec5). Forces the connected phase's
      // provider-health payload to 'degraded' for THIS request only —
      // deliberately bypasses isProviderHealthEnabled() so an admin can QA
      // the wiring even while the flag stays off by default in production.
      // No chat_turn_metrics/warmup_events row is faked and the real
      // getProviderHealth() read below is skipped entirely, so no live data
      // is touched. Otherwise completes like a normal turn (persists,
      // streams a short canned reply, emits `done`) so the honest banner →
      // reply lifecycle can be watched end-to-end in the browser without
      // waiting for, or faking, a real Anthropic outage.
      if (simulateMode === 'degraded') {
        send({ type: 'phase', name: 'connected', degraded: true, label: PROVIDER_DEGRADED_MESSAGE });
        try {
          await ensureConversationRow();
          const cannedAssistant = '[degraded-simulated response — provider health forced for QA]';
          send({ type: 'phase', name: 'streaming' });
          markFirstToken();
          send({ type: 'delta', text: cannedAssistant });
          await persistMessagesWithBusyRetry(db, { convId, userMessage: lastUserMsg, assistantContent: cannedAssistant, toolCalls: [] });
          send({ type: 'phase', name: 'persisted' });
          send({ type: 'conv_saved', ok: true, conversationId: convId });
          send({ type: 'done', usage: { input_tokens: 0, output_tokens: 0 }, cost_cents: 0, tools_used: 0 });
        } catch {}
        recordEgoBlock(turn_id, { present: false, chars: 0 }); // AC-7 convention: simulated turn, no prompt assembled
        recordCompletion(turn_id, {
          usage: { input_tokens: 0, output_tokens: 0 },
          cost_cents: 0,
          tools_used: [],
          response_model: 'qa-simulated-degraded',
          provider_name: requestProvider || 'anthropic',
        });
        await awaitTurnInsert(turn_id);
        completeTurn(turn_id);
        if (qaTestChat) scheduleQaTestConversationCleanup(convId, testChatCleanupDelayMs());
        clearInterval(heartbeat);
        closeStream();
        return;
      }

      // ── Normal path ───────────────────────────────────────────────────────
      // Emit the first lifecycle phase — server is connected, request parsed.
      // st_b57e6ec5 — read-only provider-health check (two small indexed
      // SELECTs over chat_turn_metrics + warmup_events, error rows only —
      // never writes, never calls an LLM, never reads latency; see
      // lib/provider-health.js for why). Flag-gated OFF by default: only
      // compute + attach when isProviderHealthEnabled() is true, so a
      // default install never shows the banner. When enabled AND the
      // rolling window shows repeated overload/5xx errors, the connected
      // phase carries the honest note for the indicator to show for the
      // rest of this turn.
      const providerHealth = isProviderHealthEnabled()
        ? getProviderHealth(db, { provider: requestProvider || 'anthropic' })
        : null;
      const degradedMessage = providerHealth ? providerHealthMessage(providerHealth) : null;
      send({
        type: 'phase',
        name: 'connected',
        ...(degradedMessage ? { degraded: true, label: degradedMessage } : {}),
      });

      try {
        const topicSlugs = normalizeContextSlugs(topic);
        const ragSlugs = topicSlugs.length ? topicSlugs : contextSlugs;
        const ragTopic = ragSlugs.length > 1 ? ragSlugs : (ragSlugs[0] || null);
        // onPhase is threaded into streamChat so lib/chat.js can emit phase
        // events at meaningful lifecycle moments (assembling_context,
        // searching_memory, calling_tools, streaming). The SSE switch
        // forwards them with no transformation.
        //
        // conversation_id + user_id are threaded for st_74f45a1a R2 amendment:
        // topic-scoped RAG (cuts cold fan-out cost) + LRU-cached layered
        // context (warm turns skip the whole assembly).
        const user = c.get('user');
        // st_8c7b7a6b — default chat is tool-OFF. The layered context
        // (topic context_md + scoped RAG + entity-linked RAG) is in the
        // system prompt before Sonnet speaks; advertising `search_memory`
        // tempts the model into a 3–5s round-trip per call to re-verify
        // what's already injected. Opt-in surfaces still get tools:
        //   - `@feedback` sends scrubbed feedback to the Robot Dojo task queue
        //   - body.useTools=true is an explicit override for callers
        //     (admin tools, future agentic UIs)
        const miyagiInvoked = isAssistantMention(messages);
        if (recallFactQuery) {
          send({ type: 'phase', name: 'searching_memory', label: 'saved facts' });
          const recall = findSavedFactForRecall(recallFactQuery.query);
          if (recall?.ok) {
            fullContent = recall.fact;
            tokenCount = Math.ceil(fullContent.length / 4);
            recordMemoryContext(turn_id, {
              present: true,
              cache_hit: false,
              timeout: false,
              tier: 'local_user_fact_recall',
              chars: fullContent.length,
              sections: ['saved_fact'],
              source_types: ['user-fact'],
              target_types: [],
              event_types: [],
            });

            send({ type: 'phase', name: 'streaming' });
            markFirstToken();
            send({ type: 'delta', text: fullContent });

            await ensureConversationRow();
            await persistMessagesWithBusyRetry(db, { convId, userMessage: lastUserMsg, assistantContent: fullContent, toolCalls });
            send({ type: 'phase', name: 'persisted' });
            send({ type: 'conv_saved', ok: true, conversationId: convId });
            if (!qaTestChat) writeConversationFile(convId).catch(() => {});

            const inputTokens = messages.reduce((sum, m) => sum + Math.ceil((m.content || '').length / 4), 0);
            const usage = { input_tokens: inputTokens, output_tokens: tokenCount };
            send({
              type: 'done',
              usage,
              cost_cents: 0,
              tools_used: 0,
            });
            // st_df0a8d71 AC-7 — every recorded turn carries a non-null
            // ego_block_present. CONVENTION for local deterministic turns:
            //   1 → graph truth was literally served (graph-answer /
            //       graph-correction; chars = served text length)
            //   0 → the path never consults who-is-who (recall, fact-store,
            //       viewer-correction, entity-card). Recording 0 here is a
            //       classification, NOT an absence failure — the loud warn
            //       stays exclusive to model turns whose assembled prompt
            //       should have carried the block and didn't.
            recordEgoBlock(turn_id, { present: false, chars: 0 });
            recordCompletion(turn_id, {
              usage,
              cost_cents: 0,
              tools_used: [],
              response_model: 'local-memory-recall',
              provider_name: 'local',
            });
            return;
          }
        }

        if (rememberFact) {
          const args = { fact: rememberFact };
          if (topicSlug) args.topic_slug = topicSlug;

          send({ type: 'phase', name: 'calling_tools', count: 1, label: 'add_fact' });
          toolCalls.push({ name: 'add_fact', args });
          send({ type: 'tool_start', name: 'add_fact', args });
          const result = await executeTool('add_fact', args, { belt, sessionId });
          send({ type: 'tool_done', name: 'add_fact', result: publicToolResult(result) });

          const factText = result?.fact || rememberFact;
          fullContent = result?.ok
            ? `Stored: ${JSON.stringify(factText)}${result.searchable ? '' : '\n\nSemantic search is degraded right now; this will catch up when local embeddings are available.'}`
            : `I could not store that: ${result?.error || 'memory write failed'}`;
          tokenCount = Math.ceil(fullContent.length / 4);

          send({ type: 'phase', name: 'streaming' });
          markFirstToken();
          send({ type: 'delta', text: fullContent });

          await ensureConversationRow();
          await persistMessagesWithBusyRetry(db, { convId, userMessage: lastUserMsg, assistantContent: fullContent, toolCalls });
          send({ type: 'phase', name: 'persisted' });
          send({ type: 'conv_saved', ok: true, conversationId: convId });
          if (!qaTestChat) writeConversationFile(convId).catch(() => {});

          const inputTokens = messages.reduce((sum, m) => sum + Math.ceil((m.content || '').length / 4), 0);
          const usage = { input_tokens: inputTokens, output_tokens: tokenCount };
          send({
            type: 'done',
            usage,
            cost_cents: 0,
            tools_used: toolCalls.length,
          });
          recordEgoBlock(turn_id, { present: false, chars: 0 }); // AC-7 convention: path never consults who-is-who
          recordCompletion(turn_id, {
            usage,
            cost_cents: 0,
            tools_used: toolCalls.map(t => t.name),
            response_model: 'local-memory-write',
            provider_name: 'local',
          });
          return;
        }

        // st_df0a8d71 D4 — deterministic graph correction branch. Placed with
        // the other deterministic branches (after rememberFact) and streams a
        // confirmation the way add_fact does. The write (setRelationTag /
        // setEmployerFact) is code-validated and supersede-archived; an
        // ambiguous or unknown name replies asking for the full name and
        // writes NOTHING. Effective next turn via the graph-change event.
        if (relationshipCorrection) {
          const toolName = relationshipCorrection.kind === 'employer' ? 'set_employer' : 'set_relation_tag';
          const args = { ...relationshipCorrection };

          send({ type: 'phase', name: 'calling_tools', count: 1, label: toolName });
          toolCalls.push({ name: toolName, args });
          send({ type: 'tool_start', name: toolName, args });
          const result = executeRelationshipCorrection(db, relationshipCorrection);
          send({ type: 'tool_done', name: toolName, result: publicToolResult({
            ok: result.ok,
            wrote: result.wrote,
            person: result.person || null,
          }) });

          fullContent = result.message;
          tokenCount = Math.ceil(fullContent.length / 4);

          send({ type: 'phase', name: 'streaming' });
          markFirstToken();
          send({ type: 'delta', text: fullContent });

          await ensureConversationRow();
          await persistMessagesWithBusyRetry(db, { convId, userMessage: lastUserMsg, assistantContent: fullContent, toolCalls });
          send({ type: 'phase', name: 'persisted' });
          send({ type: 'conv_saved', ok: true, conversationId: convId });
          if (!qaTestChat) writeConversationFile(convId).catch(() => {});

          const inputTokens = messages.reduce((sum, m) => sum + Math.ceil((m.content || '').length / 4), 0);
          const usage = { input_tokens: inputTokens, output_tokens: tokenCount };
          send({
            type: 'done',
            usage,
            cost_cents: 0,
            tools_used: toolCalls.length,
          });
          // AC-7 convention: graph truth was literally served (the write +
          // confirmation ARE who-is-who truth); chars = served text length.
          recordEgoBlock(turn_id, { present: true, chars: fullContent.length });
          recordCompletion(turn_id, {
            usage,
            cost_cents: 0,
            tools_used: toolCalls.map(t => t.name),
            response_model: 'local-graph-correction',
            provider_name: 'local',
          });
          return;
        }

        if (viewerCorrection) {
          const correctionText = viewerCorrectionTextFromMessage(lastUserMsg?.content);
          let result = null;
          const args = {
            target_type: viewerCorrection.target_type,
            target_id: viewerCorrection.target_id,
            section: viewerCorrection.section,
          };
          if (correctionText) {
            send({ type: 'phase', name: 'calling_tools', count: 1, label: 'record_viewer_correction' });
            toolCalls.push({ name: 'record_viewer_correction', args });
            send({ type: 'tool_start', name: 'record_viewer_correction', args });
            result = recordViewerCorrection(db, {
              ...viewerCorrection,
              correction_text: correctionText,
            }, { actor: 'user' });
            send({ type: 'tool_done', name: 'record_viewer_correction', result: publicToolResult({
              ok: true,
              inserted: result.inserted,
              eventId: result.eventId,
            }) });
            fullContent = result.inserted
              ? `Recorded correction for ${viewerCorrection.target_title || viewerCorrection.target_url || viewerCorrection.target_id}. It will constrain the next summary and timeline regeneration.`
              : `That correction was already recorded for ${viewerCorrection.target_title || viewerCorrection.target_url || viewerCorrection.target_id}.`;
          } else {
            fullContent = 'Write the correction text first, then send it. I did not record the placeholder.';
          }
          tokenCount = Math.ceil(fullContent.length / 4);

          send({ type: 'phase', name: 'streaming' });
          markFirstToken();
          send({ type: 'delta', text: fullContent });

          await ensureConversationRow();
          await persistMessagesWithBusyRetry(db, { convId, userMessage: lastUserMsg, assistantContent: fullContent, toolCalls });
          send({ type: 'phase', name: 'persisted' });
          send({ type: 'conv_saved', ok: true, conversationId: convId });
          if (!qaTestChat) writeConversationFile(convId).catch(() => {});

          const inputTokens = messages.reduce((sum, m) => sum + Math.ceil((m.content || '').length / 4), 0);
          const usage = { input_tokens: inputTokens, output_tokens: tokenCount };
          send({
            type: 'done',
            usage,
            cost_cents: 0,
            tools_used: toolCalls.length,
          });
          recordEgoBlock(turn_id, { present: false, chars: 0 }); // AC-7 convention: path never consults who-is-who
          recordCompletion(turn_id, {
            usage,
            cost_cents: 0,
            tools_used: toolCalls.map(t => t.name),
            response_model: 'local-viewer-correction',
            provider_name: 'local',
          });
          return;
        }

        // st_df0a8d71 QA fix — graph-first relationship answers. Runs BEFORE
        // the direct-entity card path by construction; a parsed relation
        // question ALWAYS gets a deterministic graph answer (rows or the
        // canonical abstention) and never a card. Thin facade: one lib call.
        if (relationshipQuestion) {
          const graphAnswer = answerRelationshipQuestion(db, relationshipQuestion);
          // matched:'flow' = a forward per-person question about someone with
          // NO graph relationship — fall through to the card/model paths.
          if (graphAnswer.matched !== 'flow') {
          fullContent = graphAnswer.text;
          tokenCount = Math.ceil(fullContent.length / 4);

          send({ type: 'phase', name: 'streaming' });
          markFirstToken();
          send({ type: 'delta', text: fullContent });

          await ensureConversationRow();
          await persistMessagesWithBusyRetry(db, { convId, userMessage: lastUserMsg, assistantContent: fullContent, toolCalls });
          send({ type: 'phase', name: 'persisted' });
          send({ type: 'conv_saved', ok: true, conversationId: convId });
          if (!qaTestChat) writeConversationFile(convId).catch(() => {});

          const inputTokens = messages.reduce((sum, m) => sum + Math.ceil((m.content || '').length / 4), 0);
          const usage = { input_tokens: inputTokens, output_tokens: tokenCount };
          send({
            type: 'done',
            usage,
            cost_cents: 0,
            tools_used: 0,
          });
          // AC-7 convention: graph truth was literally served as the answer;
          // chars = served text length.
          recordEgoBlock(turn_id, { present: true, chars: fullContent.length });
          recordCompletion(turn_id, {
            usage,
            cost_cents: 0,
            tools_used: [],
            response_model: 'local-graph-answer',
            provider_name: 'local',
          });
          return;
          }
        }

        const directLocalAnswer = await buildDirectEntityAnswerSmart(lastUserMsg?.content, {
          belt,
          onTiming: ENTRY_TRACE_ENABLED
            ? ({ phase, ms }) => { try { trace.mark(`ctx.${phase}=${Math.round(ms)}`); } catch {} }
            : null,
        }).catch((err) => {
          console.warn('[chat] direct local entity answer failed:', err?.message || err);
          return null;
        });
        if (directLocalAnswer?.text) {
          localAnswer = true;
          providerResponseModel = 'local-entity-card';
          fullContent = directLocalAnswer.text;
          tokenCount = Math.ceil(fullContent.length / 4);
          const usage = { input_tokens: 0, output_tokens: tokenCount };

          if (directLocalAnswer.entity) {
            send({ type: 'entity_recognized', entities: [directLocalAnswer.entity] });
          }
          send({ type: 'phase', name: 'streaming' });
          markFirstToken();
          for (const text of chunkDirectLocalAnswer(fullContent)) {
            send({ type: 'delta', text });
          }
          send({
            type: 'done',
            usage,
            cost_cents: 0,
            tools_used: 0,
          });

          recordEgoBlock(turn_id, { present: false, chars: 0 }); // AC-7 convention: entity-card path never consults the who-is-who block
          recordCompletion(turn_id, {
            usage,
            cost_cents: 0,
            tools_used: [],
            response_model: providerResponseModel,
            provider_name: 'local',
          });

          finalizeTurnInBackground = true;
          void enqueueConversationPersist(convId, async () => {
            try {
              await awaitTurnInsert(turn_id);
              await ensureConversationRow();
              await persistMessagesWithBusyRetry(db, {
                convId,
                userMessage: lastUserMsg,
                assistantContent: fullContent,
                toolCalls,
              }, {
                retryMs: DIRECT_LOCAL_PERSIST_RETRY_MS,
                label: 'chat:persistDirectLocalEntity',
              });
              if (!qaTestChat) writeConversationFile(convId).catch(() => {});
              recordProviderRuntimeHealth('ok');
            } catch (err) {
              console.warn('[chat] direct local entity background persist failed:', err?.message || err);
              recordProviderRuntimeHealth('error', err?.message || String(err));
              recordError(turn_id, {
                error_type: 'persist_error',
                error_message: err?.message || String(err),
                recovery_path: 'local_answer_already_streamed',
              });
            } finally {
              recordEnrichmentHealth(turn_id, enrichmentEvents);
              completeTurn(turn_id);
              if (qaTestChat) scheduleQaTestConversationCleanup(convId, testChatCleanupDelayMs());
            }
          });
          return;
        }

        // Chat app tools disabled for launch (owner-directed 2026-06-09): the
        // agentic tools — especially web search — caused slow / hung turns; the
        // hero is grounded chat on the user's OWN data, not web tools. Off by
        // default; re-enable explicitly via ROBOTDOJO_ENABLE_CHAT_TOOLS=1.
        // `useTools` is the single gate computed at stream entry (above the status
        // frame) so the reported toolCount and this option can never disagree.
        let sessionUserTurn = 1;
        try {
          const session = await beginTopicChatSession(db, { convId, topicSlug: topicSlug || ragTopic });
          sessionUserTurn = session.sessionUserTurn || 1;
        } catch (err) {
          console.warn('[chat] topic session begin failed:', err?.message || err);
        }
        const chatOpts = {
          topic: ragTopic,
          model,
          belt,
          useTools,
          sessionId,
          conversation_id: convId,
          user_id: user?.id || null,
          mode: requestedMode,
          sessionUserTurn,
          onPhase: (name, payload) => {
            // Phase events may carry a payload ({count, label, ...}) so the
            // indicator can render real numbers. Forward verbatim.
            const frame = { type: 'phase', name };
            if (payload && typeof payload === 'object') Object.assign(frame, payload);
            send(frame);
          },
          // st_fd14cdd4 — diagnostic per-layer/per-phase timing. Only attached
          // when the env-gated entry tracer is live (ENTRY_TRACE_ENABLED), so it
          // is allocation-free and behavior-identical in production. Each
          // ({phase, ms}) emission appends a mark to the request's entry trace;
          // trace.flush() below writes one grep-able stderr line per turn that
          // names where the warm-turn seconds went, attributed by measurement.
          onTiming: ENTRY_TRACE_ENABLED
            ? ({ phase, ms }) => { try { trace.mark(`ctx.${phase}=${Math.round(ms)}`); } catch {} }
            : null,
          onContextTrace: (summary) => recordMemoryContext(turn_id, summary),
          onEnrichment: (event) => {
            if (!event || typeof event !== 'object') return;
            enrichmentEvents.push(event);
            // st_df0a8d71 AC-7 — persist who-is-who presence per turn and flag
            // absence loudly. lib/chat.js emits exactly one ego_block event per
            // assembled prompt; delegation only here (thin facade).
            if (event.layer === 'ego_block') {
              recordEgoBlock(turn_id, { present: event.status === 'ok', chars: event.chars || 0 });
              if (event.status !== 'ok') {
                console.warn(`[chat] turn ${turn_id}: who-is-who block ABSENT from system prompt`);
              }
            }
          },
          onMetric: {
            // first token recorded at SSE delta below — keep the SSE-side
            // hook so we can record even when the underlying provider
            // doesn't surface a first-token signal explicitly.
            firstToken: () => {},
            completion: ({ usage, response_model, provider_name }) => {
              if (usage) providerUsage = usage;
              if (response_model) providerResponseModel = response_model;
              if (provider_name) providerResponseProvider = provider_name;
            },
          },
        };
        if (injectedContext) chatOpts.injectedContext = injectedContext;
        if (files?.length) chatOpts.files = files;
        if (enrichmentFaults.length) chatOpts.enrichmentFaults = enrichmentFaults;
        if (simulateGateOn && body.useRouter === true) chatOpts.useRouter = true;
        chatOpts.writingFreeze = body.writingFreeze === false ? false : true;

        const eventStream = isFounderFeedbackMention(messages)
            ? streamFounderFeedbackMention(messages, { conversationId: convId, user })
            : miyagiInvoked
              ? streamAssistantMention(messages)
              : streamChat(messages, chatOpts);

        for await (const event of eventStream) {
          switch (event.type) {
            case 'delta':
              markFirstToken();
              fullContent += event.text;
              tokenCount += Math.ceil(event.text.length / 4);
              send({ type: 'delta', text: event.text });
              break;

            case 'prelude':
              send({ type: 'phase', name: 'thinking', label: event.text || 'Working on it...' });
              send({ type: 'prelude', text: event.text || 'Working on it...' });
              break;

            case 'thinking':
              // Fix for the drop bug surfaced by Tantei §B — the SSE switch
              // previously had no `case 'thinking':` arm and silently dropped
              // the event. Forward as a phase-shaped event with a sanitized
              // label. Long/empty content collapses to generic "Thinking…".
              {
                const raw = typeof event.text === 'string' ? event.text.trim() : '';
                const label = (!raw || raw.length > 80) ? 'Thinking…' : raw;
                send({ type: 'phase', name: 'thinking', label });
              }
              break;

            case 'tool_start':
              toolCalls.push({ name: event.name, args: event.args });
              send({ type: 'tool_start', name: event.name, args: event.args });
              break;

            case 'tool_done': {
              const result = event.result || {};
              // Scrub private fields before echoing to the client — tools
              // can attach `_onResolved` / `_awaitResolution` which must
              // never leave the server.
              send({ type: 'tool_done', name: event.name, result: publicToolResult(result) });

              // Legacy action envelopes the chat UI already understands.
              if (result.action === 'secure_input') {
                send({
                  type: 'secure_input',
                  requestId: result.requestId || null,
                  service: result.service || result.provider || null,
                  label: result.label
                    || (result.provider ? `Enter your ${result.provider} API key` : 'Enter credential'),
                  expiresAt: result.expiresAt || null,
                  auth_url: result.auth_url || null,
                });
              } else if (result.action === 'oauth_redirect') {
                send({
                  type: 'oauth_redirect',
                  provider: result.provider,
                  auth_url: result.auth_url,
                });
              }
              break;
            }

            case 'entity_recognized':
              // st_f1a40461 AC9 — inline entity recognition. Forward the
              // recognized-entity set verbatim so the chat client can surface
              // contacts named in earlier turns as chips/highlights without an
              // @-mention. Without this explicit arm the frame would be
              // silently dropped (the switch has no default).
              send(event);
              break;

            case 'local_answer':
              // Direct local entity-card answer: no provider tokens are reported,
              // but response_model should show the path that actually answered.
              localAnswer = true;
              if (event.model) providerResponseModel = event.model;
              break;

            case 'writing_freeze':
              send(event);
              break;

            case 'error':
              send({ type: 'error', error: event.error || 'incomplete', text: event.text || 'Writing did not complete.' });
              break;
          }
        }

        // st_2cd1af73 AC-1 (residual): the conversation row was deferred off the
        // pre-first-token path. It must exist before we persist messages, so
        // await the deferred upsert here (it has almost certainly already landed
        // by the time the model finished streaming — this await is a guard, not a
        // stall). persistMessages then finds/creates the row exactly as before.
        await ensureConversationRow();
        // Persist messages via lib — route has no db.prepare calls
        await persistMessagesWithBusyRetry(db, { convId, userMessage: lastUserMsg, assistantContent: fullContent, toolCalls });
        // Phase event for the indicator — server says "I saved your message."
        send({ type: 'phase', name: 'persisted' });

        send({ type: 'conv_saved', ok: true, conversationId: convId });

        // Fire-and-forget: write conversation flat file without blocking the SSE stream.
        // Failure is acceptable — backfill-conversations.js recovers any missed sessions.
        if (!qaTestChat) writeConversationFile(convId).catch(() => {});

        // Cost estimation via lib/compute-tier.js — no inline pricing table
        const inputTokens = messages.reduce((sum, m) => sum + Math.ceil((m.content || '').length / 4), 0);
        const costCents = localAnswer ? 0 : estimateCostCents(requestModel || model, inputTokens, tokenCount);

        send({
          type: 'done',
          usage: { input_tokens: inputTokens, output_tokens: tokenCount },
          cost_cents: costCents,
          tools_used: toolCalls.length,
        });

        // Observability — record completion. Prefer provider-reported usage
        // (carries actual input_tokens + cache_creation/cache_read counts)
        // over the route-side estimate; fall back to estimate when the
        // provider didn't surface a usage object (e.g. ollama).
        const persistUsage = providerUsage
          ? {
              input_tokens: providerUsage.input_tokens ?? inputTokens,
              output_tokens: providerUsage.output_tokens ?? tokenCount,
              cache_creation_input_tokens: providerUsage.cache_creation_input_tokens ?? null,
              cache_read_input_tokens: providerUsage.cache_read_input_tokens ?? null,
            }
          : { input_tokens: inputTokens, output_tokens: tokenCount };
        if (localAnswer) {
          persistUsage.input_tokens = 0;
        }
        recordCompletion(turn_id, {
          usage: persistUsage,
          cost_cents: costCents,
          tools_used: toolCalls.map(t => t.name),
          response_model: providerResponseModel || null,
          provider_name: localAnswer ? 'local' : (providerResponseProvider || null),
        });
        recordProviderRuntimeHealth('ok');
      } catch (err) {
        console.error('[chat] stream error:', err.message);
        send({ type: 'error', message: err.message });
        recordProviderRuntimeHealth('error', err.message);
        recordError(turn_id, {
          error_type: 'llm_error',
          error_message: err.message,
          recovery_path: 'none',
        });
      } finally {
        if (finalizeTurnInBackground) {
          clearInterval(heartbeat);
          closeStream();
          return;
        }
        recordEnrichmentHealth(turn_id, enrichmentEvents);
        // st_2cd1af73 AC-1 (residual): ensure the deferred INSERT has landed so
        // the buffered recordCompletion/recordError UPDATE flushes (no lost turn,
        // metrics attach), then release the per-turn buffers. Runs for BOTH the
        // success and error exits. Off the client's critical path — the stream
        // already delivered every token.
        await awaitTurnInsert(turn_id);
        completeTurn(turn_id);
        if (qaTestChat) scheduleQaTestConversationCleanup(convId);
        clearInterval(heartbeat);
        closeStream();
      }
      })().catch((err) => {
        console.error('[chat] stream start error:', err?.message || err);
        try {
          const send = makeSender(controller);
          send({ type: 'error', message: err?.message || String(err) });
        } catch {}
        if (heartbeat) clearInterval(heartbeat);
        closeStream();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// Non-streaming
routes.post('/api/chat/sync', async (c) => {
  const { chat } = await import('../lib/chat.js');
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const { messages, topic, model } = body;
  if (!messages || !Array.isArray(messages)) return c.json({ error: 'messages_required' }, 400);
  const belt = c.get('belt') || 'white';
  const user = c.get('user');
  const enrichmentFaults = parseQaEnrichmentFaults(c, body, qaSimulationAllowed(c));
  const miyagiInvoked = isAssistantMention(messages);
  const syncMessages = miyagiInvoked ? stripAssistantMentionFromMessages(messages) : messages;
  const requestProvider = providerNameForChatModel(model);
  let result;
  try {
    result = await chat(syncMessages, {
      topic,
      model,
      belt,
      useTools: body.useTools === true,
      conversation_id: body.conversation_id || body.conversationId || null,
      user_id: user?.id || null,
      enrichmentFaults,
    });
    recordIntegrationJobHealth(db, requestProvider, 'ok');
  } catch (err) {
    recordIntegrationJobHealth(db, requestProvider, 'error', { error: err.message });
    const { APIConnectionTimeoutError } = await import('@anthropic-ai/sdk');
    if (err instanceof APIConnectionTimeoutError) {
      return c.json({ error: 'timeout', message: 'LLM call timed out — try again' }, 504);
    }
    return c.json({ error: 'internal', message: err.message }, 500);
  }
  return c.json(result);
});

// --- TTFT estimator (st_8c7b7a6b D5) ---
// Rolling average of the last N TTFT measurements per model. Frontend
// reads on input focus to render "~2.3s expected" in the loading indicator.
//
// Auth pattern: requireAuth from lib/middleware-auth.js — accepts EITHER
// the session cookie OR the static Bearer token. We attach the guard at
// the route level (not just via lib/server.js global middleware) so the
// behavioral spec in tests/specs/st_8c7b7a6b.test.js — which mounts this
// router directly on a bare Hono — gets the 401 on missing auth.
routes.get('/api/chat/ttft-estimate', requireSessionOrBearer(), (c) => {
  const model = c.req.query('model') || modelFor('balanced');
  const envelope = estimateTTFT(model);
  return c.json(envelope);
});

// --- Speculative prefetch (st_8c7b7a6b D2) ---
// Fire-and-forget cache warmer. Frontend calls on debounced input so by the
// time the user hits submit the cheap topic-scoped retrieval path has touched
// the DB/FTS cache. Returns 200 in all valid auth cases — `{ok:false}` for
// short queries, missing topic, or RAG errors is informational, not an error.
//
// Product rule: typing must never load the 2GB local ONNX embedding model into
// the interactive server. Semantic/vector prefetch is therefore explicit
// operator opt-in only (`ROBOTDOJO_PREFETCH_VECTOR=1`). The default path is
// lexical FTS so Accounts/Login/Chat stay responsive while bulk embeddings are
// owned by install prewarm, actual chat retrieval, or the idle-gated worker.
routes.post('/api/prefetch', requireSessionOrBearer(), async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const { query, context } = body || {};
  if (typeof query !== 'string' || query.length < 10) {
    return c.json({ ok: false });
  }
  // Launch guard: no topic = no RAG. The chat path follows this rule; prefetch
  // must not secretly fan out across every topic while the user is merely
  // typing in a general chat. Topic strings/arrays are allowed; `general`
  // warms only the general shard if present.
  const topicFilter = Array.isArray(context)
    ? context.filter(t => typeof t === 'string' && t.length > 0)
    : (typeof context === 'string' && context.length > 0 ? [context] : []);
  if (topicFilter.length === 0) {
    return c.json({ ok: false, reason: 'topic_required' });
  }
  try {
    if (process.env.ROBOTDOJO_PREFETCH_VECTOR === '1') {
      const { searchMultiQuery } = await import('../lib/rag-search.js');
      const results = await searchMultiQuery([query], { limit: 10, topicFilter });
      return c.json({ ok: true, cached: Array.isArray(results) ? results.length : 0, mode: 'vector' });
    }

    const { searchFTS } = await import('../lib/rag-search.js');
    const seen = new Set();
    const perTopicLimit = Math.max(1, Math.ceil(10 / topicFilter.length));
    for (const topic of topicFilter) {
      const results = searchFTS(query, { topic, limit: perTopicLimit });
      for (const row of results) {
        if (row?.id != null) seen.add(row.id);
      }
    }
    return c.json({ ok: true, cached: seen.size, mode: 'fts' });
  } catch (err) {
    console.warn('[chat] RAG pre-warm failed:', err.message);
    return c.json({ ok: false });
  }
});

// --- Inline entity recognition while typing ---
// Bounded, lexical DB lookup only. This deliberately reuses detectQueryEntities
// and never touches vectors, embeddings, or model calls, so typing can feel
// alive without competing with chat generation or background embedding.
const INLINE_ENTITY_SCAN_CHAR_LIMIT = 8000;
const INLINE_ENTITY_SCAN_SEPARATOR = '\n...\n';

function inlineEntityScanText(raw) {
  const text = String(raw || '');
  if (text.length <= INLINE_ENTITY_SCAN_CHAR_LIMIT) return text;
  const budget = INLINE_ENTITY_SCAN_CHAR_LIMIT - INLINE_ENTITY_SCAN_SEPARATOR.length;
  const head = Math.max(1, Math.floor(budget / 2));
  const tail = Math.max(1, budget - head);
  return `${text.slice(0, head)}${INLINE_ENTITY_SCAN_SEPARATOR}${text.slice(-tail)}`;
}

routes.post('/api/chat/inline-entities', requireSessionOrBearer(), async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const belt = c.get('belt') || 'white';
  const raw = typeof body?.text === 'string' ? body.text : '';
  const text = inlineEntityScanText(raw);
  if (belt !== 'black' || text.trim().length < 3) {
    return c.json({ ok: true, entities: [] });
  }
  try {
    const entities = await detectQueryEntities(text);
    return c.json({
      ok: true,
      entities: entities.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        n2: e.n2 || null,
        score: e.score || 0,
        matched_name: e.matched_name || null,
      })),
    });
  } catch (err) {
    console.warn('[chat] inline entity lookup failed:', err.message);
    return c.json({ ok: true, entities: [] });
  }
});

// --- Chat-app-active ping (st_fd14cdd4 AC9) ---
// The chat app POSTs here on load, on focus / visibility→visible, and on a
// heartbeat while it stays open. The ONLY work is stamping the chat-app-active
// recency signal so the chunk-embed daemon drops its in-flight chunk and stays
// paused while the app is open — freeing the SQLCipher writer BEFORE the user
// finishes typing (distinct from the per-turn signal stamped at submit). No body
// is required and none is read; the stamp is the entire effect. Behind normal
// cookie-or-Bearer auth (no PUBLIC_ROUTES entry) — only an authenticated chat app
// can quiet the embedder. Thin facade: one lib call, no DB SQL in the route.
routes.post('/api/chat/active', requireSessionOrBearer(), (c) => {
  recordChatAppActive(db);
  return c.json({ ok: true });
});

routes.post('/api/chat/session-close', requireSessionOrBearer(), async (c) => {
  let body = {};
  try {
    const text = await c.req.text();
    body = text ? JSON.parse(text) : {};
  } catch { body = {}; }
  const topic = String(body?.topic || body?.topicSlug || '').trim();
  const conversationId = String(body?.conversationId || body?.conversation_id || '').trim();
  if (!topic && !conversationId) return c.json({ error: 'topic_or_conversation_required' }, 400);
  try {
    const convId = conversationId || (topic
      ? db.prepare(`SELECT id FROM conversations WHERE topic_slug = ? AND is_live = 1 AND deleted_at IS NULL LIMIT 1`).get(topic)?.id
      : null);
    if (!convId) return c.json({ ok: true, skipped: true, reason: 'no_live' });
    const closeReason = String(body?.reason || 'leave-topic').trim() || 'leave-topic';
    const result = await closeTopicChatSession(db, { convId, topicSlug: topic, reason: closeReason });
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.warn('[chat] session-close failed:', err?.message || err);
    return c.json({ ok: false, error: 'session_close_failed' }, 500);
  }
});

// --- Setup-context load failure log (st_96bb626f AC 11) ---
// The chat app fire-and-forgets here when a URL-driven setup context file
// (/static/faq/<context>.json) fails to load — missing, HTTP error, network
// error, or corrupt/hash-mismatched JSON. The chat still inits normally on the
// client (working greeting, input active); this route only records WHY the
// context didn't load, so a broken setup guide is diagnosable from the server
// log instead of failing silently. Behind normal cookie-or-Bearer auth (no
// PUBLIC_ROUTES entry). Thin facade: parse + log, no DB, no business logic.
routes.post('/api/chat/context-failure', requireSessionOrBearer(), async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 120) : 'unknown';
  const detail = typeof body?.detail === 'string' ? body.detail.slice(0, 300) : '';
  console.warn(`[chat] setup-context load failed: reason=${reason}${detail ? ` detail=${detail}` : ''}`);
  return c.json({ ok: true }, 202);
});

// --- Message threads ---
// NOTE: POST /api/accounts/keys was removed from this file (2026-05-05).
// The route used execSync with shell string interpolation — a shell injection vector.
// The secure replacement lives in routes/accounts.js and uses spawnSync with argv array.

routes.get('/api/conversations/:id/threads/:seq', (c) => {
  const convId = c.req.param('id');
  const parentSeq = parseInt(c.req.param('seq'));
  if (isNaN(parentSeq)) return c.json({ error: 'invalid_seq' }, 400);

  const conv = getConversation(db, convId);
  if (!conv) return c.json({ error: 'not_found' }, 404);

  const threads = getThreads(db, convId, parentSeq);
  return c.json({ threads });
});

routes.post('/api/conversations/:id/threads/:seq', async (c) => {
  const convId = c.req.param('id');
  const parentSeq = parseInt(c.req.param('seq'));
  if (isNaN(parentSeq)) return c.json({ error: 'invalid_seq' }, 400);

  const conv = getConversation(db, convId);
  if (!conv) return c.json({ error: 'not_found' }, 404);

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const content = body?.content?.trim();
  if (!content) return c.json({ error: 'content_required' }, 400);

  const belt = c.get('belt') || 'white';

  // Build thread context and persist user message in one lib call
  const { threadSeq, contextMessages } = getThreadContext(db, convId, parentSeq, content);

  const stream = new ReadableStream({
    async start(controller) {
      const send = makeSender(controller);
      let assistantContent = '';

      try {
        for await (const event of streamChat(contextMessages, { belt, useTools: false })) {
          if (event.type === 'delta') {
            assistantContent += event.text;
            send({ type: 'delta', text: event.text });
          }
        }

        // Persist assistant reply
        appendThreadMessage(db, { convId, parentSeq, seq: threadSeq + 1, role: 'assistant', content: assistantContent });

        send({ type: 'done', threadSeq });
      } catch (err) {
        console.error('[threads] stream error:', err.message);
        send({ type: 'error', message: err.message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

routes.delete('/api/conversations/:id/threads/:seq/:threadId', (c) => {
  const convId = c.req.param('id');
  const parentSeq = parseInt(c.req.param('seq'));
  const threadId = parseInt(c.req.param('threadId'));

  if (isNaN(parentSeq) || isNaN(threadId)) return c.json({ error: 'invalid_params' }, 400);

  const conv = getConversation(db, convId);
  if (!conv) return c.json({ error: 'not_found' }, 404);

  deleteThreadMessage(db, { convId, parentSeq, threadId });
  return c.json({ ok: true });
});

// --- Conversation compression ---

routes.post('/api/conversations/:id/compress', async (c) => {
  const convId = c.req.param('id');

  // st_74f45a1a R2 — compression now resolves its provider internally via
  // lib/llm/index.js. No SDK client passed from the route.
  const result = await compressConversation(db, convId);

  if (!result) return c.json({ error: 'not_found' }, 404);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 500);
  return c.json({ ok: true, summary: result.summary, keptMessages: result.keptMessages });
});

// Public (unauthenticated) FAQ / install chat lives in routes/public-chat.js.
export default routes;
