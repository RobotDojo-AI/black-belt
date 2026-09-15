/**
 * Onboarding stage state machine.
 *
 *   GET  /api/setup/onboarding  → { stage, completed_stages, eta_seconds, ... }
 *   PUT  /api/setup/onboarding  → advance to body.stage (idempotent)
 *
 * Stages 1–6, see docs/onboarding-flow.md. Persisted in user_settings:
 *   onboarding_stage  — INTEGER 1..6 (current stage, never goes backwards)
 *   onboarded_at      — ISO timestamp written when stage 6 completes
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAILURE MANIFEST — what breaks, what the code MUST do
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. macOS protected local store blocks or denies permission probe.
 *    → detectPermissions() runs protected opens in timed child processes.
 *    → Timeout/denial returns false; UI keeps polling. No 500, no server
 *      freeze. The 1s lib-side cache prevents thundering-herd retries.
 *
 * 2. Permission revoked mid-flow (user toggles Contacts off in Stage 4).
 *    → Polling loop sees the flip on its next 2s tick.
 *    → State machine does NOT roll back stage. Stage advancement is a
 *      one-way ratchet. The progress endpoint surfaces the now-false
 *      permission so the UI can re-prompt without losing position.
 *
 * 3. Browser closed mid-stage.
 *    → Stage is server-side. Account Integrations can re-read the same
 *      onboarding_stage. PUT is idempotent (same stage = no-op write).
 *
 * 4. install.sh re-run after a successful onboarding.
 *    → config-dir .onboarded sentinel makes the install.sh `open` URL
 *      go to chat. Server-side, the stage stays at 6. Re-running install.sh
 *      never resets onboarding_stage.
 *
 * 5. Queue empty so ETA divisor is 0 → NaN.
 *    → etaSeconds() in lib/onboarding-eta.js returns 0 (not NaN) when
 *      remaining<=0, and null when rate is unknown. JSON serialisation
 *      of NaN would silently break clients — guarded explicitly.
 *
 * 6. macOS < 13 — `x-apple.systempreferences:` Privacy_AllFiles deep links
 *    behave differently (Ventura+ uses System Settings.app; older uses
 *    System Preferences.app and some scheme variants don't resolve).
 *    → We expose the deep links on the front-end only; the server doesn't
 *      need to know the OS version. If the URI fails to open, the user
 *      is still on the System Settings root — one extra click, not blocked.
 *      A future enhancement could parse `sw_vers -productVersion` and
 *      switch schemes; not gated on it for v1.
 *
 * 7. Clock skew — `onboarded_at` is the server's ISO `datetime('now')`.
 *    → Always SQLite-side, never client-supplied. Even a 5min drift on
 *      the user's machine cannot poison this row.
 *
 * Local-owner only. effectiveUser() returns null for anon → 401.
 * No body parsing on GET; PUT body must be JSON `{ stage: 1..6 }`.
 */

import { Hono } from 'hono';
import { effectiveUser, readSetting, writeSetting } from './helpers.js';
import { detectPermissions } from '../../lib/macos-permissions.js';
import { computeOnboardingEta } from '../../lib/onboarding-eta.js';
import { SCOPES as GOOGLE_SCOPES, SCOPE_DESCRIPTIONS as GOOGLE_SCOPE_DESCRIPTIONS, describeScopes } from '../../lib/google-scopes.js';
import { answerSetupHelp } from '../../lib/setup-local-help.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import db from '../../lib/db.js';
import config from '../../lib/config.js';
import { renameDevice } from '../../lib/device-rename.js';
import { computeSetupReadiness } from '../../lib/setup-readiness.js';
import { writeKeychainSecret } from '../../lib/keychain.js';
import {
  getAdminUserSlug, getAdminUserHandle, setUserHandle,
  setAdminOnboardingStage,
} from '../../lib/setup-queries.js';

const onboarding = new Hono();

