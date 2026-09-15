/**
 * Eight Sleep sync — password-grant against the mobile app OAuth client,
 * then nightly sleep trends into health_data_points.
 *
 * Secrets: robotdojo-EIGHT_SLEEP_EMAIL, robotdojo-EIGHT_SLEEP_PASSWORD.
 * Session (access/refresh, no password): robotdojo-EIGHT_SLEEP_SESSION.
 */
import db from './db.js';
import { secret } from './config.js';
import { readKeychainSecret, writeKeychainSecret } from './keychain.js';
import { insertTimelineEvent } from './timeline-schema.js';
import { healthDataPointSourceId } from './health-data-point-source.js';

const AUTH_URL = 'https://auth-api.8slp.net/v1/tokens';
const CLIENT_API = 'https://client-api.8slp.net/v1';
const SESSION_KEY = 'EIGHT_SLEEP_SESSION';
const TOKEN_SKEW_MS = 120_000;
const DEFAULT_TZ = 'America/New_York';

// Public OAuth client embedded in the Eight Sleep iOS/Android app.
// Required for grant_type=password. Not a user secret.
const APP_OAUTH_CLIENT_ID = '0894c7f33bb94800a03f1f4df13a4f38';
const APP_OAUTH_CLIENT_SECRET = 'f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76';

const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'okhttp/4.9.3',
};

const MARKERS = {
  eight_sleep_score: {
    name: 'Eight Sleep Score', unit: 'score', group_id: 'sleep', view: 'focus',
    description: 'Eight Sleep nightly sleep score (0-100)',
  },
  eight_sleep_quality: {
    name: 'Eight Sleep Quality', unit: 'score', group_id: 'sleep', view: 'summary',
    description: 'Eight Sleep sleep quality score (0-100)',
  },
  eight_sleep_total_sleep: {
    name: 'Eight Sleep Total Sleep', unit: 'hours', group_id: 'sleep', view: 'focus',
    description: 'Total sleep duration (hours)',
  },
  eight_sleep_deep_sleep: {
    name: 'Eight Sleep Deep Sleep', unit: 'min', group_id: 'sleep', view: 'summary',
    description: 'Deep sleep duration (minutes); stage labels are secondary',
  },
  eight_sleep_rem_sleep: {
    name: 'Eight Sleep REM Sleep', unit: 'min', group_id: 'sleep', view: 'summary',
    description: 'REM sleep duration (minutes); stage labels are secondary',
  },
  eight_sleep_light_sleep: {
    name: 'Eight Sleep Light Sleep', unit: 'min', group_id: 'sleep', view: 'all',
    description: 'Light sleep duration (minutes); stage labels are secondary',
  },
  eight_sleep_hrv: {
    name: 'Eight Sleep HRV', unit: 'ms', group_id: 'sleep', view: 'focus',
    description: 'Overnight heart rate variability (ms)',
  },
  eight_sleep_rhr: {
    name: 'Eight Sleep RHR', unit: 'bpm', group_id: 'sleep', view: 'focus',
    description: 'Average heart rate during sleep (bpm)',
  },
  eight_sleep_respiratory_rate: {
    name: 'Eight Sleep Respiratory Rate', unit: 'breaths/min', group_id: 'sleep', view: 'summary',
    description: 'Average overnight respiratory rate',
  },
};

