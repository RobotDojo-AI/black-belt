/**
 * isBBActive() — single source of truth for cohort-key entitlement.
 *
 * Returns true iff:
 *   (a) the embedded JWT (BB_COHORT_JWT) verifies against lib/cohort/public-key.pem,
 *   (b) now < BB_VALID_UNTIL (with ±10min clock-skew tolerance), AND
 *   (c) BB_COHORT_WEEK is NOT in the cached revocation list.
 *
 * Returns false otherwise. The 48h grace on revocation-endpoint unreachable
 * only accrues against time during which polling was actually attempted
 * and failed — a machine that was asleep for 90 days simply has no recent
 * failed polls and is therefore not stale by this definition.
 *
 * st_5a63545d AC 18.
 */

import { verifyJwt } from './jwt.js';
import { readRevocationCache, getRevokedWeeks } from './revocation.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const CLOCK_SKEW_TOLERANCE_MS = 10 * 60 * 1000;     // ±10 min
const GRACE_WINDOW_MS = 48 * 60 * 60 * 1000;        // 48h on attempted-and-failed polls only

/**
 * readInstallExpiry() — the per-install Black Belt clock (`bb_expires_at`).
 *
 * The cohort JWT above is stamped at BUILD time and is shared by every install
 * of that build. The 90-day entitlement the owner wants is per-INSTALL, so it
 * lives as local install state in ~/.robotdojo/config.json (written once at
 * first install, preserved across re-installs), NOT a SQL column — that keeps
 * it in the same local-first tier as the cohort gate so the two compose.
 *
 * Mirrors revocation.js's direct-`readFileSync` + env-override pattern on
 * purpose: the cohort module must NOT import lib/config.js (decoupling — this
 * module is loaded on the hot path and by the build tooling, and a config.js
 * import would drag the whole app config graph in).
 *
 * Path precedence:
 *   ROBOTDOJO_INSTALL_INFO_PATH                         — explicit override (tests)
 *   else <ROBOTDOJO_CONFIG || ~/.robotdojo>/config.json — the real install file
 *
 * Returns the ISO string exactly as written, or `null` on missing file / parse
 * error / absent-or-non-string field. NEVER throws: a broken or absent install
 * file must not deny an otherwise-valid cohort — expiry is an AND-gate that can
 * only ever tighten, never loosen, entitlement.
 */
