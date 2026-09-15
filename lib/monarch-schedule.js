/**
 * Saturday-morning Monarch pull. After Friday transaction cleanup.
 * America/New_York 08:00 unless config/env overrides.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const _REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEEKDAY_INDEX = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
});

function loadTunables() {
  let raw = {};
  try {
    if (existsSync(join(_REPO_ROOT, 'config', 'defaults.json'))) {
      raw = JSON.parse(readFileSync(join(_REPO_ROOT, 'config', 'defaults.json'), 'utf8')).monarch || {};
    }
  } catch { /* fall through */ }
  const envInt = (name, fallback) => {
    const n = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const weekday = envInt('MONARCH_SYNC_WEEKDAY', raw.syncWeekday ?? 6);
  return {
    failureBackoffMs: envInt('MONARCH_FAILURE_BACKOFF_MS', raw.failureBackoffMs ?? 24 * 60 * 60 * 1000),
    syncWeekday: weekday >= 0 && weekday <= 6 ? weekday : 6,
    syncHour: envInt('MONARCH_SYNC_HOUR', raw.syncHour ?? 8),
    syncMinute: envInt('MONARCH_SYNC_MINUTE', raw.syncMinute ?? 0),
    syncTimeZone: process.env.MONARCH_SYNC_TIMEZONE || raw.syncTimeZone || 'America/New_York',
  };
}

export function monarchSyncConfig() {
  return loadTunables();
}

function tzParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function addCalendarDays(year, month, day, days) {
  const utc = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const d = new Date(utc);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function zonedCivilToUtc(timeZone, civil) {
  const want = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour || 0,
    civil.minute || 0,
    civil.second || 0,
  );
  let ms = want;
  for (let i = 0; i < 4; i++) {
    const shown = tzParts(new Date(ms), timeZone);
    const shownMs = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    const delta = want - shownMs;
    if (delta === 0) break;
    ms += delta;
  }
  return new Date(ms);
}

export function nextSaturdayMorning({
  after = new Date(),
  timeZone,
  hour,
  minute,
  weekday,
} = {}) {
  const cfg = loadTunables();
  const tz = timeZone || cfg.syncTimeZone;
  const h = hour ?? cfg.syncHour;
  const m = minute ?? cfg.syncMinute;
  const targetDow = weekday ?? cfg.syncWeekday;
  const afterDate = new Date(after);
  const parts = tzParts(afterDate, tz);
  const currentDow = WEEKDAY_INDEX[parts.weekday];
  const delta = (targetDow - currentDow + 7) % 7;
  let civil = addCalendarDays(parts.year, parts.month, parts.day, delta);
  let candidate = zonedCivilToUtc(tz, { ...civil, hour: h, minute: m, second: 0 });
  if (candidate.getTime() <= afterDate.getTime()) {
    civil = addCalendarDays(civil.year, civil.month, civil.day, 7);
    candidate = zonedCivilToUtc(tz, { ...civil, hour: h, minute: m, second: 0 });
  }
  return candidate;
}

/**
 * After a success: next Saturday 08:00 ET strictly after that success.
 * After a newer failure: wait failureBackoffMs, then retry (still lands on
 * the next Saturday once a pull succeeds).
 */
export function monarchSyncRunAfter({ lastSuccessAt, lastFailureAt, now = new Date() } = {}) {
  const cfg = loadTunables();
  const successMs = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  const failureMs = lastFailureAt ? Date.parse(lastFailureAt) : NaN;
  if (Number.isFinite(failureMs) && (!Number.isFinite(successMs) || failureMs >= successMs)) {
    return new Date(failureMs + cfg.failureBackoffMs).toISOString();
  }
  if (Number.isFinite(successMs)) {
    return nextSaturdayMorning({ after: lastSuccessAt }).toISOString();
  }
  return new Date(now).toISOString();
}
