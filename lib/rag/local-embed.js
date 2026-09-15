import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import config from '../config.js';

// st_2cd1af73 AC-3 — ONNX Runtime session memory bound.
//
// WHY (Phase-1 jetsam evidence): JetsamEvent-2026-06-10-124740 named a node
// process at 6,093,560 pages ≈ 95 GB RSS as `largestProcess` — the embed daemon,
// SIGKILLed by the OS memory-pressure path (which is why its err log was empty
// and no [embed] line ever printed: SIGKILL leaves no trace and the process died
// mid-inference, before any batch-complete log). The balloon is the ORT CPU
// execution provider's default memory behavior on long, variably-padded batches:
// `enableMemPattern` pre-plans an allocation sized for the largest shape seen, and
// the CPU arena (`enableCpuMemArena`) retains peak working-set across a long-lived
// process's repeated batches. Measured (this machine): a batch=8 run over 4000-char
// inputs ran >130 s and climbed without bound; batch=2 over the same inputs stayed
// at ~6 GB and finished in 46 s. The model RSS alone is ~1.9 GB.
//
// FIX: pass session_options when the pipeline builds the InferenceSession (the one
// place ORT honors them). Disabling the arena + mem-pattern caps the pre-planned
// allocation, and pinning intra-op threads keeps the daemon on a bounded core set
// (the box has 4 P-cores) so it yields CPU to the foreground server and does not
// spawn an unbounded thread pool. All values are config/defaults.json-tunable and
// env-overridable (no un-tunable literal). transformers passes session_options
// straight into onnxruntime-node's InferenceSession.create (verified in
// node_modules/@huggingface/transformers/src/backends/onnx.js:createInferenceSession).
//
// st_2cd1af73 AC-1 (final residual, measured 2026-06-10): intraOp was 4 — the
// FULL P-core count. WHY that hurts chat TTFT: a single ONNX inference is
// UNINTERRUPTIBLE, so when a chat turn lands mid-batch the activity-pause stops
// the NEXT batch but the in-flight one runs to completion holding every P-core.
// At intraOp=4 that left ZERO performance cores for the server's synchronous
// SQLCipher cold-page decrypt on its main thread (sampled live: RijndaelDecrypt +
// sha512_transf + pread dominate a turn) — so the daemon's mid-batch overhang
// stacked directly onto the server's first-token path. Pinning to HALF the
// P-cores (2 of 4) caps that overhang: the daemon can still embed, but the
// foreground server always retains 2 P-cores for its decrypt/RAG work, so the
// embedder can no longer be the term that starves a turn mid-batch. The model
// load is one-time so a 2-core session does not slow steady-state drain
// materially; throughput on the 335k email tail comes from load-once + cadence,
// not from saturating every core (st_b50005df). Env-overridable for a box with a
// different P-core count (ROBOTDOJO_EMBED_ORT_INTRA_THREADS).
const DEFAULT_ORT = {
  ortIntraOpThreads: 2,
  ortEnableCpuMemArena: false,
  ortEnableMemPattern: false,
};

// st_2cd1af73 NIGHT MODE — the embed daemon's two work-intensity profiles.
//
// WHY a profile flag and not a second session option set: intraOpNumThreads is
// baked into the ONNX InferenceSession at MODEL LOAD (transformers forwards it
// into onnxruntime-node's InferenceSession.create). ORT honors thread count only
// at session creation, so the only way to change it at runtime is to re-init the
// session. setEmbedProfile() flips this flag and, when the resulting intra-op
// thread count actually changes, nulls the memoized extractor so the NEXT embed
// call rebuilds the session with the new thread count. A flip happens at most a
// few times/day (cross the wide chat-quiet threshold, or a chat turn lands), and
// the reload is ~60s of one-time model load — acceptable per the brief, and far
// simpler than carrying two live sessions.
//
//   - 'day'   : the polite chat-safe profile (intraOp default 2 = HALF the
//               P-cores, so an uninterruptible in-flight batch always leaves
//               cores for the server's synchronous SQLCipher decrypt during a
//               chat turn — the AC-1 TTFT fix). This is the default at process
//               start so a daemon that never sees a quiet window stays polite.
//   - 'night' : the wide-quiet profile (intraOp default 4 = the full P-core
//               count) used only after CHAT has been quiet for the night
//               threshold. The daemon drops back to 'day' within ~2s of any chat
//               request via the existing activity reflex, so the full-core
//               session is only ever resident while no human is in chat.
//
// HARD INVARIANT: the memory-bounding options (arena + mem-pattern OFF) are
// IDENTICAL in both profiles. Night mode changes ONLY the core budget, never the
// RSS contract — the 95GB jetsam balloon must stay impossible in either profile.
const EMBED_PROFILES = Object.freeze(['day', 'night']);
let activeEmbedProfile = 'day';

