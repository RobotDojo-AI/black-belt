/**
 * Setup progress API — onboarding hub for the Account page's Setup tab.
 *
 * Mount at `/api/setup` from index.js (see routes/_mount-setup.md).
 *
 * Endpoints
 *   GET  /api/setup/progress              → 12-step progress doc
 *   PUT  /api/setup/identity              → save identity fields inline
 *
 * Admin sub-routes (/api/setup/admin/*) are handled by routes/admin.js via
 * the compatibility alias mount in index.js. Do not re-declare them here.
 *
 * Auth model
 *   Local-app bearer flow (port :4338) = local owner, treated as admin.
 *   Session-cookie flow where user.id === 1 = local owner, treated as admin.
 *
 * Design
 *   Progress is computed deterministically from database state. A short
 *   process-local cache collapses repeated browser shell warmups so setup
 *   status never competes with foreground chat.
 *   Each step has a chat deep-link (prompt + context) and an inline payload
 *   hint, so the same data powers both the "Do in chat" CTA and the inline
 *   form in the card. Individual step computers live in ./steps/*.js —
 *   register-and-go.
 */

import { Hono } from 'hono';
import { effectiveUser, readSetting, writeSetting } from './helpers.js';

// --- Step registry ---------------------------------------------------------
//
// Order matters — it maps to the visual grid top-to-bottom, left-to-right.

import deviceName from './steps/device-name.js';
import apiKey from './steps/api-key.js';
import extractionPrompts from './steps/extraction-prompts.js';
import identity from './steps/identity.js';
import soul from './steps/soul.js';
import topics from './steps/topics.js';
import context from './steps/context.js';
import gmail from './steps/gmail.js';
import calendar from './steps/calendar.js';
import imessage from './steps/imessage.js';
import granola from './steps/granola.js';
import contacts from './steps/contacts.js';
import keyDocuments from './steps/key-documents.js';
import dropFolder from './steps/drop-folder.js';
import payment from './steps/payment.js';

// First-run onboarding wizard (stages 1-6, see docs/onboarding-flow.md).
// These mount under the same /api/setup prefix as the 12-step progress hub.
import onboardingRouter from './onboarding.js';
import permissionsRouter from './permissions.js';

const STEPS = [
  // Foundation gate — must come first. Device name before anything else
  // because every later step's URL embeds it. Then API key (so LLM calls
  // route on the user's key), then extraction prompts.
  deviceName, apiKey, extractionPrompts,
  identity, soul, topics, context,
  gmail, calendar, imessage, contacts, granola, keyDocuments, dropFolder,
  payment,
];

// --- Routes ----------------------------------------------------------------

const setup = new Hono();

const SETUP_PROGRESS_CACHE_TTL_MS = Number.parseInt(process.env.ROBOTDOJO_SETUP_PROGRESS_CACHE_MS || '20000', 10);
let setupProgressCache = null;

function invalidateSetupProgressCache() {
  setupProgressCache = null;
}

function buildProgressPayload() {
  const steps = STEPS.map(s => {
    let status;
    try { status = s.compute(); }
    catch (err) {
      console.error(`[setup] compute failed for ${s.id}:`, err.message);
      status = { complete: false, preview: 'Could not compute status' };
    }
    // Manual override: skip or complete stored in user_settings.
    const override = readSetting(`setup.override.${s.id}`);
    const computedStatus = status.complete ? 'complete' : 'incomplete';
    const finalStatus = (override === 'skip' || override === 'complete') ? override : computedStatus;
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      icon: s.icon,
      category: s.category,
      status: finalStatus,
      preview: status.preview,
      inline: !!s.inline,
      chat_prompt: s.chat_prompt,
      chat_context: s.chat_context,
    };
  });

  const total = steps.length;
  const completed = steps.filter(s => s.status === 'complete' || s.status === 'skip').length;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  return {
    completeness_pct: pct,
    total_steps: total,
    completed_steps: completed,
    steps,
  };
}

// Onboarding wizard endpoints — keep these mounted BEFORE /progress and
// /identity so Hono's first-match routing picks the more specific paths
// (`/onboarding`, `/permissions`) without falling through.
setup.route('/', onboardingRouter);
setup.route('/', permissionsRouter);

const VALID_STEP_IDS = new Set(STEPS.map(s => s.id));

setup.get('/progress', (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const now = Date.now();
  const force = c.req.query('refresh') === '1' || c.req.query('cache') === '0';
  if (!force && setupProgressCache && setupProgressCache.expiresAt > now) {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-RobotDojo-Cache', 'hit');
    return c.json(setupProgressCache.payload);
  }

  const payload = buildProgressPayload();
  setupProgressCache = { payload, expiresAt: now + SETUP_PROGRESS_CACHE_TTL_MS };
  c.header('Cache-Control', 'private, no-store');
  c.header('X-RobotDojo-Cache', 'miss');
  return c.json(payload);
});

// Manual step override — skip or mark complete without touching the computed state.
setup.post('/steps/:id/skip', (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const id = c.req.param('id');
  if (!VALID_STEP_IDS.has(id)) return c.json({ error: 'not_found', id }, 404);
  writeSetting(`setup.override.${id}`, 'skip');
  invalidateSetupProgressCache();
  return c.json({ ok: true, id, override: 'skip' });
});

setup.post('/steps/:id/complete', (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const id = c.req.param('id');
  if (!VALID_STEP_IDS.has(id)) return c.json({ error: 'not_found', id }, 404);
  writeSetting(`setup.override.${id}`, 'complete');
  invalidateSetupProgressCache();
  return c.json({ ok: true, id, override: 'complete' });
});

// Clear a manual override — returns step to its computed state.
setup.post('/steps/:id/reset', (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const id = c.req.param('id');
  if (!VALID_STEP_IDS.has(id)) return c.json({ error: 'not_found', id }, 404);
  writeSetting(`setup.override.${id}`, '');
  invalidateSetupProgressCache();
  return c.json({ ok: true, id, override: null });
});

/**
 * Inline identity save. Writes to user_settings (Chat-as-IDE pattern).
 * Accepts partial updates — any missing key is left untouched.
 */
setup.put('/identity', async (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const allowed = ['name', 'email', 'timezone', 'location'];
  const updated = {};

  for (const key of allowed) {
    if (typeof body?.[key] === 'string') {
      const value = body[key].trim();
      if (value) {
        writeSetting(key, value);
        updated[key] = value;
      }
    }
  }

  // Stage 4 extraction dumps — any key matching extraction_dump_* is accepted.
  for (const key of Object.keys(body || {})) {
    if (/^extraction_dump_/.test(key) && typeof body[key] === 'string') {
      const value = body[key].trim();
      if (value) {
        writeSetting(key, value);
        updated[key] = value;
      }
    }
  }

  invalidateSetupProgressCache();
  return c.json({ ok: true, updated });
});

export default setup;
