/**
 * routes/books.js — thin facade for public book-artifact hosting.
 *
 * The single public endpoint the print service fetches: GET
 * /api/books/artifact/:token/:file streams a rendered interior/cover PDF by its
 * unguessable hosting token. Parse → delegate to lib/book-host.js → respond.
 * No database access at all (thin facade). The prefix /api/books/artifact/ is
 * added to PUBLIC_PREFIXES in lib/server.js so Lulu's unauthenticated fetch
 * bypasses the /api/* Bearer gate for this prefix only.
 */
import { Hono } from 'hono';
import { readArtifactForToken } from '../lib/book-host.js';

const routes = new Hono();

routes.get('/api/books/artifact/:token/:file', async (c) => {
  try {
    const artifact = await readArtifactForToken(c.req.param('token'), c.req.param('file'));
    if (!artifact) return c.json({ error: 'artifact_not_found' }, 404);
    return new Response(artifact.buffer, {
      status: 200,
      headers: {
        'content-type': artifact.contentType,
        'content-length': String(artifact.size),
        'cache-control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    return c.json({ error: error?.message || 'artifact_failed' }, 500);
  }
});

export default routes;
