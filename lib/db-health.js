import { randomUUID } from 'node:crypto';

function pass(value = true) {
  return { ok: true, value };
}

function sanitizedMessage(err) {
  const message = err?.message ? String(err.message).slice(0, 180) : '';
  if (!message) return 'database health check failed';
  if (/[~/\\]|SQLCipher|secret|key|stack|PRAGMA|SELECT|INSERT|DELETE|CREATE/i.test(message)) {
    return 'database health check failed';
  }
  return message;
}

function fail(name, err) {
  return {
    ok: false,
    failed: name,
    message: sanitizedMessage(err),
  };
}

function runCheck(result, name, fn) {
  try {
    const value = fn();
    result.checks[name] = pass(value);
    return value;
  } catch (err) {
    result.checks[name] = fail(name, err);
    result.ok = false;
    if (!result.failed) {
      result.failed = name;
      result.message = result.checks[name].message;
    }
    return null;
  }
}

function assertReadableMigrations(database) {
  database.prepare('SELECT name FROM migrations LIMIT 1').all();
  return true;
}

function assertPing(database) {
  const row = database.prepare('SELECT 1 AS ok').get();
  if (row?.ok !== 1) throw new Error('ping returned unexpected value');
  return true;
}

function assertWalMode(database) {
  const mode = String(database.pragma('journal_mode', { simple: true }) || '').toLowerCase();
  if (mode !== 'wal') throw new Error(`journal_mode is ${mode || 'unknown'}`);
  return mode;
}

function assertForeignKeys(database) {
  const enabled = Number(database.pragma('foreign_keys', { simple: true })) === 1;
  if (!enabled) throw new Error('foreign_keys is off');
  return true;
}

function assertQuickCheck(database) {
  const value = database.pragma('quick_check', { simple: true });
  if (typeof value === 'string' && /malformed inverted index for FTS5 table main\.chunks_fts/i.test(value)) {
    database.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
    const retry = database.pragma('quick_check', { simple: true });
    if (retry === 'ok') return retry;
    throw new Error(`quick_check returned ${String(retry)}`);
  }
  if (value !== 'ok') throw new Error(`quick_check returned ${String(value)}`);
  return value;
}

function assertForeignKeyCheck(database) {
  const rows = database.pragma('foreign_key_check');
  if (Array.isArray(rows) && rows.length === 0) return 'ok';
  throw new Error(`foreign_key_check returned ${Array.isArray(rows) ? rows.length : 'unknown'} row(s)`);
}

function assertWriteReadback(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_health_probe (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const id = randomUUID();
  const probe = database.transaction(() => {
    database.prepare('INSERT INTO runtime_health_probe (id) VALUES (?)').run(id);
    const row = database.prepare('SELECT id FROM runtime_health_probe WHERE id = ?').get(id);
    if (row?.id !== id) throw new Error('probe row was not readable after insert');
    database.prepare('DELETE FROM runtime_health_probe WHERE id = ?').run(id);
    const leftover = database.prepare('SELECT id FROM runtime_health_probe WHERE id = ?').get(id);
    if (leftover) throw new Error('probe cleanup failed');
  });
  probe();
  return true;
}

export function checkDbHealth(database, { deep = false, writeReadback = false } = {}) {
  const result = {
    ok: true,
    deep: Boolean(deep),
    checks: {},
  };

  runCheck(result, 'ping', () => assertPing(database));
  runCheck(result, 'migrations_readable', () => assertReadableMigrations(database));
  runCheck(result, 'journal_mode', () => assertWalMode(database));
  runCheck(result, 'foreign_keys', () => assertForeignKeys(database));

  if (deep) {
    runCheck(result, 'quick_check', () => assertQuickCheck(database));
    runCheck(result, 'foreign_key_check', () => assertForeignKeyCheck(database));
  }

  if (deep || writeReadback) {
    runCheck(result, 'write_readback', () => assertWriteReadback(database));
  }

  return result;
}

export function flattenDbHealth(health) {
  const out = {
    ok: health.ok,
    deep: health.deep,
  };
  for (const [name, check] of Object.entries(health.checks || {})) {
    out[name] = check.ok ? check.value : false;
  }
  if (!health.ok) {
    out.failed = health.failed || Object.entries(health.checks || {}).find(([, v]) => !v.ok)?.[0] || 'unknown';
    out.message = health.message || health.checks?.[out.failed]?.message || 'database health check failed';
  }
  return out;
}

export function dbHealthFailure({ deep = false, failed = 'database', err } = {}) {
  return {
    ok: false,
    deep: Boolean(deep),
    failed,
    message: sanitizedMessage(err),
  };
}