const MIN_STAGE = 1;
const MAX_STAGE = 6;
const GENERIC_DEVICE_NAMES = new Set([
  'mac',
  'macbook',
  'macbook air',
  'macbook pro',
  'mac mini',
  'mac studio',
  'imac',
  'localhost',
]);

/**
 * Read the persisted stage. Defaults to 1 if unset (fresh install).
 * Always returns an integer in [1, 6]; clamps anything corrupt.
 */
function readStage() {
  const raw = readSetting('onboarding_stage');
  if (!raw) return MIN_STAGE;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return MIN_STAGE;
  return Math.min(MAX_STAGE, Math.max(MIN_STAGE, n));
}

/**
 * Build the `completed_stages` array. A stage is "complete" if the current
 * stage is past it OR (for stage 6) if onboarded_at is set. This matches the
 * UI expectation: completed stages render as ✓; current stage renders active.
 */
function completedStages(current) {
  const out = [];
  for (let i = 1; i < current; i++) out.push(i);
  if (current === MAX_STAGE && readSetting('onboarded_at')) out.push(MAX_STAGE);
  return out;
}

// st_5a63545d AC 9 — single source of truth for Google scope copy. Account
// Integrations fetches this endpoint so displayed text always matches the
// actual grant in routes/oauth.js.
onboarding.get('/google-scopes', (c) => {
  return c.json({
    scopes: GOOGLE_SCOPES,
    descriptions: describeScopes(),
    descriptionMap: GOOGLE_SCOPE_DESCRIPTIONS,
  });
});

onboarding.post('/local-help', async (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { body = {}; }

  const question = typeof body?.question === 'string' ? body.question : '';
  const context = typeof body?.context === 'string' ? body.context : 'setup-guide';
  const answer = await answerSetupHelp({ question, context });
  return c.json(answer);
});

onboarding.get('/onboarding', (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const stage = readStage();
  const completed = completedStages(stage);

  // Permissions and ETA are computed every call — both are cheap (cached
  // 1s in the lib for permissions, single COUNT(*)s for ETA) and both
  // change continuously as the background ingest progresses.
  let permissions;
  try { permissions = detectPermissions(); }
  catch { permissions = { full_disk: false, contacts: false, calendar: false, photos: false, reminders: false }; }

  let eta;
  try { eta = computeOnboardingEta(); }
  catch { eta = { eta_seconds: 0 }; }

  // Top-level eta_seconds is the long-pole stream ETA (max of all). UI uses
  // it for the headline number on Stage 6.
  const etaSeconds = Number.isFinite(eta.eta_seconds) ? eta.eta_seconds : 0;

  return c.json({
    stage,
    completed_stages: completed,
    eta_seconds: etaSeconds,
    eta,                 // per-stream breakdown for the Stage 6 card
    permissions,         // mirrored here so the client can paint Stage 2 from one fetch
    readiness: computeSetupReadiness({ db }),
    onboarded_at: readSetting('onboarded_at') || null,
  });
});

onboarding.put('/onboarding', async (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const requested = parseInt(body?.stage, 10);
  if (!Number.isFinite(requested) || requested < MIN_STAGE || requested > MAX_STAGE) {
    return c.json({ error: `stage must be an integer in [${MIN_STAGE}, ${MAX_STAGE}]` }, 400);
  }

  const current = readStage();

  // Idempotent: re-sending the same stage is a no-op success.
  if (requested === current) {
    return c.json({
      stage: current,
      completed_stages: completedStages(current),
      noop: true,
    });
  }

  // One-way ratchet: never go backwards. Reopening the wizard from an
  // earlier-rendered tab won't accidentally rewind state.
  if (requested < current) {
    return c.json({
      stage: current,
      completed_stages: completedStages(current),
      noop: true,
      message: `already at stage ${current}; ignoring rewind to ${requested}`,
    });
  }

  // Don't allow skipping more than one stage at a time. The flow is sequential
  // by design (each stage unblocks the next); a jump from 2 → 5 would skip the
  // Google Auth prerequisite for Stage 5's "≥1 entity surfaced" gate.
  if (requested > current + 1) {
    return c.json(
      { error: `cannot skip stages; requested ${requested} but current is ${current}` },
      400,
    );
  }

  writeSetting('onboarding_stage', String(requested));

  // Stage 6 = onboarding complete. Stamp the timestamp + write the sentinel
  // file install.sh checks. Sentinel write is best-effort; failure does not
  // block the response.
  if (requested === MAX_STAGE) {
    writeSetting('onboarded_at', new Date().toISOString());
    writeOnboardedSentinel();
  }

  return c.json({
    stage: requested,
    completed_stages: completedStages(requested),
  });
});

