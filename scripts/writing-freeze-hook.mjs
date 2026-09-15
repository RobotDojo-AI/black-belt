#!/usr/bin/env node
/**
 * Coding-agent writing freeze hook (Claude / Grok / Cursor / Codex).
 *
 * Frozen writing is the web/mobile product path (`lib/chat.js` streamFrozenTurn).
 * Coding-agent hosts already inline voice at session open. This hook used to
 * generate a second reply with no tools and Stop-block until the live agent
 * pasted that invented body. Those FROZEN dumps are not the work.
 *
 * No-op: drain stdin, write nothing, exit 0.
 */
for await (const _ of process.stdin) { /* drain so the host does not SIGPIPE */ }
process.exit(0);
