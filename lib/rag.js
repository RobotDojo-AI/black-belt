/**
 * Local RAG embeddings.
 *
 * Embeddings are a $0 local substrate capability. Product runtime must not
 * call paid embedding APIs.
 */
import {
  LOCAL_EMBED_DIM,
  LOCAL_EMBED_DTYPE,
  LOCAL_EMBED_MODEL_ID,
  contentHash,
  embedLocal,
  embedLocalBatch,
  embeddingSignature,
  localEmbeddingCacheDir,
  localEmbeddingModelStatus,
  normalizeEmbedInput,
  prewarmLocalEmbeddingModel,
  resetLocalEmbedderForTest,
  vectorToBuffer,
} from './rag/local-embed.js';

export const EMBED_DIM = LOCAL_EMBED_DIM;
export const EMBED_MODEL = LOCAL_EMBED_MODEL_ID;
export const EMBED_DTYPE = LOCAL_EMBED_DTYPE;
export const CHUNK_SIZE = 1500;

const breaker = {
  failures: 0,
  threshold: 3,
  resetAfterMs: 60000,
  lastFailure: 0,
  state: 'closed',
};

export function isCircuitOpen() {
  if (breaker.state === 'closed') return false;
  if (Date.now() - breaker.lastFailure > breaker.resetAfterMs) {
    breaker.state = 'half-open';
    return false;
  }
  return true;
}

export function recordSuccess() {
  breaker.failures = 0;
  breaker.state = 'closed';
}

export function recordFailure() {
  breaker.failures++;
  breaker.lastFailure = Date.now();
  if (breaker.failures >= breaker.threshold) {
    breaker.state = 'open';
    console.warn(`[rag] local embedding unavailable — FTS-only for ${Math.round(breaker.resetAfterMs / 1000)}s`);
  }
}

export function getCircuitState() {
  return breaker.state;
}

export async function embed(text, options = {}) {
  return embedLocal(text, {
    inputType: options.inputType || 'document',
    allowRemoteModels: options.allowRemoteModels === true,
  });
}

// Test seam — mirrors _setEmbedBatchOverride for the single-query embed path.
// searchAll() calls safeEmbed() directly; this lets a hermetic test drive the
// HNSW search path with a deterministic query vector without loading the 2GB
// ONNX model. Production code never sets this. Returns a Float32Array or null.
let _testSafeEmbedOverride = null;
export function _setSafeEmbedOverride(fn) {
  _testSafeEmbedOverride = fn;
}

export async function safeEmbed(text, options = {}) {
  if (_testSafeEmbedOverride) {
    return _testSafeEmbedOverride(text, options);
  }
  if (isCircuitOpen()) return null;
  try {
    const vec = await embed(text, options);
    recordSuccess();
    return vec;
  } catch (err) {
    recordFailure();
    console.error('[rag] Local embedding failed:', err.message);
    return null;
  }
}

let _testEmbedBatchOverride = null;
export function _setEmbedBatchOverride(fn) {
  _testEmbedBatchOverride = fn;
}

export async function embedBatch(texts, batchSize = 32, signal = null, options = {}) {
  if (_testEmbedBatchOverride) {
    return _testEmbedBatchOverride(texts, batchSize, signal, options);
  }
  return embedLocalBatch(texts, {
    batchSize,
    signal,
    inputType: options.inputType || 'document',
    allowRemoteModels: options.allowRemoteModels === true,
  });
}

export {
  contentHash,
  embeddingSignature,
  localEmbeddingCacheDir,
  localEmbeddingModelStatus,
  normalizeEmbedInput,
  prewarmLocalEmbeddingModel,
  resetLocalEmbedderForTest,
  vectorToBuffer,
};

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = (normA * normB) ** 0.5;
  return denom === 0 ? 0 : dot / denom;
}
