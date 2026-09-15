/**
 * Drop-folder files API.
 *
 *   GET  /api/files?topic_t1=&topic_t2=&doc_type=&limit=
 *   GET  /api/files/search?q=
 *   GET  /api/files/download?path=<abs path>
 *   POST /api/files/reclassify { path, new_topic_t1, new_topic_t2 }
 *
 * Auth: all routes require a logged-in session (`c.get('user')` must be set
 * by the auth middleware). The downloaded-path argument is validated against
 * managed Robot Dojo file roots to prevent arbitrary file reads.
 */

import { stat, rename, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { Hono } from 'hono';
import {
  listFiles, searchFiles, getByPath, relocate,
} from '../lib/drop-folder/index-db.js';
import { DROP_ROOT, USERFILES_ROOT, ontologyPath } from '../lib/drop-folder/paths.js';

const routes = new Hono();

// --- Helpers ----------------------------------------------------------------

function requireUser(c) {
  const user = c.get('user');
  if (!user) return null;
  return user;
}

function isInsideRoot(absPath, root) {
  const rel = resolve(absPath);
  const base = resolve(root);
  return rel === base || rel.startsWith(base + '/');
}

function isInsideManagedFileRoot(absPath) {
  return isInsideRoot(absPath, DROP_ROOT) || isInsideRoot(absPath, USERFILES_ROOT);
}

const MIME_BY_EXT = {
  '.pdf':  'application/pdf',
  '.csv':  'text/csv',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.txt':  'text/plain',
  '.json': 'application/json',
  '.eml':  'message/rfc822',
};

function mimeFor(path) {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME_BY_EXT[path.slice(dot).toLowerCase()] || 'application/octet-stream';
}

// --- Routes ----------------------------------------------------------------

routes.get('/api/files', (c) => {
  if (!requireUser(c)) return c.json({ error: 'unauthenticated' }, 401);
  const rows = listFiles({
    topic_t1: c.req.query('topic_t1') || undefined,
    topic_t2: c.req.query('topic_t2') || undefined,
    doc_type: c.req.query('doc_type') || undefined,
    limit: Math.min(parseInt(c.req.query('limit') || '100'), 500),
  });
  return c.json({ files: rows, count: rows.length });
});

routes.get('/api/files/search', (c) => {
  if (!requireUser(c)) return c.json({ error: 'unauthenticated' }, 401);
  const q = c.req.query('q') || '';
  if (!q.trim()) return c.json({ files: [], count: 0 });
  const rows = searchFiles(q, { limit: Math.min(parseInt(c.req.query('limit') || '25'), 100) });
  return c.json({ files: rows, count: rows.length });
});

routes.get('/api/files/download', async (c) => {
  if (!requireUser(c)) return c.json({ error: 'unauthenticated' }, 401);
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path_required' }, 400);

  const resolved = resolve(path);
  if (!isInsideManagedFileRoot(resolved)) return c.json({ error: 'forbidden' }, 403);
  const row = getByPath(resolved);
  if (!row) return c.json({ error: 'not_found' }, 404);
  let info;
  try { info = await stat(resolved); }
  catch { return c.json({ error: 'not_found' }, 404); }

  // Stream it back. Hono/node-server accepts a Web ReadableStream as body.
  const nodeStream = createReadStream(resolved);
  const body = new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(chunk));
      nodeStream.on('end',   () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() { nodeStream.destroy(); },
  });

  return new Response(body, {
    headers: {
      'content-type': mimeFor(resolved),
      'content-length': String(info.size),
      'content-disposition': `attachment; filename="${basename(resolved).replace(/"/g, '')}"`,
    },
  });
});

routes.post('/api/files/reclassify', async (c) => {
  if (!requireUser(c)) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const { file_path, new_topic_t1, new_topic_t2 } = body || {};
  if (!file_path) return c.json({ error: 'file_path_required' }, 400);
  const src = resolve(file_path);
  if (!isInsideManagedFileRoot(src)) return c.json({ error: 'forbidden' }, 403);

  const row = getByPath(src);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const dst = ontologyPath({
    t1: new_topic_t1, t2: new_topic_t2,
    filename: basename(src),
  });

  if (!isInsideRoot(dst, USERFILES_ROOT)) {
    return c.json({ error: 'forbidden', hint: 'destination resolves outside user files root' }, 403);
  }

  try {
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
  } catch (err) {
    return c.json({ error: 'move_failed', message: err.message }, 500);
  }

  relocate(src, dst);

  // Update the topic columns on the moved row.
  const updated = getByPath(dst);
  if (updated) {
    updated.topic_t1 = new_topic_t1 || null;
    updated.topic_t2 = new_topic_t2 || null;
    const { upsertFile } = await import('../lib/drop-folder/index-db.js');
    upsertFile(updated);
  }

  return c.json({ ok: true, path: dst });
});
export default routes;
