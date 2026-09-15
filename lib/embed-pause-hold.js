import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TTL_MS = 15 * 60_000;
const CACHE_MS = 250;

let cache = {
  checkedAt: 0,
  file: '',
  value: null,
};

export function embedPauseHoldFile() {
  return process.env.ROBOTDOJO_EMBED_PAUSE_HOLD_FILE
    || path.join(os.homedir(), '.robotdojo', 'runtime', 'embed-pause-hold.json');
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function exclusiveWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function clearCache() {
  cache = { checkedAt: 0, file: '', value: null };
}

function publicHoldSnapshot(hold) {
  if (!hold || typeof hold !== 'object') return null;
  const { token, ...rest } = hold;
  return rest;
}

function holdOwnerAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return true;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    return true;
  }
}

export function readEmbedPauseHold({ now = Date.now(), maxCacheMs = CACHE_MS } = {}) {
  const file = embedPauseHoldFile();
  if (cache.file === file && (now - cache.checkedAt) < maxCacheMs) return cache.value;

  let value = { active: false, reason: 'embed_pause_hold_missing', file };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const hold = JSON.parse(raw);
    const expiresAt = Number(hold.expires_at) || 0;
    if (expiresAt > now && !holdOwnerAlive(hold.pid)) {
      value = {
        active: false,
        reason: 'embed_pause_hold_owner_dead',
        file,
        token: hold.token || null,
        hold,
      };
      try { fs.unlinkSync(file); } catch { /* best effort stale cleanup */ }
    } else if (expiresAt > now) {
      value = {
        active: true,
        reason: hold.reason || 'embed_pause_hold_active',
        file,
        token: hold.token || null,
        hold,
      };
    } else {
      value = {
        active: false,
        reason: 'embed_pause_hold_expired',
        file,
        token: hold.token || null,
        hold,
      };
      try { fs.unlinkSync(file); } catch { /* best effort stale cleanup */ }
    }
  } catch (err) {
    value = {
      active: false,
      reason: err?.code === 'ENOENT' ? 'embed_pause_hold_missing' : 'embed_pause_hold_unreadable',
      file,
      error: err?.code || err?.message || String(err),
    };
  }

  cache = { checkedAt: now, file, value };
  return value;
}

export function beginEmbedPauseHold({
  reason = 'embed_pause_hold_active',
  ttlMs = DEFAULT_TTL_MS,
  metadata = {},
} = {}) {
  const now = Date.now();
  const file = embedPauseHoldFile();
  const current = readEmbedPauseHold({ now, maxCacheMs: 0 });
  if (current.active) {
    return {
      ok: false,
      reason: 'embed_pause_hold_conflict',
      file,
      current_reason: current.reason,
      current_hold: publicHoldSnapshot(current.hold),
    };
  }

  const hold = {
    token: crypto.randomUUID(),
    reason,
    created_at: now,
    expires_at: now + Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
    ttl_ms: Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
    pid: process.pid,
    metadata,
  };
  try {
    exclusiveWriteJson(file, hold);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const latest = readEmbedPauseHold({ now: Date.now(), maxCacheMs: 0 });
      return {
        ok: false,
        reason: 'embed_pause_hold_conflict',
        file,
        current_reason: latest.reason,
        current_hold: publicHoldSnapshot(latest.hold),
      };
    }
    throw err;
  }
  clearCache();
  return {
    ok: true,
    reason: 'embed_pause_hold_active',
    file,
    token: hold.token,
    hold,
  };
}

export function refreshEmbedPauseHold(freeze, {
  ttlMs,
  metadata,
} = {}) {
  const file = embedPauseHoldFile();
  const expectedToken = freeze?.token || freeze?.hold?.token || null;
  if (!expectedToken) {
    return { ok: false, reason: 'embed_pause_hold_no_token', file };
  }

  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.token !== expectedToken) {
      return {
        ok: false,
        reason: 'embed_pause_hold_changed',
        file,
        expected_token: expectedToken,
        current_token: current.token || null,
        current_reason: current.reason || null,
      };
    }
    const nextTtl = Math.max(1_000, Number(ttlMs || current.ttl_ms) || DEFAULT_TTL_MS);
    const next = {
      ...current,
      expires_at: Date.now() + nextTtl,
      ttl_ms: nextTtl,
      refreshed_at: Date.now(),
      metadata: metadata ? { ...(current.metadata || {}), ...metadata } : current.metadata,
    };
    atomicWriteJson(file, next);
    clearCache();
    return {
      ok: true,
      reason: 'embed_pause_hold_refreshed',
      file,
      token: expectedToken,
      hold: next,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      clearCache();
      return { ok: false, reason: 'embed_pause_hold_missing_on_refresh', file, token: expectedToken };
    }
    return {
      ok: false,
      reason: 'embed_pause_hold_refresh_failed',
      file,
      token: expectedToken,
      error: err?.message || String(err),
    };
  }
}

export function releaseEmbedPauseHold(freeze) {
  const file = embedPauseHoldFile();
  const expectedToken = freeze?.token || freeze?.hold?.token || null;
  if (!expectedToken) return { ok: true, skipped: true, reason: 'embed_pause_hold_no_token', file };

  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.token !== expectedToken) {
      return {
        ok: true,
        skipped: true,
        reason: 'embed_pause_hold_changed',
        file,
        expected_token: expectedToken,
        current_token: current.token || null,
      };
    }
    fs.unlinkSync(file);
    clearCache();
    return { ok: true, reason: 'embed_pause_hold_released', file, token: expectedToken };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      clearCache();
      return { ok: true, skipped: true, reason: 'embed_pause_hold_missing_on_release', file };
    }
    return {
      ok: false,
      reason: 'embed_pause_hold_release_failed',
      file,
      error: err?.message || String(err),
    };
  }
}
