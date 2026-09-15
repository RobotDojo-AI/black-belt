/**
 * routes/content.js — Content API for stable-URL viewer.
 *
 * Mounted at /api/content in index.js.
 * Inherits the global /api/* auth middleware from lib/server.js — no new
 * auth code needed here.
 *
 * All SQL lives in lib/content-queries.js (thin-facade rule).
 */
import { Hono } from 'hono';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import db from '../lib/db.js';
import {
  getPersonByShortId,
  getCompanyByShortId,
  getConversationByShortId,
  getTranscriptByShortId,
  getTopicBySlug,
  buildPersonUrl,
  buildCompanyUrl,
  buildConversationUrl,
  buildTranscriptUrl,
} from '../lib/content-queries.js';
import { topicContextPath, entityContextPath } from '../lib/context-paths.js';
import { writeConversationFile, writeTranscriptFile } from '../lib/transcripts.js';
import { REPO_ROOT } from '../lib/robotdojo-paths.js';
import {
  markViewerCorrectionsChanged,
  readMarkdownDocument,
  writeMarkdownDocument,
} from '../lib/markdown-documents.js';
import { recordViewerCorrection } from '../lib/viewer-corrections.js';

// Resolve a relative-to-repo path (e.g. "user/contexts/…") to an absolute path.
function absPath(relPath) {
  return resolve(REPO_ROOT, relPath);
}

const routes = new Hono();

function docRoutePath(c) {
  return new URL(c.req.url).pathname
    .replace(/^\/api\/content\/docs\/?/, '')
    .replace(/\/$/, '');
}

function docError(c, error) {
  const status = error.status || 500;
  if (status === 400) return c.json({ error: 'invalid_path', message: error.message || 'invalid_path' }, 400);
  if (status === 403) return c.json({ error: 'forbidden_path', message: 'Document path is outside the allowed viewer roots.' }, 403);
  if (status === 404) return c.json({ error: 'not_found', message: 'No markdown document exists for this URL.' }, 404);
  console.warn('[content/docs] failed:', error.message);
  return c.json({ error: 'read_failed', message: error.message || 'Document could not be read.' }, 500);
}

// --- GET/PUT /api/content/docs/* ---
// One markdown document API behind every stable viewer URL:
// /topics/*, /entities/*, /agents/*, /user/*, /workbenches/*, and /docs/*.
routes.get('/docs/*', async (c) => {
  try {
    return c.json(readMarkdownDocument(db, docRoutePath(c)));
  } catch (error) {
    return docError(c, error);
  }
});

routes.put('/docs/*', async (c) => {
  let parsed;
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  try {
    return c.json(writeMarkdownDocument(db, docRoutePath(c), parsed?.body));
  } catch (error) {
    return docError(c, error);
  }
});

