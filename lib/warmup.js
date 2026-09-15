/**
 * Boot warmup — fires three no-op calls in parallel so the first real chat
 * turn does not pay cold-start tax.
 *
 * st_74f45a1a R2 → st_566ad80b. Round-2 research traced cold TTFB to three
 * independent cold paths:
 *   1. The local embedding model readiness check
 *   2. The sqlite-vec topic-table fan-out (page-cache miss)  — REPLACED
 *      by HNSW hot-tier preload in st_566ad80b
 *   3. The Anthropic SDK (first connection setup + cipher handshake)
 *
 * st_566ad80b additions:
 *   - loadAllHotIndices(db) — preloads usearch HNSW indices into RAM
 *     during boot warmup, so the first query doesn't pay page-fault tax.
 *   - warmProvider(provider) — fires a 1-token call against any provider
 *     so a model-change settings tap doesn't pay the cold-handshake tax.
 *   - appEvents.on('model-change') — subscribes to settings changes so
 *     switching the user's default chat model triggers a warmup within
 *     100 ms (AC 10).
 *   - logWarmupEvent — writes each warmup attempt to warmup_events
 *     for observability and AC 10 verification.
 *
 * Warmup is FIRE-AND-FORGET — never blocks `app.listen`. The completion
 * state is exposed via getWarmupState() so `/api/server-health` can
 * report `warmup_complete: true` once all warmup calls have settled.
 *
 * The interactive server must not load the 2GB local ONNX embedding model at
 * boot. That model is owned by install prewarm, chat-on-demand retrieval, and
 * the idle-gated chunk worker. Loading it here can make the Accounts/Login
 * surface look alive to launchd while burning CPU in the main process.
 */

import { appEvents } from './app-events.js';

const state = {
  started_at: null,
  completed_at: null,
  embed_done: false,
  retrieve_done: false,
  anthropic_done: false,
  ann_done: false,
  ann_global: null,
  ann_ready: false,
  // ANN global-index load observability (st_2cd1af73 AC-1): proves the index
  // is loaded once at boot, never per chat turn. ann_load_ms is the boot
  // load latency; ann_chunks is the embedded-chunk count the index spans.
  ann_load_ms: null,
  ann_chunks: null,
  // Layered-context boot prewarm observability (st_2cd1af73 AC-1 final). One
  // real ambient (no-topic) layered build runs at boot so the first real chat
  // turn lands on a warm OS page cache + identity cache + embed socket instead
  // of the 13–25 s cold-page path. boot_context_warm_ms is that build's wall
  // time; proves the prewarm ran and shows what the user's first turn avoided.
  context_warm_done: false,
  boot_context_warm_ms: null,
  context_warm_error: null,
  // Full end-to-end chat-turn prewarm (st_fd14cdd4 Part B). One real
  // /api/chat/stream turn runs at boot AFTER the socket/cache/context warms
  // above, so the FIRST real user turn after a restart pays no cold RAG +
  // context + model-socket tax. The throwaway turn + its rows are deleted
  // before this resolves (clean-up-test-artifacts convention). fullturn_ttft_ms
  // is the boot turn's measured first-token latency — the cold first-turn cost
  // the user no longer pays.
  fullturn_done: false,
  fullturn_ttft_ms: null,
  fullturn_error: null,
  // Last error per channel; null on success. Surfaced for ops debugging.
  embed_error: null,
  retrieve_error: null,
  anthropic_error: null,
  ann_error: null,
};

export function getWarmupState() {
  return {
    started_at: state.started_at,
    completed_at: state.completed_at,
    warmup_complete: !!state.completed_at,
    embed_done: state.embed_done,
    retrieve_done: state.retrieve_done,
    anthropic_done: state.anthropic_done,
    ann_done: state.ann_done,
    ann_global: state.ann_global,
    ann_ready: state.ann_ready,
    ann_load_ms: state.ann_load_ms,
    ann_chunks: state.ann_chunks,
    context_warm_done: state.context_warm_done,
    boot_context_warm_ms: state.boot_context_warm_ms,
    context_warm_error: state.context_warm_error,
    fullturn_done: state.fullturn_done,
    fullturn_ttft_ms: state.fullturn_ttft_ms,
    fullturn_error: state.fullturn_error,
    embed_error: state.embed_error,
    retrieve_error: state.retrieve_error,
    anthropic_error: state.anthropic_error,
    ann_error: state.ann_error,
  };
}

/**
 * Reset internal state. Test hook only.
 */
export function _resetWarmupState() {
  Object.assign(state, {
    started_at: null,
    completed_at: null,
    embed_done: false,
    retrieve_done: false,
    anthropic_done: false,
    ann_done: false,
    ann_global: null,
    ann_ready: false,
    ann_load_ms: null,
    ann_chunks: null,
    context_warm_done: false,
    boot_context_warm_ms: null,
    context_warm_error: null,
    fullturn_done: false,
    fullturn_ttft_ms: null,
    fullturn_error: null,
    embed_error: null,
    retrieve_error: null,
    anthropic_error: null,
    ann_error: null,
  });
}

/** Env flag: treat missing as `defaultOn`, only explicit '0'/'false'/'off' disables. */
function envFlagDefaultOn(name, defaultOn = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultOn;
  if (/^(0|false|off|no)$/i.test(String(raw).trim())) return false;
  if (/^(1|true|on|yes)$/i.test(String(raw).trim())) return true;
  return defaultOn;
}

function shouldBootPrewarmLocalEmbeddings() {
  // Local embed model load is heavy; keep opt-in unless operator enables.
  return process.env.ROBOTDOJO_BOOT_PREWARM_LOCAL_EMBEDDINGS === '1';
}

function shouldBootPrewarmAnnFallback() {
  return process.env.ROBOTDOJO_WARMUP_ANN_FALLBACK === '1';
}

