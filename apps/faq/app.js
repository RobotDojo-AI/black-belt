/**
 * apps/faq/app.js — entry point for the public /faq surface (st_85ca4f3c).
 *
 * Mirrors apps/chat/app.js shape (entry-point file imports the app module),
 * but the faq surface has no authed path — there is only public-chat mode.
 * No /api/whoami, no /api/admin/belt, no /api/conversations, no /api/models,
 * no /api/preferences, no /api/labels, no warmup. The page fires exactly one
 * endpoint (/api/public-chat/stream) once on load to render the opening
 * assistant summary, and then once per user follow-up.
 *
 * The chat app's app.js is the orchestrator that wires keyboard shortcuts,
 * sidebar conversation lists, the global topbar, drop-folder events, and
 * secure-input — all authed-only. faq strips every one of those.
 */
import { initPublicChat } from './public-app.js';

initPublicChat();