// --- POST /api/content/corrections ---
// A viewer correction is a deterministic source event. Chat may mediate the
// wording, but the write is typed and append-only rather than generic RAG text.
routes.post('/corrections', async (c) => {
  let parsed;
  try { parsed = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  try {
    const actor = c.get?.('user')?.id ? 'user' : 'user';
    const result = recordViewerCorrection(db, parsed, { actor });
    markViewerCorrectionsChanged();
    return c.json({
      ok: true,
      inserted: result.inserted,
      eventId: result.eventId,
      correction: result.correction,
    });
  } catch (error) {
    const status = error.status || 500;
    if (status === 400) return c.json({ error: error.message || 'invalid_correction' }, 400);
    console.warn('[content/corrections] failed:', error.message);
    return c.json({ error: 'write_failed', message: error.message || 'Correction could not be recorded.' }, 500);
  }
});

// --- GET /api/content/topics/* ---
// Accepts /topics/work or /topics/work/project (nested slugs via wildcard).
routes.get('/topics/*', async (c) => {
  // c.req.param('*') is unreliable in mounted sub-routers in Hono 4 —
  // extract slug from the URL path directly.
  const slug = new URL(c.req.url).pathname.replace(/^\/api\/content\/topics\//, '').replace(/\/$/, '');
  if (!slug) return c.json({ error: 'slug_required' }, 400);

  const topic = getTopicBySlug(db, slug);
  if (!topic) return c.json({ error: 'not_found' }, 404);

  const relPath = topicContextPath(db, slug);
  const filePath = absPath(relPath);

  let body = null;
  try {
    body = await fs.readFile(filePath, 'utf8');
  } catch {
    // File not yet generated — return null body with 200 so the viewer
    // can show a "No content yet" state (vs. a 404 which implies the
    // topic itself is missing).
    return c.json({ slug: topic.slug, label: topic.label, body: null, reason: 'no_context_file' });
  }

  return c.json({ slug: topic.slug, label: topic.label, body });
});

// --- GET /api/content/people/:shortId ---
routes.get('/people/:shortId', async (c) => {
  const shortId = c.req.param('shortId');
  const rows = getPersonByShortId(db, shortId);
  if (!rows.length) return c.json({ error: 'not_found' }, 404);

  const row = rows[0];
  const { id, display_name } = row;
  const url = buildPersonUrl(id, display_name);

  const contextPath = entityContextPath('person', id, db);
  const entityFilePath = absPath(contextPath);

  let body = null;
  try {
    body = await fs.readFile(entityFilePath, 'utf8');
  } catch {
    // Context file not generated yet — return null body with 200.
  }

  return c.json({ id, displayName: display_name, url, body });
});

// --- GET /api/content/companies/:shortId ---
routes.get('/companies/:shortId', async (c) => {
  const shortId = c.req.param('shortId');
  const rows = getCompanyByShortId(db, shortId);
  if (!rows.length) return c.json({ error: 'not_found' }, 404);

  const row = rows[0];
  const { id, name } = row;
  const url = buildCompanyUrl(id, name);

  const contextPath = entityContextPath('company', id, db);
  const entityFilePath = absPath(contextPath);

  let body = null;
  try {
    body = await fs.readFile(entityFilePath, 'utf8');
  } catch {
    // Context file not generated yet — null body, 200.
  }

  return c.json({ id, name, url, body });
});

// --- GET /api/content/conversations/:shortId ---
routes.get('/conversations/:shortId', async (c) => {
  const shortId = c.req.param('shortId');
  const rows = getConversationByShortId(db, shortId);
  if (!rows.length) return c.json({ error: 'not_found' }, 404);

  const row = rows[0];
  const { id, title } = row;
  const url = buildConversationUrl(id, title);
  const metadataOnly = c.req.query('resolve') === '1' || c.req.query('body') === '0';
  if (metadataOnly) return c.json({ id, title, url });

  // Generate the file on demand if it has not been written yet.
  let filePath = row.file_path;
  if (!filePath) {
    filePath = await writeConversationFile(id);
  }

  let body = null;
  if (filePath) {
    try {
      body = await fs.readFile(filePath, 'utf8');
    } catch {
      // File write raced or failed — return null body gracefully.
    }
  }

  return c.json({ id, title, url, body });
});

// --- GET /api/content/transcripts/:shortId ---
routes.get('/transcripts/:shortId', async (c) => {
  const shortId = c.req.param('shortId');
  const rows = getTranscriptByShortId(db, shortId);
  if (!rows.length) return c.json({ error: 'not_found' }, 404);

  const row = rows[0];
  const { id, title } = row;
  const url = buildTranscriptUrl(id, title);

  // Generate the file on demand if it has not been written yet.
  let filePath = row.file_path;
  if (!filePath) {
    filePath = await writeTranscriptFile(row);
  }

  let body = null;
  if (filePath) {
    try {
      body = await fs.readFile(filePath, 'utf8');
    } catch {
      // File write raced or failed — return null body gracefully.
    }
  }

  return c.json({ id, title, url, body });
});

export default routes;