function shouldBootPreloadGlobalAnn() {
  // First-turn RAG quality depends on a loaded global ANN. Default ON in
  // production so a restart does not leave chat on the sqlite-vec fallback.
  // Opt out with ROBOTDOJO_WARMUP_GLOBAL_ANN=0 (tests / constrained hosts).
  return envFlagDefaultOn('ROBOTDOJO_WARMUP_GLOBAL_ANN', true);
}

function shouldBootPrewarmLayeredContext() {
  // First real chat turn was 13–25s cold without this. Default ON so install
  // and restart land the user on the warm path. Opt out: ROBOTDOJO_WARMUP_CONTEXT=0.
  return envFlagDefaultOn('ROBOTDOJO_WARMUP_CONTEXT', true);
}

function shouldBootPrewarmFullTurn() {
  // Full synthetic chat turn at boot can pin the event loop — keep opt-in.
  return process.env.ROBOTDOJO_WARMUP_FULLTURN === '1';
}

// Env-overridable non-negative integer, per build conventions (tunables come
// from env, not string literals). Falls back to `fallback` on absent/invalid.
function envInt(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Fire the three warmup calls. Returns a Promise that resolves once all
 * three settle (success or recorded failure). Safe to call multiple times —
 * if a prior warmup has completed, this is a no-op that resolves immediately.
 */
export async function runBootWarmup() {
  if (state.completed_at) return getWarmupState();
  state.started_at = Date.now();

  // Lazy imports so warmup itself does not slow boot in non-warmup contexts
  // (tests, scripts). The imports stay live across calls so the SDK cache
  // primed here is shared with the real chat request path.
  const safeEmbedPromise = (async () => {
    try {
      const { localEmbeddingModelStatus, safeEmbed } = await import('./rag.js');
      const status = localEmbeddingModelStatus();
      if (!status.installed) {
        state.embed_error = `local embedding model missing at ${status.cacheDir}`;
        return;
      }
      if (shouldBootPrewarmLocalEmbeddings()) {
        // Operator opt-in only. This maps the full local model into the server
        // process, so the product default keeps boot light and leaves bulk
        // embedding to the dedicated worker.
        await safeEmbed('');
      }
      state.embed_done = true;
    } catch (err) {
      state.embed_error = err?.message || String(err);
    }
  })();

  const retrievePromise = (async () => {
    try {
      const { searchFTS } = await import('./rag-search.js');
      // Prime DB/FTS plumbing without vector embedding. Vector warmup would
      // load the ONNX model into the interactive server, which is too heavy
      // for boot and belongs to chat-on-demand or the idle-gated worker.
      searchFTS('robot dojo', { topic: 'general', limit: 1 });
      state.retrieve_done = true;
    } catch (err) {
      state.retrieve_error = err?.message || String(err);
    }
  })();

  const anthropicPromise = (async () => {
    // st_fd14cdd4 — the boot Anthropic ping intermittently fails (a transient
    // 429/503/socket hiccup on the cold process), leaving the model socket cold
    // so even a no-restart first chat turn pays the cold-handshake tax (the live
    // boot log showed anthropic=false). One-shot warming is therefore not enough:
    // RETRY with bounded backoff until the ping succeeds, so the first real chat
    // turn after a restart reliably lands on a warm socket. Bounded
    // (ROBOTDOJO_WARMUP_ANTHROPIC_RETRIES, default 4) + exponential backoff so a
    // genuine outage can't hammer the API — it gives up and records the error.
    const r = await warmAnthropicWithRetry();
    state.anthropic_done = r.ok;
    state.anthropic_error = r.error;
    if (r.ok && r.attempts > 1) {
      console.info(`[warmup] anthropic socket warmed after ${r.attempts} attempts`);
    }
  })();

  // st_85ca4f3c AC 13 — Pre-warm the public FAQ prompt cache.
  // The /faq page hits the same Anthropic endpoint with the same canonical
  // corpus on every request; a single 1-token completion at boot populates
  // the ephemeral prompt cache so the first real user request lands on a
  // cache hit. Fire-and-forget; logged like every other warmup channel.
  // Trigger reason: 'faq-cache-prewarm'.
  const faqCachePromise = warmPublicFaqCache();

  // st_2cd1af73 Phase 6 — pre-warm the REAL chat prompt cache at boot, with
  // the same cacheable system block the chat path sends, so the first real
  // chat turn after a restart lands on a cache hit instead of priming cold.
  // Fire-and-forget; logged with trigger_reason='chat-cache-prewarm'.
  const chatCachePromise = warmChatSystemCache(null, { includeLocalContext: false }).catch(() => {});

  // ── ANN artifact readiness (st_8c7b7a6b + st_cc25425e — split path) ─────
  // Default boot only validates the global artifact on disk. Loading the
  // runtime index refreshes the chunk-topic map with a large SQLCipher scan,
  // which can block health/login/chat during startup on a mature corpus. Chat
  // retrieval loads the runtime index on demand and falls back while unavailable.
  // Operators can opt into eager runtime preload with ROBOTDOJO_WARMUP_GLOBAL_ANN=1.
  const annPromise = (async () => {
    try {
      const { default: db } = await import('./db.js');
      const { getGlobalAnnReadiness } = await import('./ann/usearch-adapter.js');
      const annLoadStart = Date.now();
      const readiness = getGlobalAnnReadiness(db);
      const annLoadMs = Date.now() - annLoadStart;

      if (readiness?.ready === true && !shouldBootPreloadGlobalAnn()) {
        const chunks = readiness.disk?.full_size ?? readiness.disk?.built_from_count ?? readiness.live_embedded ?? 0;
        console.info(`[warmup] ann global artifact ready in ${annLoadMs}ms: chunks=${chunks}; runtime load deferred`);
        state.ann_done = true;
        state.ann_global = true;
        state.ann_ready = true;
        state.ann_load_ms = annLoadMs;
        state.ann_chunks = chunks;
        return;
      }

      if (shouldBootPreloadGlobalAnn()) {
        const { loadGlobalIndex } = await import('./ann/usearch-adapter.js');
        const g = await loadGlobalIndex(db);
        if (g && g.loaded) {
          const chunks = g.full_size ?? g.chunkTopicMap_size ?? 0;
          console.info(`[warmup] ann global index loaded in ${Date.now() - annLoadStart}ms: hot=${g.hot_size} full=${g.full_size} chunks=${chunks} dim=${g.dim}`);
          state.ann_done = true;
          state.ann_global = true;
          state.ann_ready = true;
          state.ann_load_ms = Date.now() - annLoadStart;
          state.ann_chunks = chunks;
          return;
        }
      }

      // No usable global artifact yet. This is degraded only while the lock-gated
      // builder finishes; it is not an operator TODO.
      const repair = String(readiness?.reason || '').includes('rebuild')
        ? 'repair is running or already lock-gated'
        : 'no repair started';
      console.warn(`[warmup] ann global artifact NOT ready (${readiness?.reason || 'unknown'}) after ${annLoadMs}ms — chat RAG can survive on bounded fallback while ${repair}, but launch readiness stays red until ANN is ready.`);
      if (shouldBootPrewarmAnnFallback()) {
        const { loadAllHotIndices } = await import('./ann/usearch-adapter.js');
        const r = await loadAllHotIndices(db);
        console.info(`[warmup] ann per-topic fallback: loaded=${r.loaded} skipped=${r.skipped}`);
      }
      state.ann_done = true;
      state.ann_global = false;
      state.ann_ready = false;
      state.ann_error = readiness?.reason || 'global_index_artifact_not_ready';
    } catch (err) {
      state.ann_error = err?.message || String(err);
    }
  })();

  const contextWorkerPromise = (async () => {
    try {
      const { prewarmContextWorker } = await import('./chat/context-worker.js');
      prewarmContextWorker();
      console.info('[warmup] context worker spawn requested');
    } catch (err) {
      console.warn('[warmup] context worker prewarm failed:', err?.message || err);
    }
  })();

  await Promise.allSettled([safeEmbedPromise, retrievePromise, anthropicPromise, annPromise, faqCachePromise, chatCachePromise, contextWorkerPromise]);

  // ── Ego who-is-who render prime (st_df0a8d71 D3) ─────────────────────────
  // One deterministic graph→string render at boot fills the in-process memo so
  // the very first real turn's prompt assembly is a memory read — zero graph
  // SQL on the hot path from turn one. Unconditional (no env gate): the render
  // is a bounded indexed read over the family-tagged set, never a heavy build.
  // The ego block stays OFF the ping with the rest of Block 3 (includeIdentity
  // false) — nothing personal rides the keep-warm wire.
  try {
    const { refreshEgoBlock } = await import('./ego-render.js');
    const { default: warmupDb } = await import('./db.js');
    // st_f67bc2eb D5 — boot chain: walk → derived cache → ego. The owner view
    // is DERIVED from person_relations; refreshing the cache first means the
    // ego prime below renders the walked truth, and the relations-change
    // listener keeps the chain live for every in-process edge write
    // (relation-store emit → walk+cache → graph-change → ego memo refresh).
    // Out-of-process writers (mining sweep, rerun) refresh explicitly in
    // their own process; the ego idle tick stays the staleness backstop here.
    try {
      const { refreshDerivedRelationCache } = await import('./people-write.js');
      const cache = refreshDerivedRelationCache(warmupDb);
      if (!cache.skipped) {
        console.info(`[warmup] derived relation cache primed (updated=${cache.updated} cleared=${cache.cleared})`);
      }
      const { appEvents } = await import('./app-events.js');
      if (!globalThis.__rdjRelationsListenerBound) {
        globalThis.__rdjRelationsListenerBound = true;
        appEvents.on('relations-change', () => {
          setImmediate(() => {
            try { refreshDerivedRelationCache(warmupDb); } catch { /* idle tick backstop */ }
          });
        });
      }
    } catch (err) {
      console.warn('[warmup] derived relation cache prime failed:', err?.message || err);
    }
    // Passing the handle BINDS it for ego-render's own refresh triggers
    // (graph-change listener + idle tick) — the module carries no static db
    // import by design (the prompt-assembly import graph must stay db-free).
    const ego = refreshEgoBlock(warmupDb);
    console.info(`[warmup] ego who-is-who render primed (${ego.length} chars)`);
  } catch (err) {
    console.warn('[warmup] ego render prime failed:', err?.message || err);
  }

  // ── Product-guide index prime (st_f67bc2eb AC-8) ──────────────────────────
  // One disk read of the generated docs projection at boot; the per-turn
  // detector is then a pure in-memory keyword match (Tier 0, no fetches).
  try {
    const { loadProductGuideIndex } = await import('./product-guide.js');
    const entries = loadProductGuideIndex();
    console.info(`[warmup] product guide index primed (${entries.length} documented answers)`);
  } catch (err) {
    console.warn('[warmup] product guide prime failed:', err?.message || err);
  }

  // ── Layered-context prewarm (st_2cd1af73 AC-1 final) ─────────────────────
  // Runs AFTER the batch above so the ANN index is loaded and the embed socket
  // is primed — this build then measures (and warms) the REAL warm-page cost,
  // not a compound cold. One real ambient (no-topic) layered build per belt
  // pulls the people / chunk_entities / person_interactions / chunks /
  // user_topics index pages into the OS page cache, warms the identity-card
  // mtime cache, and exercises the Gemini embed round-trip — the exact three
  // substrates that make the first real chat turn 13–25 s cold when they are
  // cold. After this, every real (cache-miss) first turn lands on the ~1 s
  // warm-page path. boot_context_warm_ms is logged so it is provable the
  // prewarm ran before the user's first turn. Black warms BOTH belts'
  // substrate; we warm white + black because the entity-bearing layers
  // (Black-only) touch the largest tables and are the worst cold offenders.
  if (shouldBootPrewarmLayeredContext()) {
    const contextWarmStart = Date.now();
    try {
      const { warmAmbientLayeredContext } = await import('./chat-context.js');
      const results = await Promise.allSettled([
        warmAmbientLayeredContext({ belt: 'black' }),
        warmAmbientLayeredContext({ belt: 'white' }),
      ]);
      state.boot_context_warm_ms = Date.now() - contextWarmStart;
      const firstErr = results
        .map((r) => (r.status === 'fulfilled' ? r.value?.error : r.reason?.message))
        .find(Boolean);
      state.context_warm_error = firstErr || null;
      state.context_warm_done = !firstErr;
      const chars = results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value?.chars ?? 0)
        .join('/');
      console.info(`[warmup] layered-context prewarm in ${state.boot_context_warm_ms}ms (both belts) chars=${chars}${firstErr ? ` err=${firstErr}` : ''}`);
    } catch (err) {
      state.boot_context_warm_ms = Date.now() - contextWarmStart;
      state.context_warm_error = err?.message || String(err);
    }
  }

  // ── Full end-to-end chat-turn prewarm (st_fd14cdd4 Part B) ───────────────
  // Boot must keep the foreground server responsive even while a large import
  // is being classified. A synthetic chat request at boot can recurse through
  // the live server and pin the event loop behind heavy SQLite/context reads.
  // The scheduled warmup LaunchAgent owns full chat-turn warming after boot; it
  // has a hard runtime watchdog and is safe to skip when the DB is busy. Boot's
  // default only warms pieces that are bounded here. Operators can still opt in
  // for profiling with ROBOTDOJO_WARMUP_FULLTURN=1.
  if (shouldBootPrewarmFullTurn()) {
    try {
      const r = await warmFullChatTurn();
      state.fullturn_done = r.ok;
      state.fullturn_ttft_ms = r.ttft_ms;
      state.fullturn_error = r.error;
      console.info(`[warmup] full chat turn ${r.ok ? `warmed (first token ${r.ttft_ms}ms)` : `skipped/failed: ${r.error}`}; cleanup=${r.cleaned}`);
    } catch (err) {
      // Defense-in-depth: warmFullChatTurn is already non-throwing, but boot
      // must survive even an unexpected throw here.
      state.fullturn_error = err?.message || String(err);
    }
  }

  state.completed_at = Date.now();

  // Log boot warmup as a single 'boot' row capturing total latency.
  // WHY here, not per-channel: we care about the user-visible boot latency,
  // not the breakdown — getWarmupState() exposes that for ops debugging.
  await logWarmupEvent({
    provider: 'all',
    model: 'boot',
    trigger_reason: 'boot',
    latency_ms: state.completed_at - state.started_at,
    started_at: state.started_at,
    completed_at: state.completed_at,
  });

  return getWarmupState();
}

