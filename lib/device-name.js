import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import config from './config.js';
import { writeUserSetting } from './setup-queries.js';

export function normalizeDeviceLabel(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function slugFromDeviceLabel(value) {
  return normalizeDeviceLabel(value)
    .toLowerCase()
    .replace(/\.local$/i, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function readInstalledDeviceName() {
  try {
    const stored = normalizeDeviceLabel(readFileSync(resolve(config.configDir, 'device-name'), 'utf8'));
    if (stored) return stored;
  } catch {}
  return normalizeDeviceLabel(hostname().replace(/\.local$/i, ''));
}

export function readInitialRelaySlug() {
  try {
    return slugFromDeviceLabel(readFileSync(resolve(config.configDir, 'initial-slug'), 'utf8'));
  } catch {
    return null;
  }
}

export function isGeneratedOwnerSlug(value) {
  return /^owner-[a-f0-9]{4,16}$/i.test(String(value || ''));
}

export function resolveLoginServerName(userSlug = null) {
  return slugFromDeviceLabel(config.deviceSlug)
    || readInitialRelaySlug()
    || slugFromDeviceLabel(readInstalledDeviceName())
    || (!isGeneratedOwnerSlug(userSlug) ? slugFromDeviceLabel(userSlug) : null)
    || null;
}

export function repairGeneratedDeviceSlug(db, row, displayName = readInstalledDeviceName()) {
  const loginSlug = resolveLoginServerName(row?.user_slug);
  if (!row || !loginSlug || !isGeneratedOwnerSlug(row.user_slug)) return row?.user_slug || null;
  try {
    const existing = db.prepare('SELECT id FROM users WHERE user_slug = ? AND is_admin = 0 LIMIT 1').get(loginSlug);
    if (existing) return row.user_slug;
    const oldSlug = row.user_slug;
    db.prepare('UPDATE users SET user_slug = ? WHERE is_admin = 1 AND user_slug = ?').run(loginSlug, oldSlug);
    db.prepare('UPDATE users SET user_handle = ? WHERE is_admin = 1 AND (user_handle IS NULL OR user_handle = ?)').run(loginSlug, oldSlug);
    writeUserSetting(db, 'device_display_name', normalizeDeviceLabel(displayName) || loginSlug);
    row.user_slug = loginSlug;
  } catch {}
  return row.user_slug;
}