// ── Stage 4 — LLM key endpoints ─────────────────────────────────────────────
//
// Two paths: BYO Anthropic key (Path A) or managed gateway (Path B).
// Both are idempotent; re-submitting overwrites the prior selection.

// Keychain service names per provider — mirrors SUPPORTED_PROVIDERS in steps/api-key.js.
const PROVIDER_KEYCHAIN = {
  anthropic: 'robotdojo-ANTHROPIC_API_KEY',
  openai:    'robotdojo-OPENAI_API_KEY',
  google:    'robotdojo-GOOGLE_AI_API_KEY',
};

/**
 * POST /api/setup/llm-key  body: { provider: string, key: string }
 * Validates shape, stores in macOS Keychain under the provider-specific service,
 * marks llm_provider=<provider>. Does NOT call the provider to validate — the
 * first chat request will fail loudly if the key is bad, and Stage 4 can be
 * re-entered.
 */
onboarding.post('/llm-key', async (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : 'anthropic';
  const key = typeof body?.key === 'string' ? body.key.trim() : '';

  if (!PROVIDER_KEYCHAIN[provider]) {
    return c.json({ error: `unsupported provider: ${provider}` }, 400);
  }
  if (key.length < 20) {
    return c.json({ error: 'key_too_short' }, 400);
  }
  if (key.length > 4096) {
    return c.json({ error: 'key_too_long' }, 400);
  }

  const service = PROVIDER_KEYCHAIN[provider];

  try {
    if (!writeKeychainSecret(service, key)) throw new Error('security command failed');
  } catch (err) {
    console.error('[setup/llm-key] keychain write failed:', err.message);
    return c.json({ error: 'keychain_store_failed' }, 500);
  }

  writeSetting('llm_provider', provider);
  // st_5a63545d AC 8 — advance onboarding_stage to 4 in the same handler as
  // the key save. The frontend used to require a separate PUT /api/setup/onboarding
  // to advance; that round-trip is now collapsed. Idempotent: a re-submit
  // at stage 4+ is a no-op (writeSetting just overwrites with the same value).
  // Dual-write users.onboarding_stage + user_settings for the duration of
  // the canonical-column migration.
  const currentStage = parseInt(readSetting('onboarding_stage') || '3', 10);
  const nextStage = Math.max(currentStage, 4);
  writeSetting('onboarding_stage', String(nextStage));
  // Thin-facade: setAdminOnboardingStage lives in lib/setup-queries.js so
  // routes/setup/onboarding.js stays free of db.prepare (AC 22).
  try { setAdminOnboardingStage(db, nextStage); }
  catch (err) { console.warn('[setup/llm-key] users.onboarding_stage update failed:', err.message); }
  return c.json({ ok: true, provider, stage: nextStage });
});

/**
 * POST /api/setup/llm-gateway   body: {}
 * Marks the user as routing through the managed gateway. No local provider key
 * is needed; private beta entitlement is handled by issued Black Belt keys.
 */
onboarding.post('/llm-gateway', (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  writeSetting('llm_provider', 'gateway');
  return c.json({ ok: true, provider: 'gateway', entitlement: 'black_belt_key' });
});

// ── Stage 6 — Notify when ingest completes ──────────────────────────────────
//
// Browser push only — no email channel by spec (privacy default).
// Stored as a string boolean; the actual notification dispatch is owned by
// the ingest orchestrator on phase.completed events.