/**
 * st_fd14cdd4 — fire the boot Anthropic warmup ping, retrying with bounded
 * exponential backoff until it succeeds. A single cold-process ping can hit a
 * transient 429/503/socket error and leave the model socket cold; the next real
 * chat turn then pays the cold-handshake tax even though no restart occurred.
 * Retrying makes the warm socket reliable; the bound + backoff stops a genuine
 * outage from hammering the API (it gives up and records the last error).
 *
 * Tunables (env-overridable per build conventions):
 *   ROBOTDOJO_WARMUP_ANTHROPIC_RETRIES   max attempts        (default 4)
 *   ROBOTDOJO_WARMUP_ANTHROPIC_BACKOFF_MS base backoff in ms (default 500)
 * Backoff is base * 2^(attempt-1), so the default schedule is 0 / 0.5s / 1s / 2s
 * between four attempts — bounded, cheap, and idle-safe (this runs once at boot).
 *
 * @param {object} [opts]
 * @param {number} [opts.retries] - max attempts.
 * @param {number} [opts.baseBackoffMs] - base backoff between attempts.
 * @param {(ms:number)=>Promise<void>} [opts.sleep] - test hook; defaults to a
 *   real timer. Injected so unit tests run instantly with no real delay.
 * @param {function} [opts.completeImpl] - test hook for the provider call.
 * @returns {Promise<{ok:boolean, attempts:number, error:string|null}>}
 */
