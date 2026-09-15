/**
 * lib/referral/path-c-keywords.js — st_b879a361
 *
 * Path C — weighted AI/tech-content intelligence filter. Cumulative weight
 * across all match occurrences in the input text. Threshold for qualification
 * is ≥ 3 (default).
 *
 * WEIGHTS
 *   3 — specific jargon: RAG, MCP, foundation model, embeddings,
 *       RLHF, Hugging Face, Claude Code, Cursor, vibe coding, gbrain,
 *       Anthropic, OpenAI, local model, agentic, tool use, function calling,
 *       prompt engineering, model weights, LoRA, quantization, vector
 *       database/store/search, retrieval-augmented.
 *   2 — mid-signal: LLM, large language model, GPT, ChatGPT, Claude,
 *       open-source, inference, tokenize, agent.
 *   1 — casual: \bAI\b.
 *
 * QUALIFICATION
 *   scorePathCSignal(text) returns cumulative weight across ALL match
 *   occurrences (not just per-keyword presence — three "AI" mentions counts
 *   as weight 3 and qualifies).
 *
 *   hasPathCSignal(text, threshold = 3) returns score >= threshold.
 *
 * RATIONALE
 *   v0 ships weight=3 threshold knowing some false positives will leak.
 *   Raise to 5 in v1 if needed. Documented in 00-scope's "Out of scope".
 */

// Order doesn't affect correctness (we count all matches), but keeping
// weight 3 first makes the file readable.
export const WEIGHTED_KEYWORDS = [
  // ─── weight 3 — specific jargon ──────────────────────────────────────
  { regex: /\bRAG\b/gi,                                     weight: 3, label: 'RAG' },
  { regex: /\bMCP\b/gi,                                     weight: 3, label: 'MCP' },
  { regex: /\bfoundation\s+models?\b/gi,                    weight: 3, label: 'foundation-model' },
  { regex: /\bretrieval[\s-]augmented\b/gi,                 weight: 3, label: 'retrieval-augmented' },
  { regex: /\bembeddings?\b/gi,                             weight: 3, label: 'embeddings' },
  { regex: /\bvector\s+(?:database|store|search|db)\b/gi,   weight: 3, label: 'vector-db' },
  { regex: /\bRLHF\b/gi,                                    weight: 3, label: 'RLHF' },
  { regex: /\bHugging\s+Face\b/gi,                          weight: 3, label: 'huggingface' },
  { regex: /\bClaude\s+Code\b/gi,                           weight: 3, label: 'claude-code' },
  { regex: /\bCursor\b/gi,                                  weight: 3, label: 'cursor' },
  { regex: /\bvibe\s+coding\b/gi,                           weight: 3, label: 'vibe-coding' },
  { regex: /\bgbrain\b/gi,                                  weight: 3, label: 'gbrain' },
  { regex: /\bmodel\s+weights\b/gi,                         weight: 3, label: 'model-weights' },
  { regex: /\bLoRA\b/gi,                                    weight: 3, label: 'lora' },
  { regex: /\bquantiz(?:e|ed|ation)\b/gi,                   weight: 3, label: 'quantize' },
  { regex: /\bAnthropic\b/gi,                               weight: 3, label: 'anthropic' },
  { regex: /\bOpenAI\b/gi,                                  weight: 3, label: 'openai' },
  { regex: /\blocal\s+models?\b/gi,                         weight: 3, label: 'local-model' },
  { regex: /\bagentic\b/gi,                                 weight: 3, label: 'agentic' },
  { regex: /\btool\s+(?:use|calling)\b/gi,                  weight: 3, label: 'tool-use' },
  { regex: /\bfunction\s+calling\b/gi,                      weight: 3, label: 'function-calling' },
  { regex: /\bprompt\s+(?:engineering|chaining)\b/gi,       weight: 3, label: 'prompt-eng' },
  { regex: /\btokens?[\/\s]sec\b/gi,                        weight: 3, label: 'tokens-per-sec' },

  // ─── weight 2 — mid-signal ───────────────────────────────────────────
  { regex: /\bLLMs?\b/gi,                                   weight: 2, label: 'llm' },
  { regex: /\blarge\s+language\s+models?\b/gi,              weight: 2, label: 'large-language-model' },
  { regex: /\bGPT\b/gi,                                     weight: 2, label: 'gpt' },
  { regex: /\bChatGPT\b/gi,                                 weight: 2, label: 'chatgpt' },
  { regex: /\bClaude\b/gi,                                  weight: 2, label: 'claude' },
  { regex: /\bopen[\s-]source\b/gi,                         weight: 2, label: 'open-source' },
  { regex: /\binference\b/gi,                               weight: 2, label: 'inference' },
  { regex: /\btokeniz(?:e|ation|ed|er)\b/gi,                weight: 2, label: 'tokenize' },
  { regex: /\bagents?\b/gi,                                 weight: 2, label: 'agent' },

  // ─── weight 1 — casual ──────────────────────────────────────────────
  { regex: /\bAI\b/g,                                       weight: 1, label: 'ai' },
];

/**
 * Sum the weight of ALL match occurrences in `text` across all keywords.
 * Counts repeated occurrences (three "AI" mentions = weight 3).
 *
 * Note on overlap: "Claude Code" matches both the weight-3 'claude-code'
 * regex AND the weight-2 'claude' regex. Both fire, giving total weight 5
 * for one mention. This is intentional — a Claude Code mention is at least
 * as strong as a Claude mention plus the specific tool.
 *
 * @param {string} text
 * @returns {number} cumulative weight
 */
export function scorePathCSignal(text) {
  if (!text || typeof text !== 'string') return 0;
  let score = 0;
  for (const { regex, weight } of WEIGHTED_KEYWORDS) {
    // Reset lastIndex — these are global regexes shared across calls.
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (matches) score += matches.length * weight;
  }
  return score;
}

/**
 * @param {string} text
 * @param {number} threshold — default 3
 * @returns {boolean}
 */
export function hasPathCSignal(text, threshold = 3) {
  return scorePathCSignal(text) >= threshold;
}
