/**
 * /api/identity/* — identity card projection + export status endpoints
 * backing the account-page Identity section (2.7a).
 *
 * Source of truth is the hash-chained identity log under ~/robotdojo/user/memory/.
 * These are read endpoints only — edits happen via the chat tools
 * (update_identity_section, set_export_target, run_identity_export).
 */

import { getCookie } from 'hono/cookie';
import { Hono } from 'hono';
import { currentSnapshot, DEFAULT_SECTIONS, SECTION_LABELS, sectionHistory, appendIdentitySection } from '../lib/identity-log.js';
import { statusForUi, exportAll, updateTarget } from '../lib/identity-export.js';
import { getAdapter } from '../lib/identity-targets/index.js';
import { renameDevice } from '../lib/device-rename.js';
import { renameHandle } from '../lib/handle-rename.js';
import { claimSlugAtRelay, releaseSlugAtRelay } from '../lib/relay-client.js';
import db from '../lib/db.js';
import {
  getAdminDeviceName,
  getAdminId,
  getAdminProfile,
  insertPendingRename,
  getPendingRename,
  executeDeviceRenameTransaction,
} from '../lib/identity-queries.js';
import { readUserSetting, writeUserSetting } from '../lib/setup-queries.js';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateSlug } from '../lib/reserved-slugs.js';
import config from '../lib/config.js';
import { COOKIE_NAME, sessionIdFromCookie } from '../lib/session.js';
import {
  readInstalledDeviceName,
  repairGeneratedDeviceSlug,
  resolveLoginServerName,
  slugFromDeviceLabel,
} from '../lib/device-name.js';

const routes = new Hono();

// Verb-questions per card — the UX subtitle in the account view.
const CARD_VERB = {
  identity: 'Who am I?',
  soul: 'How do I act?',
  philosophy: 'How do I reason?',
  style: 'How do I speak?',
  user: 'Who am I talking to?',
};

// Only the 5 MECE defaults surface to the user. Custom sections and
// system-level sections both hide — custom because the 5 cards are complete
// by definition (per feedback memory `no-custom-identity-cards`), system
// because those rules are platform-enforced not user-authored.
// Log entries for hidden sections stay in the chain for audit.

// Which group each default card belongs to (subject grouping).
const CARD_GROUP = {
  identity:   'your-ai',
  soul:       'your-ai',
  philosophy: 'your-ai',
  style:      'your-ai',
  user:       'you',
};

routes.get('/api/identity/snapshot', async (c) => {
  const snap = await currentSnapshot();
  const visibleOrder = snap.order.filter((s) => DEFAULT_SECTIONS.includes(s));
  const cards = visibleOrder.map((slug) => {
    const s = snap.sections[slug] || {};
    const label = SECTION_LABELS[slug] ||
      slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return {
      slug,
      label,
      verb: CARD_VERB[slug] || null,
      group: CARD_GROUP[slug] || 'your-ai',
      body: s.body || '',
      updatedAt: s.updatedAt || null,
      author: s.author || null,
      sourceName: s.sourceName || null,
      bytes: Buffer.byteLength(s.body || '', 'utf8'),
      empty: !s.body || !s.body.trim(),
    };
  });
  const groups = [
    { id: 'your-ai', label: 'Your AI', subtitle: 'Who Miyagi is, and how they act, reason, and speak with you.' },
    { id: 'you',     label: 'You',     subtitle: 'What Miyagi knows about you — the timeless essentials.' },
  ];
  return c.json({ order: visibleOrder, cards, groups });
});

routes.get('/api/identity/section/:slug', async (c) => {
  const slug = c.req.param('slug').toLowerCase();
  const snap = await currentSnapshot();
  const s = snap.sections[slug];
  if (!s) return c.json({ error: `no section "${slug}"` }, 404);
  const history = await sectionHistory(slug);
  return c.json({
    slug,
    label: SECTION_LABELS[slug] || slug,
    verb: CARD_VERB[slug] || null,
    body: s.body || '',
    updatedAt: s.updatedAt,
    author: s.author,
    sourceName: s.sourceName,
    historyCount: history.length,
  });
});

routes.get('/api/identity/export-status', async (c) => {
  const status = await statusForUi();
  return c.json({
    currentHash: status.currentHash,
    adapters: status.adapters.map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      url: a.url || null,
      enabled: a.enabled ?? false,
      path: a.path || a.defaultPath || null,
      installedVersion: a.installedVersion || null,
      needsInstall: a.needsInstall || false,
      setupHint: a.setupHint || null,
    })),
  });
});

/**
 * GET /api/identity/device-name — returns the owner's device slug + its
 * public URL. Used by the Foundation section of /account to render the
 * "Device name" row with its current value.
 */
