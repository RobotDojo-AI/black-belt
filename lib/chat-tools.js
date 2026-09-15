/**
 * Chat-as-IDE: public facade. The implementation lives in lib/chat-tools/,
 * split into one file per White Belt tool plus the shared registry.
 *
 * Callers (lib/chat.js, routes/chat.js) import from './chat-tools.js' — this
 * file re-exports the public API so those import paths keep working without
 * modification.
 *
 * Black Belt tools live under lib/chat-tools/black/ and are runtime-gated by
 * cohort entitlement. This facade stays tiny so old imports keep working.
 */
export { getToolSchemas, executeTool, getToolCount } from './chat-tools/index.js';