/**
 * The current embed work-intensity profile ('day' | 'night'). Read by
 * embedSessionOptions() to pick the intra-op thread count.
 * @returns {'day'|'night'}
 */
export function getEmbedProfile() {
  return activeEmbedProfile;
}

/**
 * Switch the embed work-intensity profile. When the new profile's intra-op thread
 * count differs from the current session's, the memoized extractor is dropped so
 * the next embed call rebuilds the InferenceSession with the new thread count
 * (ORT bakes thread count at session creation — a runtime change requires re-init).
 * Idempotent: re-asserting the same profile, or a flip that does not change the
 * thread count, leaves the live session untouched (no needless ~60s reload).
 *
 * @param {'day'|'night'} profile
 * @returns {{profile:'day'|'night', reloaded:boolean, intraOpNumThreads:number}}
 */
export function setEmbedProfile(profile) {
  const next = EMBED_PROFILES.includes(profile) ? profile : 'day';
  const prevThreads = intraOpThreadsForProfile(activeEmbedProfile);
  const nextThreads = intraOpThreadsForProfile(next);
  activeEmbedProfile = next;
  // Only force a session re-init when the thread count actually changes. Flipping
  // the flag with an identical effective thread count (e.g. an operator pinned
  // both profiles to the same override) must not throw away a loaded model.
  const reloaded = prevThreads !== nextThreads && extractorPromise !== null;
  if (prevThreads !== nextThreads) extractorPromise = null;
  return { profile: next, reloaded, intraOpNumThreads: nextThreads };
}

