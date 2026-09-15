/**
 * Proxy routes — backward compat redirects and new two-segment routing.
 *
 * /me/:slug/* — 301 redirect to new-form URL (backward compat for bookmarks).
 * /:servername/:handle/* — 302 proxy to {handle}.robotdojo.ai (direct relay access).
 *
 * Most production traffic flows through Vercel middleware, not here.
 * These handlers cover the case where requests reach the gateway directly.
 */
import { Hono } from 'hono';

export function proxyRoutes() {
  const app = new Hono();

  // Legacy /me/:slug/* → 301 redirect to the apex domain (no user-prefix
  // since the gateway doesn't know the servername for old URLs).
  app.all('/me/:slug/*', (c) => {
    const slug = c.req.param('slug');
    const full = c.req.path;
    const subpath = full.slice(`/me/${slug}`.length) || '/';
    const rawUrl = c.req.raw.url;
    const searchPart = rawUrl.includes('?') ? '?' + new URL(rawUrl).search.slice(1) : '';
    return c.redirect(`https://robotdojo.ai${subpath}${searchPart}`, 301);
  });

  app.all('/me/:slug', (c) =>
    c.redirect(`https://robotdojo.ai/`, 301));

  // New: /:servername/:handle/* — proxy to handle.robotdojo.ai.
  // The :servername segment (user_slug) is included for the canonical URL shape
  // but the gateway only needs :handle for routing.
  app.all('/:servername/:handle/*', (c) => {
    const handle = c.req.param('handle');
    const full = c.req.path;
    const parts = full.split('/').slice(3); // skip /:servername/:handle
    const subpath = '/' + parts.join('/');
    const rawUrl = c.req.raw.url;
    const searchPart = rawUrl.includes('?') ? '?' + new URL(rawUrl).search.slice(1) : '';
    return c.redirect(`https://${handle}.robotdojo.ai${subpath}${searchPart}`, 302);
  });

  return app;
}
