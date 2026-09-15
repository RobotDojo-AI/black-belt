/**
 * Onboarding ETA — convert ingest queue depth into a wall-clock estimate.
 *
 * Formula: `eta_seconds = ceil((remaining / msgs_per_sec_p50) + safety_margin_s)`
 *
 * Throughput baselines come from observed rates on a reference M-series Mac:
 *   - Gmail ingest: ~10 msgs/sec sustained (rate-limited by Gmail quota,
 *     not CPU). Spec promises "first 1,000 within ~2 minutes" → 8.3/sec, so
 *     10 is the optimistic-realistic mid-band.
 *   - iMessage backfill: ~250 msgs/sec (pure local SQLite copy + chunk).
 *   - Contacts/Calendar: bounded by API call count, not message count, and
 *     they typically finish in <60s at any reasonable scale. We expose ETAs
 *     that flip to `0` (= done) once the relevant table is non-empty AND no
 *     producer process is actively writing.
 *
 * Safety margin: 15s on top of every ETA to absorb GC pauses, brief Gmail
 * 429s, and the user-perception buffer. Without it the UI counts down to
 * "0 — almost there" and then sits there for 30s, which feels worse than a
 * conservative number that actually arrives on time.
 *
 * Edge cases (see failure manifest in routes/setup/onboarding.js):
 *   - Empty queue (denominator = 0) → ETA = 0, never NaN.
 *   - Queue table missing → ETA = null (caller renders "—").
 *   - Producer not started yet → remaining unknown; report `total = received,
 *     remaining = 0, eta_s = 0`. The `started` boolean lets the UI explain.
 */

import db from './db.js';

/**
 * Local safeGet — wraps db.prepare/get and swallows errors. Mirrors
 * routes/setup/helpers.js#safeGet but avoids the lib → routes back-reference
 * (lib must not depend on routes).
 */
function safeGet(sql, ...params) {
  try { return db.prepare(sql).get(...params); }
  catch { return null; }
}

// Throughput tuning — single place to revise as we observe real installs.
const RATE = {
  gmail:    10,     // msgs/sec
  imessage: 250,    // msgs/sec
  contacts: 50,     // contacts/sec (post-permission probe to people insert)
  calendar: 30,     // events/sec
};
const SAFETY_MARGIN_S = 15;

/**
 * Compute ETA seconds given `(remaining, ratePerSec)`. Always returns a
 * non-negative integer. Returns 0 (not NaN) for empty queues, and null only
 * when caller passed in null/undefined explicitly — empty queues have a
 * meaningful ETA of "done now".
 */
export function etaSeconds(remaining, ratePerSec) {
  if (remaining === null || remaining === undefined) return null;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  if (!ratePerSec || !Number.isFinite(ratePerSec) || ratePerSec <= 0) return null;
  return Math.ceil(remaining / ratePerSec) + SAFETY_MARGIN_S;
}

/**
 * Read `(received, total_known, started)` for each ingest stream by inspecting
 * the database directly. Producers that haven't started leave the `_total`
 * settings unset; we treat that as "ingest not begun" and the UI shows the
 * "Connecting…" microcopy rather than a misleading ETA.
 */
function streamGmail() {
  const received = safeGet(`SELECT COUNT(*) AS c FROM emails`)?.c || 0;
  // The Gmail sync writer records the discovered total in user_settings as
  // 'gmail_total_known' (set on the first listMessages page). When unset,
  // we don't know the denominator — surface that, don't fabricate.
  const totalKnownRow = safeGet(
    `SELECT value FROM user_settings WHERE key = 'gmail_total_known'`,
  );
  const totalKnown = totalKnownRow ? parseInt(totalKnownRow.value, 10) : null;
  const started = received > 0 || (totalKnown != null && totalKnown > 0);
  const remaining = totalKnown != null ? Math.max(0, totalKnown - received) : null;
  return { received, total: totalKnown, remaining, started, rate: RATE.gmail };
}

function streamImessage() {
  // iMessage data lives in `chunks` with source_type='imessage' (no separate
  // `imessages` table — see lib/migrations/000_base_entities.sql).
  const received = safeGet(
    `SELECT COUNT(*) AS c FROM chunks WHERE source_type = 'imessage'`,
  )?.c || 0;
  const totalKnownRow = safeGet(
    `SELECT value FROM user_settings WHERE key = 'imessage_total_known'`,
  );
  const totalKnown = totalKnownRow ? parseInt(totalKnownRow.value, 10) : null;
  const started = received > 0 || (totalKnown != null && totalKnown > 0);
  const remaining = totalKnown != null ? Math.max(0, totalKnown - received) : null;
  return { received, total: totalKnown, remaining, started, rate: RATE.imessage };
}

function streamContacts() {
  // Contacts ingest is fast (single AddressBook scan) and finishes within seconds.
  // We treat people-table population as the signal. No queue table; remaining is
  // unknown ahead of time, so once started we report eta=0.
  const received = safeGet(`SELECT COUNT(*) AS c FROM people`)?.c || 0;
  const totalKnownRow = safeGet(
    `SELECT value FROM user_settings WHERE key = 'contacts_total_known'`,
  );
  const totalKnown = totalKnownRow ? parseInt(totalKnownRow.value, 10) : null;
  const started = received > 0 || (totalKnown != null && totalKnown > 0);
  const remaining = totalKnown != null ? Math.max(0, totalKnown - received) : 0;
  return { received, total: totalKnown, remaining, started, rate: RATE.contacts };
}

function streamCalendar() {
  // Calendar events are stored as chunks (source_type='calendar') by the
  // Google Calendar sync. No separate `calendar_events` table on this install.
  const received = safeGet(
    `SELECT COUNT(*) AS c FROM chunks WHERE source_type = 'calendar'`,
  )?.c || 0;
  const totalKnownRow = safeGet(
    `SELECT value FROM user_settings WHERE key = 'calendar_total_known'`,
  );
  const totalKnown = totalKnownRow ? parseInt(totalKnownRow.value, 10) : null;
  const started = received > 0 || (totalKnown != null && totalKnown > 0);
  const remaining = totalKnown != null ? Math.max(0, totalKnown - received) : 0;
  return { received, total: totalKnown, remaining, started, rate: RATE.calendar };
}

/**
 * Public API for the Stage 6 ETA card. Returns the four canonical streams
 * with `{ eta_s, received, total, started }` per stream, plus a top-line
 * `eta_seconds` (the max of all stream ETAs — the long-pole determines when
 * the user can stop watching). All numbers are safe to render directly.
 */
export function computeOnboardingEta() {
  const streams = {
    gmail:    streamGmail(),
    imessage: streamImessage(),
    contacts: streamContacts(),
    calendar: streamCalendar(),
  };

  const out = {};
  let maxEta = 0;
  for (const [key, s] of Object.entries(streams)) {
    const eta = etaSeconds(s.remaining, s.rate);
    out[`${key}_eta_s`] = eta;
    out[`${key}_received`] = s.received;
    out[`${key}_total`] = s.total;
    out[`${key}_started`] = s.started;
    if (eta != null && eta > maxEta) maxEta = eta;
  }
  out.eta_seconds = maxEta;
  return out;
}
