import config from '../config.js';

export const LOCAL_EMBED_PRICE_USD_PER_MILLION = 0;

const PAID_EMBED_BUDGET_USD = 0;

export class EmbeddingBudgetError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'EmbeddingBudgetError';
    this.status = status;
  }
}

export function getEmbedBudgetUsd() {
  void config.costs?.maxEmbedSpend;
  return PAID_EMBED_BUDGET_USD;
}

function shouldBypassEmbedBudgetForTest() {
  return process.env.NODE_ENV === 'test'
    && process.env.ROBOTDOJO_ENFORCE_EMBED_BUDGET_IN_TEST !== '1';
}

export function estimateEmbeddingTokens(texts) {
  const chars = texts.reduce((sum, text) => sum + String(text || '').length, 0);
  return Math.ceil(chars / 3);
}

export function estimateEmbeddingCostMicroUsd(tokens) {
  void tokens;
  return 0;
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

export function currentEmbeddingSpendMicroUsd(database = null) {
  if (!database) return 0;
  const row = database.prepare(`
    SELECT COALESCE(SUM(estimated_cost_micro_usd), 0) AS spend
    FROM embedding_usage_ledger
    WHERE strftime('%Y-%m', created_at) = ?
  `).get(currentMonthKey());
  return Number(row?.spend || 0);
}

export function embeddingBudgetStatus({ texts = [], database = null } = {}) {
  const budgetUsd = getEmbedBudgetUsd();
  const budgetMicroUsd = Math.floor(budgetUsd * 1_000_000);
  const spentMicroUsd = currentEmbeddingSpendMicroUsd(database);
  const estimatedTokens = estimateEmbeddingTokens(texts);
  const estimatedCostMicroUsd = estimateEmbeddingCostMicroUsd(estimatedTokens);
  const projectedMicroUsd = spentMicroUsd + estimatedCostMicroUsd;

  return {
    enabled: budgetMicroUsd > 0,
    allowed: budgetMicroUsd > 0 && projectedMicroUsd <= budgetMicroUsd,
    budgetUsd,
    budgetMicroUsd,
    spentMicroUsd,
    estimatedTokens,
    estimatedCostMicroUsd,
    projectedMicroUsd,
    priceUsdPerMillion: LOCAL_EMBED_PRICE_USD_PER_MILLION,
  };
}

export function assertEmbeddingBudget(texts, opts = {}) {
  if (shouldBypassEmbedBudgetForTest()) {
    return embeddingBudgetStatus({ ...opts, texts });
  }
  const status = embeddingBudgetStatus({ ...opts, texts });
  if (!status.enabled) {
    throw new EmbeddingBudgetError(
      'paid embeddings disabled by $0 embedding policy',
      status,
    );
  }
  if (!status.allowed) {
    throw new EmbeddingBudgetError(
      `embedding budget exceeded: projected $${(status.projectedMicroUsd / 1_000_000).toFixed(4)} > $${status.budgetUsd.toFixed(2)}`,
      status,
    );
  }
  return status;
}

export function recordEmbeddingSpend({
  texts,
  topic = null,
  chunkCount = texts.length,
  provider = 'local',
  model = 'Snowflake/snowflake-arctic-embed-l-v2.0',
  database = null,
} = {}) {
  const estimatedTokens = estimateEmbeddingTokens(texts);
  const estimatedCostMicroUsd = estimateEmbeddingCostMicroUsd(estimatedTokens);
  if (!database) return { estimatedTokens, estimatedCostMicroUsd };
  database.prepare(`
    INSERT INTO embedding_usage_ledger
      (provider, model, topic, chunk_count, estimated_tokens, estimated_cost_micro_usd)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(provider, model, topic, chunkCount, estimatedTokens, estimatedCostMicroUsd);
  return { estimatedTokens, estimatedCostMicroUsd };
}
