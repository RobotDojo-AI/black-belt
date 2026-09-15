#!/usr/bin/env node

// Prewarm the local RAG embedding model at install time so the first chat has
// personal grounding without a runtime download. The runtime dtype is q8
// (quantized) — prewarmLocalEmbeddingModel pulls onnx/model_quantized.onnx into
// the local cache. WHY no fp32 external-data path: the fp32 graph references a
// separate ~2.2 GB model.onnx_data file, but the runtime never selects fp32
// (EMBED_DTYPE is q8), so that download branch was dead weight and is gone.

import {
  EMBED_DIM,
  EMBED_DTYPE,
  EMBED_MODEL,
  localEmbeddingCacheDir,
  prewarmLocalEmbeddingModel,
} from '../../lib/rag.js';

const offline = process.argv.includes('--offline');

try {
  const result = await prewarmLocalEmbeddingModel({ allowRemoteModels: !offline });
  console.log(JSON.stringify({
    ok: true,
    model: result.model,
    dim: result.dim,
    dtype: result.dtype,
    cacheDir: result.cacheDir,
  }));
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    dtype: EMBED_DTYPE,
    cacheDir: localEmbeddingCacheDir(),
    offline,
    error: err.message,
  }));
  process.exit(1);
}
