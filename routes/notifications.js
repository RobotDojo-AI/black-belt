/**
 * Notifications routes.
 *
 * GET /api/notifications         — SSE stream of real-time watcher events
 * GET /api/notifications/pending — REST, returns unresolved file errors for page-load hydration
 *
 * WHY SSE + REST: SSE is ephemeral (lost on disconnect); REST hydration ensures
 * notifications survive page reload. Together they cover both the real-time and
 * persistent cases without WebSockets or a dedicated polling loop.
 */

import { Hono } from 'hono';
import { events } from '../lib/drop-folder/watcher.js';
import db from '../lib/db.js';
import { validateToken } from '../lib/auth.js';
import { listPendingErrors } from '../lib/notifications-queries.js';

const app = new Hono();

// GET /api/notifications/pending — called on page load to hydrate the notification panel.
// Returns the current set of needs_user files so the UI can show them on load.
app.get('/pending', (c) => {
  const authHeader = c.req.header('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!c.get('user') && !validateToken(bearerToken)) return c.json({ error: 'unauthorized' }, 401);
  const errors = listPendingErrors(db);
  return c.json({ notifications: errors.map(row => ({
    type: 'file_error',
    name: row.original_name,
    reason: row.error_message,
    at: row.processed_at,
    path: row.path,
  }))});
});

// GET /api/notifications — SSE stream for real-time drop-folder events.
// Subscribes to watcher.events and forwards file_errored / file_processed events.
// WHY SSE not WebSockets: SSE is unidirectional (server → client), which is all
// we need. SSE auto-reconnects on disconnect. No binary protocol needed.
app.get('/', (c) => {
  if (!c.get('user') && !validateToken(c.req.query('token') || '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  let aborted = false;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  function write(data) {
    if (aborted) return;
    writer.write(encoder.encode(data)).catch(() => {});
  }

  // Send a heartbeat comment every 25s to keep the connection alive through
  // proxies that close idle connections.
  const heartbeat = setInterval(() => {
    write(': heartbeat\n\n');
  }, 25_000);

  const handler = (evt) => {
    if (evt.type !== 'file_errored' && evt.type !== 'file_processed') return;
    write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  events.on('event', handler);
  write(': connected\n\n');

  // Detect client disconnect and clean up.
  c.req.raw.signal?.addEventListener('abort', () => {
    aborted = true;
    clearInterval(heartbeat);
    events.off('event', handler);
    writer.close().catch(() => {});
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering for SSE
    },
  });
});

export default app;