function installConfigPath() {
  return process.env.ROBOTDOJO_INSTALL_INFO_PATH ||
    resolve(process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo'), 'config.json');
}

export function readInstallExpiry() {
  const path = installConfigPath();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed?.bb_expires_at === 'string' ? parsed.bb_expires_at : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the per-install 90-day Black Belt trial clock exists.
 *
 * Install.sh writes this on first install. Founder/dev machines and partial
 * restores can lack config.json entirely — then cohort JWT alone expires and
 * the product goes dark overnight. Missing clock → stamp belt=black + 90 days
 * from now (idempotent; never shortens an existing future expiry).
 *
 * @param {{ days?: number, now?: number }} [opts]
 * @returns {{ path: string, wrote: boolean, bb_expires_at: string|null }}
 */
export function ensureInstallBbTrialConfig({ days = 90, now = Date.now() } = {}) {
  const path = installConfigPath();
  const trialDays = Number.isFinite(days) && days > 0 ? days : 90;
  let cfg = {};
  try {
    if (existsSync(path)) cfg = JSON.parse(readFileSync(path, 'utf8')) || {};
  } catch { cfg = {}; }

  const existing = typeof cfg.bb_expires_at === 'string' ? Date.parse(cfg.bb_expires_at) : NaN;
  if (Number.isFinite(existing) && existing > now) {
    return { path, wrote: false, bb_expires_at: cfg.bb_expires_at };
  }

  const exp = new Date(now + trialDays * 86400 * 1000);
  const iso = exp.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = {
    ...cfg,
    belt: cfg.belt || 'black',
    bb_expires_at: iso,
    bb_trial_started_at: cfg.bb_trial_started_at || new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { path, wrote: true, bb_expires_at: iso };
  } catch (err) {
    console.warn('[cohort] ensureInstallBbTrialConfig failed:', err.message);
    return { path, wrote: false, bb_expires_at: null };
  }
}

let _buildInfoCache = null;
async function loadBuildInfo() {
  // Test hook: ROBOTDOJO_REBUILD_COHORT=1 forces a fresh import of
  // build-info.js on every call so unit tests can swap it via writeFile
  // without process restarts. Production never sets this flag.
  if (process.env.ROBOTDOJO_REBUILD_COHORT === '1') {
    try { return await import(`./build-info.js?fresh=${Date.now()}`); }
    catch { return null; }
  }
  if (_buildInfoCache !== null) return _buildInfoCache;
  try {
    _buildInfoCache = await import('./build-info.js');
  } catch {
    _buildInfoCache = null;
  }
  return _buildInfoCache;
}

/**
 * Returns the active-state assessment.
 * Shape: { active: boolean, reason?: string, valid_until?: string, days_behind?: number }
 * `active=true` means the local cohort is current and ingest workers should run.
 * `days_behind` is computed against BB_VALID_UNTIL — negative while valid,
 * positive once expired, useful for the stale-banner copy.
 */
/**
 * Operator permanent key (key.meta.json permanent:true, belt black).
 * When present and not past grace, BB engines stay on even if the build-global
 * cohort JWT lapsed — permanent is the escape hatch for founder/dev installs
 * and must never leave the product dark overnight after a weekly stamp expires.
 * Sync read only — no import of the async key-store graph on the hot path.
 */
function readPermanentKeyActive() {
  if (process.env.BB_IGNORE_PERMANENT_KEY === '1') return false;
  const path = process.env.ROBOTDOJO_KEY_META_PATH ||
    resolve(process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo'), 'key.meta.json');
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    if (meta?.permanent !== true) return false;
    if (String(meta?.belt || 'black').toLowerCase() !== 'black') return false;
    if (meta?.grace_until) {
      const t = Date.parse(meta.grace_until);
      if (Number.isFinite(t) && Date.now() > t) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function getBBStatus() {
  // Test hook for spec validation (Phase 9 specs need to assert stale-banner
  // copy renders without a real expired JWT). Stays gated on env so prod
  // can't accidentally treat itself as inactive.
  if (process.env.BB_TEST_INACTIVE === '1') {
    return { active: false, reason: 'test_inactive', days_behind: 99, valid_until: null };
  }
  // st_bc949e7c Phase 3.8: mirror test hook for the BB-active case. Used by
  // tests/specs/st_bc949e7c.test.js to force BB mode without a real JWT.
  if (process.env.BB_TEST_ACTIVE === '1') {
    return { active: true, reason: 'test_active', days_behind: -999, valid_until: null };
  }

  // Permanent operator key outranks a lapsed build cohort — engines stay on.
  if (readPermanentKeyActive()) {
    return { active: true, reason: 'permanent_key', days_behind: -999, valid_until: null };
  }

  const buildInfo = await loadBuildInfo();
  if (!buildInfo?.BB_COHORT_JWT) {
    return { active: false, reason: 'no_build_info' };
  }
  const { BB_COHORT_WEEK, BB_VALID_UNTIL, BB_COHORT_JWT } = buildInfo;

  const verified = verifyJwt(BB_COHORT_JWT);
  if (!verified.valid) {
    return { active: false, reason: `jwt_${verified.reason || 'invalid'}` };
  }

  const now = Date.now();
  const exp = Date.parse(BB_VALID_UNTIL);
  if (!Number.isFinite(exp)) {
    return { active: false, reason: 'bad_exp' };
  }
  const daysBehind = Math.floor((now - exp) / 86400000);

  // Allow ±10min clock skew — local NTP drift is common.
  if (now > exp + CLOCK_SKEW_TOLERANCE_MS) {
    return { active: false, reason: 'expired', days_behind: daysBehind, valid_until: BB_VALID_UNTIL };
  }

  // Revocation check. If this week is in the revoked list, deny.
  const revoked = getRevokedWeeks();
  if (revoked.includes(BB_COHORT_WEEK)) {
    return { active: false, reason: 'revoked', valid_until: BB_VALID_UNTIL, days_behind: daysBehind };
  }

  // Cache freshness — only counts attempted-and-failed polls (machine-asleep
  // time doesn't accrue against grace).
  const cache = readRevocationCache();
  if (cache?.last_failed_poll_at) {
    const lastFail = Date.parse(cache.last_failed_poll_at);
    const lastSuccess = cache.last_successful_poll_at ? Date.parse(cache.last_successful_poll_at) : 0;
    if (Number.isFinite(lastFail) && lastFail - lastSuccess > GRACE_WINDOW_MS) {
      return { active: false, reason: 'stale_cache', valid_until: BB_VALID_UNTIL, days_behind: daysBehind };
    }
  }

  // st_96bb626f AC-13 — per-install 90-day expiry, ANDed with the build-global
  // cohort gate above. Reached only after the cohort JWT verifies, is in-window
  // (±skew), is unrevoked, and the revocation cache is fresh — so a valid cohort
  // with a passed install clock still degrades Black Belt → White. Effective
  // expiry is the EARLIER of the two clocks. Same ±10min skew tolerance the
  // cohort check uses, for symmetric NTP-drift behavior. readInstallExpiry()
  // returns null (never throws) when there is no install file, so an install
  // without the field is treated as not-yet-expiring — this gate can only
  // tighten entitlement, never loosen it.
  const installExpRaw = readInstallExpiry();
  if (installExpRaw !== null) {
    const installExp = Date.parse(installExpRaw);
    if (Number.isFinite(installExp) && now > installExp + CLOCK_SKEW_TOLERANCE_MS) {
      const effectiveUntil = installExp <= exp ? installExpRaw : BB_VALID_UNTIL;
      return {
        active: false,
        reason: 'install_expired',
        valid_until: effectiveUntil,
        days_behind: Math.floor((now - installExp) / 86400000),
      };
    }
  }

  return { active: true, valid_until: BB_VALID_UNTIL, days_behind: daysBehind };
}

/**
 * Boolean convenience wrapper.
 */
export async function isBBActive() {
  return (await getBBStatus()).active;
}