export async function warmAnthropicWithRetry({
  retries = envInt('ROBOTDOJO_WARMUP_ANTHROPIC_RETRIES', 4),
  baseBackoffMs = envInt('ROBOTDOJO_WARMUP_ANTHROPIC_BACKOFF_MS', 500),
  sleep = (ms) => new Promise((res) => setTimeout(res, ms)),
  completeImpl = null,
} = {}) {
  const maxAttempts = Math.max(1, retries);
  let lastError = null;
  let complete = completeImpl;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!complete) {
        const { getProvider } = await import('./llm/index.js');
        const { activeProvider } = await import('./model-lane.js');
        const provider = await getProvider(activeProvider());
        complete = provider.complete.bind(provider);
      }
      // 1-token ping. Uses the fastest tier so cost is negligible (<$0.0001).
      // Sentinel role/content honored by the API.
      await complete({
        model: 'fast',
        messages: [{ role: 'user', content: '.' }],
        max_tokens: 1,
      });
      return { ok: true, attempts: attempt, error: null };
    } catch (err) {
      lastError = err?.message || String(err);
      // Reset the bound provider on failure so a transient getProvider/socket
      // issue is re-resolved on the next attempt rather than reused.
      if (!completeImpl) complete = null;
      if (attempt < maxAttempts) {
        await sleep(baseBackoffMs * 2 ** (attempt - 1));
      }
    }
  }
  return { ok: false, attempts: maxAttempts, error: lastError };
}