onboarding.post('/notify-when-ready', async (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const enabled = body?.enabled === true || body?.enabled === 'true';
  writeSetting('notify_on_ingest_complete', enabled ? '1' : '0');
  return c.json({ ok: true, enabled });
});

onboarding.post('/context-choice', async (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { body = {}; }

  const choice = body?.choice === 'without_context' ? 'without_context' : 'connect_context';
  writeSetting('setup.context_choice', choice);
  return c.json({ ok: true, choice });
});

/**
 * Write .onboarded in the active Robot Dojo config dir so install.sh can
 * short-circuit the browser
 * open URL on re-runs. Best-effort — never throws. The DB record is still
 * the source of truth; the file is a hint to the shell layer that has no
 * SQLite access.
 */
function writeOnboardedSentinel() {
  // Lazy require to keep top-level imports lean and to avoid hard-failing
  // the route on filesystem oddities (read-only home, etc.).
  Promise.resolve().then(async () => {
    try {
      const { writeFile, mkdir } = await import('fs/promises');
      const { resolve } = await import('path');
      const dir = config.configDir;
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, '.onboarded'), new Date().toISOString() + '\n', 'utf8');
    } catch (err) {
      console.warn('[onboarding] could not write .onboarded sentinel:', err?.message);
    }
  });
}

function readInitialSlug() {
  try {
    return readFileSync(resolve(config.configDir, 'initial-slug'), 'utf8').trim() || null;
  } catch {}
  try {
    const display = readFileSync(resolve(config.configDir, 'device-name'), 'utf8').trim();
    if (!display) return null;
    return display.toLowerCase().replace(/\.local$/i, '').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || null;
  } catch { return null; }
}

function readInstalledDeviceName() {
  try {
    return readFileSync(resolve(config.configDir, 'device-name'), 'utf8').trim() || null;
  } catch { return null; }
}

function normalizeDeviceName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function isGenericDeviceName(value) {
  const normalized = normalizeDeviceName(value).toLowerCase();
  if (!normalized) return true;
  if (GENERIC_DEVICE_NAMES.has(normalized)) return true;
  return /^mac(book)?( pro| air)?( \(\d+\)| \d+)?$/i.test(normalized);
}

function getAdminSlug() {
  return getAdminUserSlug(db);
}

onboarding.get('/device-name', (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const currentSlug = getAdminSlug();
  const confirmed = readSetting('device_name_confirmed') === '1';
  const displayName = readSetting('device_display_name') || readInstalledDeviceName() || currentSlug || 'This Mac';
  const suggestion = readInstalledDeviceName() || readSetting('device_display_name') || 'This Mac';

  return c.json({
    suggestion,
    current: displayName,
    slug: currentSlug || readInitialSlug() || null,
    confirmed,
    displayName,
    renameRecommended: isGenericDeviceName(displayName),
  });
});

onboarding.post('/device-name', async (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const name = normalizeDeviceName(body?.name || body?.deviceName || body?.displayName || body?.slug);
  if (!name) return c.json({ error: 'device_name_required' }, 400);

  writeSetting('device_display_name', name);

  // First-run setup confirms the human device name and the login slug
  // together. Token and relay mechanics stay out of the wizard.
  if (typeof body?.slug === 'string' && body.slug.trim()) {
    const slug = body.slug.trim().toLowerCase();
    const result = await renameDevice({ userId: user.id, newSlug: slug });
    if (!result.ok) {
      return c.json({ error: result.message || result.reason }, result.reason === 'taken' ? 409 : 400);
    }
    const userRow = getAdminUserHandle(db);
    if (userRow && !userRow.user_handle) {
      setUserHandle(db, result.newSlug, userRow.id);
    }
  } else {
    const userRow = getAdminUserHandle(db);
    const currentSlug = getAdminSlug();
    if (userRow && !userRow.user_handle && currentSlug) {
      setUserHandle(db, currentSlug, userRow.id);
    }
  }

  writeSetting('device_name_confirmed', '1');
  return c.json({ ok: true, name });
});

export default onboarding;