function readEmbedDefaults() {
  try {
    const raw = readFileSync(resolve(homedir(), 'robotdojo', 'config', 'defaults.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return cfg?.embed && typeof cfg.embed === 'object' ? cfg.embed : {};
  } catch {
    // Missing/unreadable defaults.json must never break model load — fall back to
    // the safe in-code defaults below.
    return {};
  }
}

function numericEnvOrConfig(envName, configValue, fallback) {
  const env = Number(process.env[envName]);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  if (Number.isFinite(Number(configValue)) && Number(configValue) > 0) return Math.floor(Number(configValue));
  return fallback;
}

function boolEnvOrConfig(envName, configValue, fallback) {
  const env = process.env[envName];
  if (env === 'true' || env === '1') return true;
  if (env === 'false' || env === '0') return false;
  if (typeof configValue === 'boolean') return configValue;
  return fallback;
}

// st_2cd1af73 NIGHT MODE default. The wide-quiet profile opens the daemon up to
// the FULL P-core count (this box has 4). Env-overridable so an operator with a
// different core count sets their own night budget; falls back to config then 4.
const DEFAULT_NIGHT_INTRAOP = 4;

/**
 * The intra-op thread count for a given profile. 'day' is the polite half-P-core
 * budget (the chat-safe default); 'night' is the wide-quiet full-core budget. Both
 * are env/config tunable so no un-tunable literal governs the core budget.
 *
 * @param {'day'|'night'} profile
 * @returns {number} intra-op thread count (>=1)
 */
function intraOpThreadsForProfile(profile) {
  const cfg = readEmbedDefaults();
  if (profile === 'night') {
    return numericEnvOrConfig('ROBOTDOJO_NIGHT_INTRAOP', cfg.nightIntraOpThreads, DEFAULT_NIGHT_INTRAOP);
  }
  return numericEnvOrConfig('ROBOTDOJO_EMBED_ORT_INTRA_THREADS', cfg.ortIntraOpThreads, DEFAULT_ORT.ortIntraOpThreads);
}

/**
 * Build the onnxruntime-node SessionOptions that bound the CPU EP's memory and
 * thread footprint. Read at model-load time so an operator can tune per-process.
 *
 * The intra-op thread count follows the ACTIVE embed profile (day = polite, half
 * the P-cores; night = wide-quiet, full P-cores). The MEMORY-bounding options
 * (arena + mem-pattern OFF) are profile-INVARIANT: night mode never relaxes the
 * RSS contract — that is the absolute jetsam invariant from the 95GB incident.
 *
 * @returns {{intraOpNumThreads:number, interOpNumThreads:number, enableCpuMemArena:boolean, enableMemPattern:boolean, executionMode:'sequential', profile:'day'|'night'}}
 */
export function embedSessionOptions() {
  const cfg = readEmbedDefaults();
  return {
    intraOpNumThreads: intraOpThreadsForProfile(activeEmbedProfile),
    interOpNumThreads: 1,
    enableCpuMemArena: boolEnvOrConfig('ROBOTDOJO_EMBED_ORT_CPU_ARENA', cfg.ortEnableCpuMemArena, DEFAULT_ORT.ortEnableCpuMemArena),
    enableMemPattern: boolEnvOrConfig('ROBOTDOJO_EMBED_ORT_MEM_PATTERN', cfg.ortEnableMemPattern, DEFAULT_ORT.ortEnableMemPattern),
    executionMode: 'sequential',
    profile: activeEmbedProfile,
  };
}

export const LOCAL_EMBED_MODEL_ID = 'Snowflake/snowflake-arctic-embed-l-v2.0';
export const LOCAL_EMBED_MODEL_CACHE_SLUG = 'Snowflake/snowflake-arctic-embed-l-v2.0';
export const LOCAL_EMBED_DIM = 1024;
export const LOCAL_EMBED_DTYPE = 'q8';
export const LOCAL_EMBED_QUERY_PREFIX = 'query: ';

// st_2cd1af73 Phase 2 — embed-input character bound (the per-chunk inference cap).
//
// WHY (Phase-1 finding): a transcript-class chunk runs ~32k chars ≈ 8k tokens.
// On the CPU ONNX path one such inference takes minutes and is uninterruptible
// mid-batch, so a single monster chunk stalls the value-first embed queue and
// starves the high-volume email corpus the recall AC must drain. The daemon's
// slice watchdog only rotates AWAY from the slow topic — the chunk itself never
// embeds, it just retries and re-times-out forever.
//
// FIX: cap the text handed to the tokenizer to a prefix (default ~4000 chars ≈
// ~1k tokens, a bounded CPU latency). This is PREFIX EMBEDDING: the embedding is
// computed over the leading window only, which for a chunk carries the dominant
// topical signal (subject/opening of an email, first turns of a transcript). The
// chunk's FULL content is never mutated — `chunks.content` stays intact for FTS
// keyword recall and for the text actually injected into the prompt on a hit.
// Only the vector's input is bounded; retrieval still returns the whole chunk.
//
// Env-overridable per build conventions (no un-tunable literal). 0/negative
// disables the cap (embed the full text) for an operator who wants it off.
const DEFAULT_EMBED_INPUT_CHAR_CAP = 4000;
export function embedInputCharCap() {
  const raw = Number(process.env.ROBOTDOJO_EMBED_INPUT_CHAR_CAP);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (Number.isFinite(raw) && raw <= 0) return 0; // explicit opt-out
  return DEFAULT_EMBED_INPUT_CHAR_CAP;
}

const REQUIRED_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];

const REQUIRED_ONNX_BY_DTYPE = {
  fp32: ['onnx/model.onnx', 'onnx/model.onnx_data'],
  fp16: ['onnx/model_fp16.onnx'],
  q8: ['onnx/model_quantized.onnx'],
};

let extractorPromise = null;
let transformersModulePromise = null;

export function localEmbeddingCacheDir() {
  return process.env.ROBOTDOJO_EMBED_CACHE_DIR
    || join(config.configDir, 'models', 'embeddings');
}

function configureTransformers(mod, { allowRemoteModels = false } = {}) {
  mkdirSync(localEmbeddingCacheDir(), { recursive: true });
  mod.env.cacheDir = localEmbeddingCacheDir();
  mod.env.allowRemoteModels = Boolean(allowRemoteModels);
  mod.env.allowLocalModels = true;
  return mod;
}

async function loadTransformers(opts = {}) {
  if (!transformersModulePromise) {
    transformersModulePromise = import('@huggingface/transformers');
  }
  const mod = await transformersModulePromise;
  return configureTransformers(mod, opts);
}

async function getExtractor(opts = {}) {
  if (!extractorPromise || opts.forceReload) {
    extractorPromise = (async () => {
      const mod = await loadTransformers(opts);
      return mod.pipeline('feature-extraction', LOCAL_EMBED_MODEL_ID, {
        cache_dir: localEmbeddingCacheDir(),
        local_files_only: !opts.allowRemoteModels,
        dtype: LOCAL_EMBED_DTYPE,
        device: 'cpu',
        // st_2cd1af73 AC-3 — bound the ORT CPU session's memory + threads so a
        // long-input batch cannot balloon RSS into the jetsam kill range. See the
        // embedSessionOptions() WHY block above.
        session_options: embedSessionOptions(),
      });
    })();
  }
  return extractorPromise;
}

export function resetLocalEmbedderForTest() {
  extractorPromise = null;
  transformersModulePromise = null;
}

export function normalizeEmbedInput(text, { inputType = 'document' } = {}) {
  // Single chokepoint: every embed path (embedBatch → daemon/bulk, embed/
  // safeEmbed → query, embedLocal) funnels each text through here before the
  // tokenizer runs in embedLocalBatch. Bounding the input HERE caps inference
  // latency for every caller without touching the stored chunk content.
  const cap = embedInputCharCap();
  const trimmed = String(text || '').trim();
  // Truncate the user-content prefix BEFORE adding the query marker so the
  // marker is never counted against (or sliced out of) the cap. Queries are
  // short, so this is a no-op for them; the cap bites on long document chunks.
  const value = cap > 0 && trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
  if (inputType === 'query') return `${LOCAL_EMBED_QUERY_PREFIX}${value}`;
  return value;
}

function validateVector(vec) {
  if (!(vec instanceof Float32Array)) {
    throw new Error('local embedding returned a non-Float32 vector');
  }
  if (vec.length !== LOCAL_EMBED_DIM) {
    throw new Error(`local embedding dimension ${vec.length} != ${LOCAL_EMBED_DIM}`);
  }
  return vec;
}

function tensorToVectors(tensor, expectedRows) {
  const data = tensor?.data;
  const dims = Array.isArray(tensor?.dims) ? tensor.dims : [];
  if (!data) throw new Error('local embedding returned no tensor data');

  const raw = data instanceof Float32Array ? data : Float32Array.from(data);
  const rows = dims.length >= 2 ? dims[0] : expectedRows;
  const dim = dims.length >= 2 ? dims[dims.length - 1] : LOCAL_EMBED_DIM;
  if (dim !== LOCAL_EMBED_DIM) {
    throw new Error(`local embedding tensor dim ${dim} != ${LOCAL_EMBED_DIM}`);
  }
  if (rows !== expectedRows) {
    throw new Error(`local embedding row count ${rows} != ${expectedRows}`);
  }

  const out = [];
  for (let i = 0; i < rows; i++) {
    const start = i * dim;
    out.push(validateVector(new Float32Array(raw.slice(start, start + dim))));
  }
  return out;
}

export async function embedLocalBatch(texts, {
  batchSize = 32,
  signal = null,
  inputType = 'document',
  allowRemoteModels = false,
} = {}) {
  const extractor = await getExtractor({ allowRemoteModels });
  const results = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    const batch = texts.slice(i, i + batchSize).map((text) => normalizeEmbedInput(text, { inputType }));
    const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
    results.push(...tensorToVectors(tensor, batch.length));
  }
  return results;
}