// st_fd14cdd4 Part B — fixed throwaway conversation id for the boot full-turn
// prewarm. Prefixed `warmup` so it matches the existing `conversation_id LIKE
// 'warmup%'` exclusion convention every TTFT/metrics reader already applies —
// any row that escapes cleanup is therefore still filterable out of real
// aggregates. The turn + all its rows are deleted before warmup resolves, so in
// the normal path NOTHING with this id survives.
const WARMUP_FULLTURN_CONV_ID = 'warmup-fullturn';

/**
 * st_fd14cdd4 Part B — drive ONE real end-to-end chat turn at boot so the FIRST
 * real user turn after a restart is hot. Hits the live local /api/chat/stream
 * (the same path a browser/tunnel turn hits: middleware auth → deferred upsert →
 * streamChat RAG + context build → entity recognition → model socket), waits for
 * the first token (bounded), then DELETES the throwaway conversation and every
 * row it created. The owner must never see the test turn (clean-up-test-artifacts
 * convention), so cleanup is part of the contract, not optional debt.
 *
 * Bounded + non-fatal by construction: every failure path (server unreachable,
 * no auth token, timeout, HTTP error, stream error) is caught, recorded, and
 * returned — this never throws to runBootWarmup, so a missing/slow server can't
 * block or crash boot. It runs ONCE per boot (no loop) so the cost is a single
 * cheap turn.
 *
 * @param {object} [opts]
 * @param {object} [opts.db] - sqlite handle for cleanup; defaults to the singleton.
 * @param {string} [opts.prompt] - trivial throwaway prompt.
 * @param {number} [opts.timeoutMs] - first-token deadline.
 * @param {(url:string, init:object)=>Promise<Response>} [opts.fetchImpl] - test
 *   hook; defaults to a loopback fetch with TLS verification disabled (the local
 *   server is a self-signed loopback cert, per build conventions).
 * @returns {Promise<{ok:boolean, ttft_ms:number|null, error:string|null, cleaned:boolean}>}
 */
export async function warmFullChatTurn({
  db = null,
  prompt = 'hi',
  timeoutMs = envInt('ROBOTDOJO_WARMUP_FULLTURN_TIMEOUT_MS', 30_000),
  fetchImpl = null,
  url = null,
  extraHeaders = null,
  sleep = (ms) => new Promise((res) => setTimeout(res, ms)),
} = {}) {
  const started_at = Date.now();
  let ttft_ms = null;
  let ok = false;
  let error = null;
  let resolvedDb = db;

  try {
    if (!resolvedDb) {
      const mod = await import('./db.js');
      resolvedDb = mod.default;
    }
  } catch { /* cleanup just won't run if db is unavailable */ }

  try {
    const { default: config } = await import('./config.js');
    const token = config.authToken;
    if (!token) {
      error = 'no local auth token — cannot drive warmup turn';
    } else {
      // Default: hit the local app server (index.js) on 127.0.0.1. Scheduled
      // warmup can pass a relay URL so the exact remote chat path is warmed too.
      // TLS verification is disabled for the loopback default because the cert
      // is self-signed; relay URLs use normal public TLS.
      // config.ports.app is always defined (lib/config.js defaults it); no
      // literal fallback here (check-literals: ports come from config).
      const port = config.ports.app;
      const streamUrl = url || `https://127.0.0.1:${port}/api/chat/stream`;

      let doFetch = fetchImpl;
      if (!doFetch) {
        const { Agent } = await import('undici');
        const insecure = new Agent({ connect: { rejectUnauthorized: false } });
        doFetch = (u, init) => fetch(u, { ...init, dispatcher: insecure });
      }

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      try {
        const res = await doFetch(streamUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-RobotDojo-Warmup': 'fullturn',
            ...(extraHeaders || {}),
          },
          // No topic on purpose — a general (no-RAG-scope) turn exercises the
          // hottest first-turn path without pulling a topic shard. Fixed convId
          // so cleanup targets exactly this row.
          body: JSON.stringify({
            messages: [{ role: 'user', content: prompt }],
            conversationId: WARMUP_FULLTURN_CONV_ID,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          error = `chat stream HTTP ${res.status}`;
        } else {
          // Read SSE frames. We RECORD ttft_ms at the first model delta (that is
          // the warmth proof — auth → context → RAG → model socket walked warm),
          // but we keep reading until the turn finishes (`conv_saved`/`done`) or
          // the stream ends. WHY drain instead of aborting at first token: the
          // server persists the conversation + messages + metrics at stream END
          // (after the model finishes), so aborting early would race the
          // server-side persist — cleanup would delete first, then the server
          // would INSERT the messages, leaking them. Draining a trivial 1-line
          // turn is sub-second more and guarantees persist has happened before we
          // purge. `conv_saved` is emitted immediately after persistMessages, so
          // it is the precise "safe to clean up now" signal.
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let finished = false;
          readLoop: while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const ln of lines) {
              if (!ln.startsWith('data: ')) continue;
              let j; try { j = JSON.parse(ln.slice(6)); } catch { continue; }
              if (j.type === 'delta' && ttft_ms === null && (j.text || j.text === '')) {
                ttft_ms = Date.now() - started_at;
                ok = true; // first token reached = the warm path is proven
              }
              // Persist has completed by the time conv_saved/done lands — the
              // server emits conv_saved right after persistMessages. Stop here so
              // cleanup runs AFTER the rows exist (no race), not before.
              if (j.type === 'conv_saved' || j.type === 'done') { finished = true; break readLoop; }
              if (j.type === 'error') { error = error || (j.message || 'stream error'); break readLoop; }
            }
          }
          // Drain any tail so the connection closes cleanly (no need to keep it).
          try { await reader.cancel(); } catch {}
          if (!ok && !error) error = finished ? 'turn finished without a first token' : 'no first token before stream end';
        }
      } catch (err) {
        if (err?.name === 'AbortError') {
          error = ttft_ms === null
            ? `first token not received within ${timeoutMs}ms`
            : error;
        } else {
          error = err?.message || String(err);
        }
      } finally {
        clearTimeout(deadline);
      }
    }
  } catch (err) {
    error = err?.message || String(err);
  }

  // ── Cleanup (always runs, even on failure) ──────────────────────────────
  // The server may have already persisted the conversation + messages + a
  // chat_turn_metrics row even if we aborted at first token (persist happens at
  // stream END, but a timeout/abort can land anywhere). Purge unconditionally so
  // no residue survives regardless of where the turn stopped. We call the real
  // deleteConversation() path (soft delete, the product mechanism) first, then
  // the synchronous hard purge removes all physical residue.
  let cleaned = false;
  if (resolvedDb) {
    const cleanupAttempts = Math.max(1, envInt('ROBOTDOJO_WARMUP_CLEANUP_ATTEMPTS', 5));
    let cleanupError = null;
    for (let attempt = 1; attempt <= cleanupAttempts; attempt++) {
      try {
        try {
          const { deleteConversation } = await import('./conversations.js');
          deleteConversation(resolvedDb, WARMUP_FULLTURN_CONV_ID);
        } catch { /* soft delete is best-effort; hard purge below is the guarantee */ }
        cleaned = purgeWarmupFullTurn(resolvedDb);
        cleanupError = null;
        break;
      } catch (err) {
        cleanupError = err;
        const msg = err?.message || String(err);
        const retryable = /SQLITE_BUSY|database is locked|database busy/i.test(msg);
        if (!retryable || attempt === cleanupAttempts) break;
        await sleep(Math.min(1000, 100 * 2 ** (attempt - 1)));
      }
    }
    if (cleanupError) {
      // Cleanup failure is logged but never fatal; record it on the error
      // channel if the turn itself succeeded (so a leak is visible).
      error = error || `cleanup failed: ${cleanupError?.message || String(cleanupError)}`;
    }
  }

  const completed_at = Date.now();
  await logWarmupEvent({
    provider: 'anthropic',
    model: 'fullturn',
    trigger_reason: 'fullturn-prewarm',
    latency_ms: completed_at - started_at,
    started_at,
    completed_at,
    error,
  });

  return { ok, ttft_ms, error, cleaned };
}

