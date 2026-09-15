/**
 * LLM provider interface (st_74f45a1a R2 amendment).
 *
 * One shared contract that every provider implements:
 *
 *   provider.streamChat({messages, system, tools, model, cache, signal})
 *     → AsyncGenerator<{type:'delta'|'tool_start'|'tool_done', ...}>
 *
 *   provider.complete({messages, system, tools, model, cache, signal})
 *     → Promise<{content, usage, model, stop_reason}>
 *
 * Why an interface, not a base class: providers diverge in their SDK shape
 * (Anthropic uses .messages.stream/.create, OpenAI uses chat.completions,
 * Google uses generateContent, and Ollama is NDJSON).
 * The shared surface is the only thing that matters to the caller — the
 * implementations are dispatch + translation, nothing more.
 *
 * `model` is a logical tier (`'fast' | 'balanced' | 'best'`), NOT a model
 * ID. Each provider resolves the tier to its own model name. This is what
 * makes the abstraction load-bearing: callers stop carrying model strings.
 *
 * `cache` is a hint, not a guarantee:
 *   - 'system'       → mark the system prompt as cacheable (provider-specific)
 *   - 'system+tools' → same plus tool definitions
 *   - null           → no caching
 * Providers that auto-cache (OpenAI) treat all values as no-op. Providers
 * with no cache support (Ollama) treat all values as no-op.
 */

/**
 * @typedef {Object} ChatMessage
 * @property {'user'|'assistant'|'system'} role
 * @property {string|Array<{type:string, text?:string, source?:object, [k:string]:any}>} content
 */

/**
 * @typedef {Object} SystemBlock
 * @property {'text'} type
 * @property {string} text
 * @property {{type:'ephemeral'}} [cache_control]
 */

/**
 * @typedef {Object} StreamChatArgs
 * @property {ChatMessage[]} messages
 * @property {string | SystemBlock[]} [system] - String OR array of cacheable blocks
 * @property {Array} [tools]
 * @property {'fast'|'balanced'|'best'|string} [model] - Logical tier OR a concrete model id
 * @property {'system'|'system+tools'|null} [cache] - Prompt-cache hint
 * @property {AbortSignal} [signal] - Cancellation
 * @property {number} [max_tokens]
 * @property {number} [timeout_ms] - Optional per-call request timeout for long-form synthesis
 */

/**
 * @typedef {Object} StreamEvent
 * @property {'delta'|'tool_start'|'tool_done'} type
 * @property {string} [text]
 * @property {string} [name]
 * @property {object} [args]
 * @property {object} [result]
 */

/**
 * @typedef {Object} CompleteResult
 * @property {Array<{type:'text',text:string} | {type:'tool_use', name:string, input:object, id:string}>} content
 * @property {object} usage - { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }
 * @property {string} model - The actual model id that served the request
 * @property {string} stop_reason
 */

/**
 * @typedef {Object} Provider
 * @property {string} name - 'anthropic' | 'openai' | 'google' | 'ollama'
 * @property {(args: StreamChatArgs) => AsyncGenerator<StreamEvent>} streamChat
 * @property {(args: StreamChatArgs) => Promise<CompleteResult>} complete
 */

// This file is intentionally documentation-only. The actual contract is
// type-checked by the unit tests in tests/llm/*.test.js — each provider
// test calls the three methods with a mock client and asserts the shape.

export const PROVIDER_INTERFACE_KEYS = Object.freeze(['name', 'streamChat', 'complete']);