const insertMarker = db.prepare(`
  INSERT OR IGNORE INTO health_markers (id, name, unit, group_id, view, description)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function ensureMarkers(ids) {
  db.prepare(`
    INSERT OR IGNORE INTO health_groups (id, name, description)
    VALUES ('sleep', 'Sleep', 'Sleep, recovery, HRV, and circadian rhythm')
  `).run();
  const tx = db.transaction((markerIds) => {
    for (const id of markerIds) {
      const marker = MARKERS[id];
      if (!marker) continue;
      insertMarker.run(id, marker.name, marker.unit, marker.group_id, marker.view, marker.description);
    }
  });
  tx([...new Set(ids)]);
}

function padDate(date) {
  return date.toISOString().slice(0, 10);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function secondsToHours(sec) {
  const n = toNumber(sec);
  if (n == null || n <= 0) return null;
  return Math.round(n / 360) / 10;
}

function secondsToMinutes(sec) {
  const n = toNumber(sec);
  if (n == null || n <= 0) return null;
  return Math.round(n / 60);
}

function defaultKeychain() {
  return {
    read: (name) => readKeychainSecret(name),
    write: (name, value) => writeKeychainSecret(name, value),
  };
}

function readSession(keychain) {
  const raw = keychain.read(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.password || parsed.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(keychain, session) {
  const stored = {
    kind: 'token',
    access_token: session.access_token,
    refresh_token: session.refresh_token || undefined,
    token_type: session.token_type || 'Bearer',
    user_id: session.user_id || null,
    expires_at: session.expires_at || null,
    obtainedAt: session.obtainedAt || new Date().toISOString(),
  };
  if (!stored.access_token) throw new Error('Eight Sleep session missing access token');
  keychain.write(SESSION_KEY, JSON.stringify(stored));
  return stored;
}

function sessionFresh(session) {
  if (!session?.access_token) return false;
  if (!session.expires_at) return true;
  const exp = Date.parse(session.expires_at);
  return Number.isFinite(exp) && exp - TOKEN_SKEW_MS > Date.now();
}

function makeCtx(opts = {}) {
  return {
    keychain: opts.keychain || defaultKeychain(),
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    email: opts.email || secret('EIGHT_SLEEP_EMAIL'),
    password: opts.password || secret('EIGHT_SLEEP_PASSWORD'),
  };
}

async function authRequest(ctx, body) {
  const res = await ctx.fetchImpl(AUTH_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok || !json?.access_token) {
    throw new Error(`Eight Sleep auth HTTP ${res.status}`);
  }
  const expiresIn = Number(json.expires_in || 0);
  return writeSession(ctx.keychain, {
    access_token: json.access_token,
    refresh_token: json.refresh_token || null,
    token_type: json.token_type || 'Bearer',
    user_id: json.userId || json.user_id || null,
    expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    obtainedAt: new Date().toISOString(),
  });
}

async function loginWithPassword(ctx) {
  if (!ctx.email || !ctx.password) throw new Error('EIGHT_SLEEP_EMAIL or EIGHT_SLEEP_PASSWORD not in Keychain');
  return authRequest(ctx, {
    client_id: APP_OAUTH_CLIENT_ID,
    client_secret: APP_OAUTH_CLIENT_SECRET,
    grant_type: 'password',
    username: ctx.email,
    password: ctx.password,
  });
}

async function loginWithRefresh(ctx, refreshToken) {
  return authRequest(ctx, {
    client_id: APP_OAUTH_CLIENT_ID,
    client_secret: APP_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

async function getSession(ctx) {
  const existing = readSession(ctx.keychain);
  if (sessionFresh(existing)) return existing;
  if (existing?.refresh_token) {
    try {
      return await loginWithRefresh(ctx, existing.refresh_token);
    } catch {
      // Password grant is the fallback; refresh expiry is expected.
    }
  }
  return loginWithPassword(ctx);
}

async function apiGet(ctx, session, path, { query } = {}) {
  const url = new URL(`${CLIENT_API}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
  }
  const res = await ctx.fetchImpl(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${session.access_token}`,
      'user-agent': JSON_HEADERS['user-agent'],
    },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) {
    const err = new Error('Eight Sleep HTTP 401');
    err.code = 'EIGHT_SLEEP_UNAUTHORIZED';
    throw err;
  }
  if (!res.ok) throw new Error(`Eight Sleep ${path} HTTP ${res.status}`);
  return res.json();
}

async function apiGetWithRefresh(ctx, session, path, opts) {
  try {
    return { session, data: await apiGet(ctx, session, path, opts) };
  } catch (err) {
    if (err.code !== 'EIGHT_SLEEP_UNAUTHORIZED') throw err;
    const next = await loginWithPassword(ctx);
    return { session: next, data: await apiGet(ctx, next, path, opts) };
  }
}

async function resolveUserId(ctx, session) {
  if (session.user_id) return { session, userId: session.user_id };
  const { session: next, data } = await apiGetWithRefresh(ctx, session, '/users/me');
  const userId = data?.user?.userId || data?.user?.id || null;
  if (!userId) throw new Error('Eight Sleep /users/me returned no userId');
  const stored = writeSession(ctx.keychain, { ...next, user_id: userId });
  return { session: stored, userId };
}

function nestedCurrent(obj) {
  if (obj == null) return null;
  if (typeof obj === 'number') return toNumber(obj);
  if (typeof obj === 'object') {
    return toNumber(obj.current ?? obj.average);
  }
  return toNumber(obj);
}

function parseTrendDay(day) {
  const date = String(day?.day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const quality = day.sleepQualityScore || {};
  const rows = [
    { date, markerId: 'eight_sleep_score', value: toNumber(day.score), unit: 'score' },
    { date, markerId: 'eight_sleep_quality', value: toNumber(quality.total), unit: 'score' },
    { date, markerId: 'eight_sleep_total_sleep', value: secondsToHours(day.sleepDuration), unit: 'hours' },
    { date, markerId: 'eight_sleep_deep_sleep', value: secondsToMinutes(day.deepDuration), unit: 'min' },
    { date, markerId: 'eight_sleep_rem_sleep', value: secondsToMinutes(day.remDuration), unit: 'min' },
    { date, markerId: 'eight_sleep_light_sleep', value: secondsToMinutes(day.lightDuration), unit: 'min' },
    { date, markerId: 'eight_sleep_hrv', value: nestedCurrent(quality.hrv), unit: 'ms' },
    { date, markerId: 'eight_sleep_rhr', value: nestedCurrent(quality.heartRate), unit: 'bpm' },
    { date, markerId: 'eight_sleep_respiratory_rate', value: nestedCurrent(quality.respiratoryRate), unit: 'breaths/min' },
  ];
  return rows.filter(row => row.value != null && Number.isFinite(row.value));
}

const insertNote = db.prepare(`
  INSERT OR REPLACE INTO health_notes (date, content, tags, source, created_at)
  VALUES (?, ?, ?, 'eightsleep', datetime('now'))
`);

const insertDataPoint = db.prepare(`
  INSERT INTO health_data_points
    (marker_id, date, value, source, source_file, source_id, specimen_type, excluded, exclude_reason, created_at)
  VALUES (?, ?, ?, 'eight_sleep_sync', 'eight-sleep-api', ?, 'wearable', 0, NULL, datetime('now'))
  ON CONFLICT(source_id) DO UPDATE SET
    value = excluded.value,
    source_file = excluded.source_file,
    specimen_type = excluded.specimen_type,
    excluded = 0,
    exclude_reason = NULL
`);

function upsertMetrics(rows) {
  ensureMarkers(rows.map(row => row.markerId));
  let chartPoints = 0;
  const tx = db.transaction((entries) => {
    for (const row of entries) {
      const content = `${row.markerId}: ${row.value}${row.unit ? ` ${row.unit}` : ''}`;
      insertNote.run(row.date, content, JSON.stringify(['eightsleep', row.markerId]));
      insertTimelineEvent({
        sourceType: 'eightsleep',
        sourceId: `eightsleep:${row.markerId}:${row.date}`,
        eventDate: row.date,
        eventType: 'health_note',
        summary: content,
        content,
        metadata: { metric: row.markerId, tags: ['eightsleep', row.markerId] },
      });
      const rounded = Math.round(Number(row.value) * 100) / 100;
      const sourceId = healthDataPointSourceId({
        source: 'eight_sleep_sync',
        markerId: row.markerId,
        date: row.date,
        value: rounded,
        sourceFile: 'eight-sleep-api',
      });
      const result = insertDataPoint.run(row.markerId, row.date, rounded, sourceId);
      if (result.changes > 0) chartPoints += 1;
    }
  });
  tx(rows);
  return { chartPoints };
}

function touchAccount() {
  db.prepare(`
    INSERT OR IGNORE INTO accounts
      (id, provider, display_name, status, metadata, created_at, updated_at, vendor, type, keychain_key)
    VALUES
      ('eightsleep:health', 'eightsleep', 'Eight Sleep', 'active', '{}', datetime('now'), datetime('now'), 'eightsleep', 'health', 'robotdojo-EIGHT_SLEEP_PASSWORD')
  `).run();
  db.prepare(`
    UPDATE accounts
       SET synced_at = datetime('now'), last_error = NULL, updated_at = datetime('now'), status = 'active'
     WHERE vendor = 'eightsleep'
  `).run();
}

export async function syncEightSleepData(opts = {}) {
  const through = opts.through || new Date();
  const since = opts.since || new Date(Date.now() - 30 * 86400_000);
  const startDate = padDate(since);
  const endDate = padDate(through);
  const tz = opts.tz || process.env.EIGHT_SLEEP_TZ || DEFAULT_TZ;
  const ctx = makeCtx(opts);

  let session = await getSession(ctx);
  const resolved = await resolveUserId(ctx, session);
  session = resolved.session;

  const { data } = await apiGetWithRefresh(ctx, session, `/users/${resolved.userId}/trends`, {
    query: {
      tz,
      from: startDate,
      to: endDate,
      'include-main': 'false',
      'include-all-sessions': 'true',
      'model-version': 'v2',
    },
  });

  const days = Array.isArray(data?.days) ? data.days : [];
  const rows = days.flatMap(parseTrendDay);
  const { chartPoints } = upsertMetrics(rows);
  touchAccount();
  console.info(`[eight-sleep-sync] synced ${rows.length} metrics, ${chartPoints} chart points (${startDate} → ${endDate})`);
  return { synced: rows.length, chartPoints };
}

export async function syncEightSleepLatest() {
  return syncEightSleepData({ since: new Date(Date.now() - 14 * 86400_000) });
}
