/**
 * Setup-route helpers. Shared DB access + session resolution used by every
 * step computer and by the route handlers.
 *
 * All query logic lives in lib/setup-queries.js — this file is a thin wrapper
 * that binds the module-level db singleton to the lib functions.
 */
import db from '../../lib/db.js';
import {
  safeGetQuery,
  safeAllQuery,
  readUserSetting,
  writeUserSetting,
  accountHasVendorType,
} from '../../lib/setup-queries.js';

/** Safe single-value SELECT. Returns null if table/row missing. */
export function safeGet(sql, ...params) {
  return safeGetQuery(db, sql, ...params);
}

export function safeAll(sql, ...params) {
  return safeAllQuery(db, sql, ...params);
}

export function readSetting(key) {
  return readUserSetting(db, key);
}

export function writeSetting(key, value) {
  writeUserSetting(db, key, value);
}

/**
 * Resolve the effective user. If a session user is present, use it.
 * If no session user but the request reached the Black Belt app via bearer
 * auth, treat as the owner (local single-user mode).
 */
export function effectiveUser(c) {
  const user = c.get('user');
  if (user) return { id: user.id, email: user.email, source: 'session' };
  // Local bearer-token flow: no session, but requireAuth() already validated
  // the token upstream. Treat as the owner (user id 1).
  if (c.get('belt') !== 'demo') {
    return { id: 1, email: null, source: 'bearer' };
  }
  return null;
}

/** Does an `accounts` row exist for this vendor + type? */
export function accountHas(vendor, type) {
  return accountHasVendorType(db, vendor, type);
}