routes.get('/api/identity/device-name', (c) => {
  const row = getAdminDeviceName(db);
  if (!row) return c.json({ slug: null, email: null, publicUrl: null });
  const installedName = readInstalledDeviceName();
  repairGeneratedDeviceSlug(db, row, installedName);
  const savedDisplayName = readUserSetting(db, 'device_display_name');
  const visibleSlug = resolveLoginServerName(row.user_slug);
  const displayName = savedDisplayName || installedName || visibleSlug || row.user_slug || 'This Mac';
  const relayUrl = config.tunnel?.url || (visibleSlug ? `https://${visibleSlug}.robotdojo.ai` : null);
  return c.json({
    slug: visibleSlug,
    name: displayName,
    displayName,
    email: row.email,
    relayUrl,
    publicUrl: relayUrl ? `${relayUrl}/chat` : null,
  });
});

/**
 * PUT /api/identity/device-name  { slug }
 *   200 → { slug, oldSlug }
 *   400 → validation error
 *   409 → taken by another install
 *
 * Delegates to lib/device-rename.js for the atomic flow (validate → relay
 * claim → DB rotation → old-slug release). Auto-bounces the app after a
 * successful rename so the tunnel agent reconnects under the new slug.
 */
routes.put('/api/identity/device-name', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  const desired = String(body?.slug || '').trim().toLowerCase();
  if (!desired) return c.json({ error: 'missing_slug' }, 400);

  const res = await renameDevice({ userId: 1, newSlug: desired });
  if (!res.ok) {
    const code = res.reason === 'taken' ? 409 : 400;
    return c.json({ error: res.reason, message: res.message }, code);
  }
  writeUserSetting(db, 'device_display_name', res.newSlug);
  // Bounce the app so the tunnel reconnects with a fresh JWT. Fire-and-
  // forget — the client that called this is about to be disconnected
  // anyway (sessions were wiped in the rename).
  setTimeout(() => {
    try { execSync('launchctl kickstart -k gui/$(id -u)/com.robotdojo.server', { timeout: 3000 }); }
    catch {}
  }, 100);
  return c.json({ slug: res.newSlug, oldSlug: res.oldSlug, unchanged: !!res.unchanged });
});

/**
 * PUT /api/identity/handle  { handle }
 *
 * Rename the user's identity handle (user_handle). Globally unique,
 * user-chosen alias used in two-segment URLs:
 *   robotdojo.ai/<servername>/<handle>/<app>
 *
 * Claims at relay, updates DB, deletes sessions. Returns:
 *   { ok: true, handle, oldHandle }
 *   400 → validation error
 *   409 → taken by another user
 */
routes.put('/api/identity/handle', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const desired = String(body?.handle || '').trim().toLowerCase();
  if (!desired) return c.json({ error: 'missing_handle' }, 400);

  const user = getAdminId(db);
  if (!user) return c.json({ error: 'user_not_found' }, 404);

  const cookie = getCookie(c, COOKIE_NAME);
  const currentSessionId = sessionIdFromCookie(cookie);
  const res = await renameHandle({ userId: user.id, newHandle: desired, currentSessionId });
  if (!res.ok) {
    const code = res.reason === 'taken' ? 409 : 400;
    return c.json({ error: res.reason, message: res.message }, code);
  }
  return c.json({ ok: true, handle: res.newHandle, oldHandle: res.oldHandle, unchanged: !!res.unchanged });
});

/**
 * POST /api/identity/device-name/prepare  { slug }
 *
 * Step 1 of the two-step device rename flow.
 * Validates the slug, claims it at the relay, and stores a short-lived
 * token in `pending_renames` (expires in 5 minutes). Does NOT touch
 * the users table or delete sessions at this point.
 *
 * Returns:
 *   { ok: true, token, newSlug }   — slug claimed, token ready for confirm
 *   { ok: false, error: 'slug_taken' }  — relay rejected the claim (409)
 *   { ok: false, error: 'invalid_slug', message }  — validation failure
 *   { ok: false, error: 'relay_error', message }   — relay unreachable
 */
routes.post('/api/identity/device-name/prepare', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: 'invalid_json' }, 400); }

  const desired = String(body?.slug || '').trim().toLowerCase();
  const problem = validateSlug(desired);
  if (problem) return c.json({ ok: false, error: 'invalid_slug', message: problem }, 400);

  // Look up the current user (admin — same as the existing rename endpoint).
  const user = getAdminProfile(db);
  if (!user) return c.json({ ok: false, error: 'user_not_found' }, 404);
  if (user.user_slug === desired) {
    return c.json({ ok: false, error: 'invalid_slug', message: 'That is already your device name.' }, 400);
  }

  // Claim the slug at the relay BEFORE touching local state.
  const claim = await claimSlugAtRelay(desired);
  if (!claim.ok) {
    if (claim.status === 409) {
      return c.json({ ok: false, error: 'slug_taken' });
    }
    return c.json({ ok: false, error: 'relay_error', message: claim.error || 'relay rejected claim' }, 502);
  }

  // Store the pending rename with a 5-minute TTL.
  const token = randomUUID();
  insertPendingRename(db, user.id, desired, token);

  return c.json({ ok: true, token, newSlug: desired });
});

