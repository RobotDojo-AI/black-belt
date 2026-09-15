/**
 * Application-layer event bus.
 *
 * st_566ad80b. A single named EventEmitter that decouples application
 * concerns from each other — the warmup module subscribes to
 * 'model-change', the route that updates the user's default chat model
 * emits 'model-change'. No imports between them.
 *
 * WHY a singleton EventEmitter, not a per-feature one:
 *   - One import path, one mental model.
 *   - Events that don't have a subscriber are silently dropped (the
 *     default EventEmitter behavior), so adding/removing listeners is
 *     non-fatal.
 *   - The cost is a global mutable handle, but the surface area is
 *     small (3–5 events expected through launch) and the alternative
 *     (DI-pass an emitter everywhere) is overkill for this scale.
 *
 * Conventions for event names:
 *   - kebab-case, present tense ('model-change', not 'modelChanged').
 *   - First arg is always a structured payload object, never positional.
 *
 * Documented events (keep this list current):
 *
 *   'model-change'   payload: { provider, model, prev_model, source }
 *     Fired when the user's default chat model changes. lib/warmup.js
 *     subscribes and fires a warmup ping for the new provider within
 *     100 ms (AC 10).
 *
 *   'memory-context-change' payload: { kind, target_type, target_id, source }
 *     Fired after append-only memory events or projection watermarks change.
 *     lib/chat-context.js clears its layered-context cache so fresh memory
 *     can reach the next chat turn immediately.
 */

import { EventEmitter } from 'node:events';

// WHY default maxListeners > 10: with multiple subscribers (warmup,
// future analytics hooks, future cache invalidators), the 10-default
// fires a warning we don't need. 50 is generous and not load-bearing.
export const appEvents = new EventEmitter();
appEvents.setMaxListeners(50);
