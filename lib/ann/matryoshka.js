import { EMBED_DIM } from '../rag.js';

/**
 * ANN vector normalization for local Snowflake embeddings. Snowflake is the
 * only embedding model, and the quality-first policy indexes the full vector.
 */
export const HNSW_DIMS = EMBED_DIM;

export function normalizeForHnsw(vec) {
  if (!(vec instanceof Float32Array)) {
    throw new TypeError('normalizeForHnsw: expected Float32Array');
  }
  if (vec.length !== HNSW_DIMS) {
    throw new RangeError(
      `normalizeForHnsw: input length ${vec.length} != HNSW_DIMS ${HNSW_DIMS}`,
    );
  }
  const out = new Float32Array(HNSW_DIMS);
  let sumSq = 0;
  for (let i = 0; i < HNSW_DIMS; i++) {
    const v = vec[i];
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) return out;
  const inv = 1 / norm;
  for (let i = 0; i < HNSW_DIMS; i++) out[i] *= inv;
  return out;
}