/**
 * POST /api/identity/device-name/confirm  { token }
 *
 * Step 2 of the two-step device rename flow.
 * Looks up the pending_rename row by token + user_id + expiry, runs the
 * full DB rename transaction, releases the old slug at the relay (best-
 * effort), and triggers a server restart via launchctl (non-fatal).
 *
 * Returns:
 *   { ok: true, newSlug }              — rename complete, server restarting
 *   { ok: false, error: 'expired' }    — token not found or expired
 */
routes.post('/api/identity/device-name/confirm', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: 'invalid_json' }, 400); }

  const token = String(body?.token || '').trim();
  if (!token) return c.json({ ok: false, error: 'expired' }, 400);

  // Look up admin user (consistent with prepare + the existing PUT handler).
  const user = getAdminProfile(db);
  if (!user) return c.json({ ok: false, error: 'user_not_found' }, 404);

  // Find the pending rename — must match token, user_id, and not be expired.
  const pending = getPendingRename(db, token, user.id);

  if (!pending) return c.json({ ok: false, error: 'expired' });

  const oldSlug = user.user_slug;
  const newSlug = pending.new_slug;

  // Run the DB rename transaction atomically.
  executeDeviceRenameTransaction(db, newSlug, user.id, pending.id);
  writeUserSetting(db, 'device_display_name', newSlug);

  // Release old slug at relay — best-effort, non-fatal.
  if (oldSlug) {
    try { await releaseSlugAtRelay(oldSlug); }
    catch (err) { console.warn('[device-rename/confirm] old-slug release failed:', err.message); }
  }

  // Bounce the server so the tunnel agent reconnects under the new slug.
  // Fire-and-forget — the client is about to be disconnected anyway.
  setTimeout(() => {
    try {
      execSync('launchctl kickstart -k gui/$(id -u)/com.robotdojo.server', { timeout: 5000 });
    } catch { /* non-fatal — launchctl may not be available in all environments */ }
  }, 100);

  return c.json({ ok: true, newSlug });
});

/**
 * POST /api/identity/recalc
 * Triggers a full identity export recalculation via lib/identity-export.js exportAll().
 */
routes.post('/api/identity/recalc', async (c) => {
  try {
    await exportAll();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

routes.post('/api/identity/export', async (c) => {
  try {
    const { results } = await exportAll();
    return c.json({
      ok: true,
      autoSynced: results.filter((r) => r.kind === 'auto-sync' && r.ok).length,
      guidedPending: results.filter((r) => r.kind === 'guided' && r.ok).length,
      results: results.map((r) => ({
        id: r.id, label: r.label, kind: r.kind, ok: r.ok,
        action: r.action, path: r.path, error: r.error,
      })),
    });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

/**
 * PATCH /api/identity/export-target/:id  { enabled: boolean }
 * Toggle an export adapter on or off from the account page.
 * Wraps lib/identity-export.js updateTarget — same logic as the
 * set_export_target chat tool but accessible over HTTP.
 */
routes.patch('/api/identity/export-target/:id', async (c) => {
  const id = c.req.param('id');
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!getAdapter(id)) return c.json({ error: `unknown adapter "${id}"` }, 404);
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.path !== undefined) patch.path = String(body.path);
  if (Object.keys(patch).length === 0) return c.json({ error: 'validation_error' }, 400);
  try {
    const updated = updateTarget(id, patch);
    return c.json({ ok: true, target: updated });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

/**
 * PUT /api/identity/section/:slug  { body: string }
 * Update the body of an identity card from the account page.
 * Used by the User card Links section to persist URL additions/removals.
 * Appends a new log entry (append-only; old versions preserved for audit).
 */
routes.put('/api/identity/section/:slug', async (c) => {
  const slug = c.req.param('slug').toLowerCase();
  if (!DEFAULT_SECTIONS.includes(slug)) {
    return c.json({ error: `unknown section "${slug}"` }, 404);
  }
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  if (typeof body.body !== 'string') return c.json({ error: 'validation_error' }, 400);
  try {
    await appendIdentitySection({
      section: slug,
      body: body.body,
      author: 'account-page',
      description: `Update ${slug} via account settings`,
    });
    return c.json({ ok: true, slug });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});
export default routes;