export async function embedLocal(text, opts = {}) {
  const [vec] = await embedLocalBatch([text], { ...opts, batchSize: 1 });
  return vec;
}

export async function prewarmLocalEmbeddingModel({ allowRemoteModels = true } = {}) {
  const queryVec = await embedLocal('robot dojo local query smoke', { inputType: 'query', allowRemoteModels });
  const documentVec = await embedLocal('robot dojo local document smoke', { inputType: 'document', allowRemoteModels });
  return {
    ok: true,
    model: LOCAL_EMBED_MODEL_ID,
    dim: LOCAL_EMBED_DIM,
    dtype: LOCAL_EMBED_DTYPE,
    cacheDir: localEmbeddingCacheDir(),
    queryDim: queryVec.length,
    documentDim: documentVec.length,
  };
}

function hasNonEmptyFile(path) {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function modelDirCandidates(cacheDir = localEmbeddingCacheDir()) {
  return [
    join(cacheDir, LOCAL_EMBED_MODEL_CACHE_SLUG),
    join(cacheDir, 'models--Snowflake--snowflake-arctic-embed-l-v2.0'),
  ];
}

function listMissingFiles(modelDir, dtype = LOCAL_EMBED_DTYPE) {
  const required = [
    ...REQUIRED_MODEL_FILES,
    ...(REQUIRED_ONNX_BY_DTYPE[dtype] || REQUIRED_ONNX_BY_DTYPE.q8),
  ];
  return required.filter((rel) => !hasNonEmptyFile(join(modelDir, rel)));
}

function resolveInstalledModelDir(cacheDir = localEmbeddingCacheDir(), dtype = LOCAL_EMBED_DTYPE) {
  for (const modelDir of modelDirCandidates(cacheDir)) {
    if (!existsSync(modelDir)) continue;
    const missing = listMissingFiles(modelDir, dtype);
    if (!missing.length) return { modelDir, missing };
  }
  const first = modelDirCandidates(cacheDir).find((dir) => existsSync(dir)) || modelDirCandidates(cacheDir)[0];
  return { modelDir: first, missing: listMissingFiles(first, dtype) };
}

export function localEmbeddingModelStatus() {
  const cacheDir = localEmbeddingCacheDir();
  const { modelDir, missing } = resolveInstalledModelDir(cacheDir);
  const installed = missing.length === 0;
  return {
    model: LOCAL_EMBED_MODEL_ID,
    dim: LOCAL_EMBED_DIM,
    dtype: LOCAL_EMBED_DTYPE,
    cacheDir,
    modelDir,
    installed,
    state: installed ? 'installed' : 'missing',
    missing,
    retryable: !installed,
  };
}

export function contentHash(content) {
  return createHash('sha256').update(String(content || '')).digest('hex');
}

export function embeddingSignature({
  content,
  content_hash,
  topic,
  modelId = LOCAL_EMBED_MODEL_ID,
  dim = LOCAL_EMBED_DIM,
  dtype = LOCAL_EMBED_DTYPE,
} = {}) {
  const hash = content_hash || contentHash(content);
  return createHash('sha256')
    .update([hash, topic || '', modelId, String(dim), dtype].join('\n'))
    .digest('hex');
}

export function vectorToBuffer(vec) {
  validateVector(vec);
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