/**
 * st_fd14cdd4 Part B — HARD-purge the throwaway full-turn conversation and EVERY
 * row it could have created. The caller (warmFullChatTurn) calls the real
 * deleteConversation() soft-delete path first; this removes all physical residue
 * because the owner must see no leftover at all (deleteConversation only sets
 * deleted_at). Pure + synchronous so it can run in any context; idempotent — safe
 * when the turn never persisted anything. Returns true once it has run (a no-op
 * delete still counts as clean).
 *
 * The tables a /api/chat/stream turn writes for a conversation are: conversations,
 * messages, conversation_topics (only if a topic was set — none here, purged
 * defensively), and chat_turn_metrics. message_threads is the /threads route only
 * and is never touched by /api/chat/stream.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [convId=WARMUP_FULLTURN_CONV_ID]
 * @returns {boolean} true when cleanup ran
 */
export function purgeWarmupFullTurn(db, convId = WARMUP_FULLTURN_CONV_ID) {
  const purge = db.transaction((id) => {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversation_topics WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM chat_turn_metrics WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  });
  purge(convId);
  return true;
}

// Export the throwaway id so tests + ops scripts can assert no residue.
export { WARMUP_FULLTURN_CONV_ID };

/**
 * Fire a 1-token warmup ping against a specific provider. Used by the
 * model-change event subscriber so switching the user's default chat
 * model warms the new provider before they type the next message.
 *
 * @param {string} provider - 'anthropic' | 'openai' | 'google' | ...
 * @param {object} [opts]
 * @param {string} [opts.model] - specific model, else provider's 'fast' tier
 * @param {string} [opts.trigger_reason='model-change']
 * @returns {Promise<{ok: boolean, latency_ms: number, error?: string}>}
 */
export async function warmProvider(provider, { model = 'fast', trigger_reason = 'model-change' } = {}) {
  const started_at = Date.now();
  let ok = false;
  let error = null;
  try {
    const { getProvider } = await import('./llm/index.js');
    const client = await getProvider(provider);
    await client.complete({
      model,
      messages: [{ role: 'user', content: '.' }],
      max_tokens: 1,
    });
    ok = true;
  } catch (err) {
    error = err?.message || String(err);
  }
  const completed_at = Date.now();
  await logWarmupEvent({
    provider,
    model: String(model),
    trigger_reason,
    latency_ms: completed_at - started_at,
    started_at,
    completed_at,
    error,
  });
  return { ok, latency_ms: completed_at - started_at, error };
}

/**
 * Persist a warmup event row. Best-effort — never throws to caller.
 * Schema matches lib/migrations/068_warmup_events.sql.
 */
async function logWarmupEvent(row) {
  try {
    const { default: db } = await import('./db.js');
    db.prepare(`
      INSERT INTO warmup_events
        (provider, model, trigger_reason, latency_ms, started_at, completed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.provider,
      row.model,
      row.trigger_reason,
      Number.isFinite(row.latency_ms) ? row.latency_ms : null,
      Number.isFinite(row.started_at) ? row.started_at : Date.now(),
      Number.isFinite(row.completed_at) ? row.completed_at : null,
      row.error || null,
    );
  } catch (err) {
    console.warn('[warmup] logWarmupEvent failed:', err.message);
  }
}

// Export for tests + observability scripts.
export { logWarmupEvent };

/**
 * st_85ca4f3c AC 13 — Pre-warm the public FAQ prompt cache.
 *
 * The /faq page sends every request with the same canonical-corpus system
 * prompt (Anthropic block with cache_control: ephemeral). Firing one
 * `max_tokens: 1` completion at boot populates the cache so the first real
 * user request lands on a hit, keeping warm TTFT under the Ask budget.
 *
 * Fire-and-forget — never throws. Logged to warmup_events with
 * trigger_reason='faq-cache-prewarm'. The 5-minute ephemeral TTL is short
 * enough that a separate LaunchAgent should re-warm every ~4 minutes for
 * the strongest cache hit-rate; that scheduling lives outside this module.
 */
export async function warmPublicFaqCache() {
  const started_at = Date.now();
  let ok = false;
  let error = null;
  try {
    const { MODEL, MAX_TOKENS, loadContext, buildSystemPrompt, DEFAULT_CONTEXT } =
      await import('./public-chat/core.js');
    const { getProvider } = await import('./llm/index.js');
    const provider = await getProvider('anthropic');
    const ctx = loadContext(DEFAULT_CONTEXT);
    const system = buildSystemPrompt(ctx);
    await provider.complete({
      model: MODEL,
      max_tokens: 1,
      system,
      messages: [{ role: 'user', content: '.' }],
      cache: 'system',
    });
    ok = true;
    void MAX_TOKENS; // imported for symmetry with the public-chat route; not used in warmup
  } catch (err) {
    error = err?.message || String(err);
  }
  const completed_at = Date.now();
  await logWarmupEvent({
    provider: 'anthropic',
    model: 'faq-cache',
    trigger_reason: 'faq-cache-prewarm',
    latency_ms: completed_at - started_at,
    started_at,
    completed_at,
    error,
  });
  return { ok, latency_ms: completed_at - started_at, error };
}

/**
 * st_2cd1af73 — keep the REAL chat prompt cache warm with the zero-personal
 * prefix (Block A + the ambient voice block C′).
 *
 * The legacy warmup pings (scripts/anthropic-warmup.js, warmProvider) sent a
 * bespoke system text ("You are a Robot Dojo warmup ping…") with cache_control.
 * That warmed a cache key the chat path NEVER hits — research §5 measured
 * cache_read=0 on every real turn because the warmup prefix differed from the
 * chat prefix. The cache key is a hash of the system blocks + model; a different
 * prefix is a different key.
 *
 * AC-1 — the ping sends Blocks A + C′ (the generic product prompt AND the
 * ambient voice block) via the SAME builder the chat path uses:
 * assembleCachedSystemBlocks({belt, useTools:false, includeIdentity:false,
 * includeTopic:false, includeAmbient:true}, db). WHY A + C′, two reasons:
 *   1. Zero personal content on the wire (owner's requirement): both A and C′
 *      carry no PII. The owner name + identity card live in Block B, which the
 *      ping OMITS (includeIdentity:false). After the owner's 2026-06-11 decision
 *      C′ holds the product's voice/grounding contract — not the owner's
 *      people/topics — so it too is safe to put on the keep-warm wire. Block B
 *      warms naturally on the FIRST real turn and stays warm from use.
 *   2. Single source of truth: the ping's A and C′ are byte-identical to a real
 *      no-topic turn's A and C′ (same function, same args), so the ping's cache
 *      entry is exactly the prefix a real no-topic turn matches.
 * The privacy + speed UPGRADE: A + C′ clears the chat model's measured
 * 4096-token cache floor (Block A alone, ~930 tok, did not), so the ping now
 * pre-warms a REAL reusable cache entry a no-topic chat reads on its first turn —
 * not just the TLS socket + model. The turn-to-turn HIT within a conversation
 * (A+B+C with identity + topic, or A+B+C′) is unchanged. Cheap (1 token out per
 * belt) so the cadence cost stays fractional.
 *
 * Warms BOTH belts by default: a fresh customer chats White, the owner chats
 * Black, and the belt footer changes the cacheable text (different key per belt).
 * Two tiny pings cover whichever belt the next turn uses. Fire-and-forget;
 * logged to warmup_events with trigger_reason='chat-cache-prewarm'. Never throws.
 *
 * @param {object} [db] - sqlite handle; defaults to the shared singleton.
 * @param {object} [opts]
 * @param {string[]} [opts.belts=['white','black']] - belts to warm.
 * @param {string} [opts.model] - chat model to warm; defaults to the user's
 *   configured chat model (config.models.chat — Haiku fast tier by default).
 * @param {boolean} [opts.includeLocalContext=true] - include the heavier local
 *   layered-context keep-warm. Boot passes false so startup cannot load the
 *   local embedding model in the foreground server.
 * @returns {Promise<{ok:boolean, latency_ms:number, warmed:number, error?:string}>}
 */
export async function warmChatSystemCache(db, { belts = null, model = null, includeLocalContext = true } = {}) {
  // Owner call 2026-06-10: ping only the belt actually served on this machine
  // (same model either way — the belt only changes the cacheable prompt text,
  // so warming the unused belt's prefix is pure spend). Env-overridable;
  // multi-belt installs can set ROBOTDOJO_WARM_BELTS=white,black.
  if (!belts) {
    belts = (process.env.ROBOTDOJO_WARM_BELTS || 'black').split(',').map(s => s.trim()).filter(Boolean);
  }
  const started_at = Date.now();
  let resolvedDb = db;
  let error = null;
  let warmed = 0;
  try {
    if (!resolvedDb) {
      const mod = await import('./db.js');
      resolvedDb = mod.default;
    }
    const { default: config } = await import('./config.js');
    const { assembleCachedSystemBlocks } = await import('./chat/system-prompt.js');
    const { selectProvider } = await import('./llm/index.js');
    // Default to the actual chat model so the cache key matches real turns.
    const chatModel = model || config.models.chat;
    const provider = await selectProvider({ model: chatModel });
    for (const belt of belts) {
      try {
        // Blocks A + C′ — the generic product prompt AND the ambient voice
        // block, both ZERO-PERSONAL. Same builder + args the chat path uses, so
        // the prefix is byte-identical (single source of truth). identity +
        // topic are excluded so the owner name, identity card, and any topic
        // text all stay off the 4-minute keep-warm wire.
        //
        // st_2cd1af73 (owner decision 2026-06-11): C′ now carries the product's
        // voice/grounding contract, not the owner's people/topics — so it is
        // safe to warm. includeAmbient:true is the privacy UPGRADE: A+C′ clears
        // the 4096 cache floor, so the ping pre-warms a REAL cacheable prefix a
        // no-topic chat reads (not just the TLS socket), and still nothing
        // personal rides the wire. Block B (identity) stays off the ping by
        // design; it warms naturally on the first real turn and stays warm from
        // use. (Was includeAmbient:false when C′ held the personal world map.)
        const system = assembleCachedSystemBlocks(
          { belt, useTools: false, includeIdentity: false, includeTopic: false, includeAmbient: true },
          resolvedDb,
        );
        await provider.complete({
          model: chatModel,
          max_tokens: 1,
          system,
          messages: [{ role: 'user', content: '.' }],
          cache: 'system',
        });
        warmed++;
      } catch (err) {
        // Record the first failure but keep warming the other belt — a 503 on
        // one ping must not skip the other.
        error = error || (err?.message || String(err));
      }
    }

    // ── Layered-context keep-warm (st_2cd1af73 AC-1 final) ──────────────────
    // Warming the Anthropic prompt cache above keeps the LLM side warm; this
    // keeps the LOCAL context-build substrate warm. The first real chat turn is
    // always a per-query LRU miss, so its build cost is set by whether the DB
    // index pages (people / chunk_entities / person_interactions / chunks /
    // user_topics) are resident and the embed socket is live. Under memory
    // pressure those pages get evicted; a build then pays the 13–25 s cold-page
    // tax. Re-running one real ambient build per belt on this cadence — but only
    // when the prior warm is older than CONTEXT_KEEPWARM_MAX_AGE_MS (default 4
    // min) — keeps those pages hot so an idle-recovery turn stays on the warm
    // path. Failures are recorded, never thrown.
    //
    // ACTIVE-CHAT SKIP (st_2cd1af73 AC-1): when the user is ACTIVELY chatting,
    // every real turn already walks — and warms — those exact index pages and
    // the embed socket. Running a second full ambient build per cycle then warms
    // nothing new; it only contends for the SQLCipher single-writer + CPU + the
    // embed HTTPS socket WITH the in-flight turn, inflating that turn's TTFT
    // (measured: warm turns that overlapped a keep-warm rebuild spiked from ~1.5 s
    // to 5–6 s). So skip the heavy rebuild when a real chat turn landed within
    // ACTIVE_WINDOW_MS — the pages are already hot from use. The cheap socket +
    // prompt-cache ping above ALWAYS runs (it must, to keep the TLS socket warm
    // across idle gaps); only the redundant local rebuild is gated. Read-only:
    // we read the server_activity.last_request_at the request path already
    // maintains; we do not write it.
    const ACTIVE_WINDOW_MS = envInt('ROBOTDOJO_KEEPWARM_ACTIVE_WINDOW_MS', 90_000);
    let recentlyActive = false;
    try {
      const row = resolvedDb
        .prepare('SELECT last_request_at FROM server_activity WHERE id = 1')
        .get();
      const lastReq = Number(row?.last_request_at) || 0;
      recentlyActive = lastReq > 0 && (Date.now() - lastReq) < ACTIVE_WINDOW_MS;
    } catch { /* table absent in some test envs — treat as not-active */ }

    if (includeLocalContext && !recentlyActive) {
      const keepWarmMaxAge = envInt('ROBOTDOJO_CONTEXT_KEEPWARM_MAX_AGE_MS', 4 * 60_000);
      try {
        const { warmAmbientLayeredContext } = await import('./chat-context.js');
        for (const belt of belts) {
          const r = await warmAmbientLayeredContext({ belt, maxAgeMs: keepWarmMaxAge });
          if (r.error) error = error || r.error;
        }
      } catch (err) {
        error = error || (err?.message || String(err));
      }
    }
  } catch (err) {
    error = err?.message || String(err);
  }
  const completed_at = Date.now();
  await logWarmupEvent({
    provider: 'anthropic',
    model: 'chat-cache',
    trigger_reason: 'chat-cache-prewarm',
    latency_ms: completed_at - started_at,
    started_at,
    completed_at,
    error,
  });
  return { ok: warmed > 0 && !error, latency_ms: completed_at - started_at, warmed, error };
}

// ── Model-change subscription (st_566ad80b AC 10) ──────────────────────────
// Subscribe at module-import time so the listener is wired regardless of
// whether runBootWarmup has been called yet. WHY: a server might receive
// a model-change event before boot warmup finishes; the listener should
// already be wired so the warmup ping fires within 100 ms either way.
//
// The listener is fire-and-forget — we do NOT await warmProvider so the
// emit() returns synchronously to the route that triggered it. The
// 100 ms ceiling in AC 10 measures listener-fired-to-network-send, not
// listener-fired-to-network-complete (which depends on the provider's
// own latency).
appEvents.on('model-change', (payload) => {
  if (!payload || typeof payload.provider !== 'string') return;
  // Fire-and-forget; warmProvider logs its own event row.
  warmProvider(payload.provider, {
    model: payload.model || 'fast',
    trigger_reason: 'model-change',
  }).catch(err => console.warn('[warmup] model-change handler failed:', err.message));
});
