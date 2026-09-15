/**
 * SQLite connection — single WAL-mode instance shared across all modules.
 * Connects to the Robot Dojo database (robotdojo.db) and adds tables via migrate().
 *
 * Default path: `~/.robotdojo/robotdojo.db`. Override via `ROBOTDOJO_DB` env.
 *
 * The DB is encrypted at rest with SQLCipher. The key lives in the macOS
 * Keychain (`robotdojo-LOCAL_DB_KEY`). First boot generates + stores it; every
 * subsequent boot reads it back. A pre-existing plaintext DB is migrated to
 * encrypted on the first boot after this code ships.
 *
 * Binding: `better-sqlite3-multiple-ciphers` — API-compatible fork of
 * `better-sqlite3` with SQLCipher-4 support. `better-sqlite3` is kept as
 * a peer for the transient "am I plaintext?" probe in db-encryption.js.
 */
import EncryptedDatabase from 'better-sqlite3-multiple-ciphers';
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir, totalmem } from 'node:os';
import * as sqliteVec from 'sqlite-vec';
import crypto from 'node:crypto';
import {
  loadOrGenerateLocalKey,
  applyKeyPragma,
  isPlaintext,
  migrateToEncrypted,
} from './db-encryption.js';
import { syncTaxonomyToDb } from './taxonomy.js';
import { UNCATEGORIZED_LABEL } from './topic-routing-policy.js';
import { reconcileWorkbenchesFromDisk } from './workbenches.js';
import config from './config.js';
import { USER_DATABASES_DIR, REPO_ROOT } from './robotdojo-paths.js';
import { deriveHealthSpecimenType, healthDataPointSourceId } from './health-data-point-source.js';
import { ensureHealthCoachSchema } from './health-coach-schema.js';
import { migrateLegacySecondAsana } from './legacy-provider-rename.js';

const TEST_DB_PATH =
  process.env.NODE_TEST_CONTEXT
    ? ':memory:'
    : null;
const DB_PATH = process.env.ROBOTDOJO_DB || TEST_DB_PATH || resolve(config.configDir, 'robotdojo.db');

// ── st_8745309c: worktree-vs-production-DB hard refusal ─────────────────
//
// A Claude Code session launched inside a git worktree that has NOT set
// ROBOTDOJO_DATABASES_ROOT would, by default, open the production database.
// Worktrees share the main DB by accident (paths in robotdojo-paths.js are
// absolute, computed from homedir() not __dirname). A misconfigured
// worktree session would silently contaminate production state.
//
// The fix is hard refusal at import time. Three conditions:
//
//   (1) Worktree detected: ROBOTDOJO_WORKTREE=1 set OR `.git` is a FILE
//       (every git worktree has `.git` as a file pointing at the main
//       .git directory; the main checkout has `.git` as a directory).
//   (2) ROBOTDOJO_DATABASES_ROOT is NOT set (no isolation configured).
//   (3) The resolved DB path lands inside a production database location
//       (either ~/.robotdojo/ or ~/robotdojo/user/databases/).
//
// All three must be true to refuse. If condition (1) is false this is a
// normal main-checkout session and nothing changes — the production server
// and every existing script that imports db.js continues to work. If (2)
// is true the operator chose explicit isolation. If (3) is false the path
// already points at a non-production DB.
//
// Escape valves:
//   - ROBOTDOJO_DATABASES_ROOT=/tmp/... isolates per-worktree (set by
//     scripts/worktree-init.sh into .env.local).
//   - ROBOTDOJO_DB pointing at a non-production path bypasses condition (3).
//   - ROBOTDOJO_WORKTREE_ALLOW_PROD=1 explicitly overrides for the rare
//     case where a worktree session legitimately must touch prod (the
//     story's own dogfooding pass, for instance). Documented escape.
//   - NODE_TEST_CONTEXT → :memory: short-circuits before this check.
function isWorktreeCheckout() {
  if (process.env.ROBOTDOJO_WORKTREE === '1') return true;
  try {
    const gitPath = join(REPO_ROOT, '.git');
    if (!existsSync(gitPath)) return false;
    return statSync(gitPath).isFile();
  } catch {
    return false;
  }
}

function isProductionDbPath(p) {
  if (!p || p === ':memory:') return false;
  const resolved = resolve(p);
  const configDirPrefix = resolve(config.configDir) + '/';
  const userDbPrefix = resolve(USER_DATABASES_DIR) + '/';
  return resolved.startsWith(configDirPrefix) || resolved.startsWith(userDbPrefix);
}

if (
  DB_PATH !== ':memory:'
  && process.env.ROBOTDOJO_WORKTREE_ALLOW_PROD !== '1'
  && isWorktreeCheckout()
  && !process.env.ROBOTDOJO_DATABASES_ROOT
  && isProductionDbPath(DB_PATH)
) {
  const msg =
    `FATAL: Worktree session detected but ROBOTDOJO_DATABASES_ROOT is not set.\n` +
    `This session would connect to the production database at:\n` +
    `  ${DB_PATH}\n` +
    `Set ROBOTDOJO_DATABASES_ROOT to a per-worktree temp path before starting Claude Code\n` +
    `in a worktree, or run scripts/worktree-init.sh to configure isolation automatically.\n` +
    `(Escape: ROBOTDOJO_WORKTREE_ALLOW_PROD=1 to explicitly opt back into prod.)\n`;
  process.stderr.write(msg);
  process.exit(1);
}

// Ensure the parent directory exists before the driver tries to create the
// DB file. better-sqlite3 creates the file but throws if the directory is
// missing. Skip for :memory: paths.
if (DB_PATH !== ':memory:') {
  try { mkdirSync(dirname(DB_PATH), { recursive: true }); } catch { /* exists */ }
}

// Fresh DB files are created by the underlying driver (better-sqlite3 /
// SQLCipher). Schema is loaded via `scripts/migrate.js`; smoke tests and
// fresh installs bootstrap through that path — we do not pre-gate here.

// Auto-migrate plaintext → encrypted, BUT only for DBs that belong to the
// Robot Dojo install (paths under ~/.robotdojo/ for the installed product,
// or ~/robotdojo/user/databases/ for user-private local data).
// Any DB pointed to via ROBOTDOJO_DB outside those directories is treated as
// an external/dev DB and left alone — auto-encrypting a file another process
// is using would lock it out for 30+ minutes on large DBs.
const isRobotDojoPath = DB_PATH.startsWith(resolve(config.configDir) + '/')
  || DB_PATH.startsWith(resolve(USER_DATABASES_DIR) + '/');
const ANN_DIR_EXPLICIT = !!process.env.ROBOTDOJO_ANN_DIR;
const dbPathExists = DB_PATH !== ':memory:' && existsSync(DB_PATH);
const plaintextRobotDojoDb = isRobotDojoPath && dbPathExists && await isPlaintext(DB_PATH);
let LOCAL_DB_KEY = null;
if (isRobotDojoPath) {
  // `loadOrGenerateLocalKey()` reads the key from macOS Keychain, creating one
  // only on true first boot or plaintext migration. If an encrypted DB already
  // exists and Keychain is unavailable, fail closed instead of minting a
  // mismatched replacement key.
  LOCAL_DB_KEY = loadOrGenerateLocalKey({ allowGenerate: !dbPathExists || plaintextRobotDojoDb });
  if (plaintextRobotDojoDb) {
    console.error('[db] plaintext Robot Dojo DB detected — migrating to encrypted…');
    await migrateToEncrypted(DB_PATH, LOCAL_DB_KEY);
    console.error('[db] migration complete');
  }
}

// Encryption is on for production installs where the DB lives in
// ~/.robotdojo/ — matching the deployment artifacts. If the DB is
// outside a Robot Dojo data directory, the plaintext path requires an explicit
// opt-in via ROBOTDOJO_ALLOW_PLAINTEXT=1 so a stray ROBOTDOJO_DB env
// var in prod cannot silently disable encryption.
function isForegroundServerProcess(argv = process.argv) {
  return argv.some((arg) => /(^|[/\\])index\.js$/.test(String(arg || '')));
}

/**
 * Only the interactive server (and tests) migrate the live DB.
 * Background daemons that import db.js were running BEGIN IMMEDIATE
 * migrations on boot and locking chat. Workers read the schema the
 * server already applied.
 *
 * Override: ROBOTDOJO_DB_MIGRATE=1 forces migrations.
 *           ROBOTDOJO_DB_SKIP_MIGRATE=1 skips them.
 */
export function skipSchemaWrites(env = process.env, argv = process.argv, dbPath = DB_PATH) {
  if (env.ROBOTDOJO_DB_MIGRATE === '1') return false;
  if (env.ROBOTDOJO_DB_SKIP_MIGRATE === '1') return true;
  if (env.NODE_TEST_CONTEXT) return false;
  if (dbPath === ':memory:') return false;
  if (isForegroundServerProcess(argv)) return false;
  return true;
}

function configuredBusyTimeoutMs() {
  const raw = Number(process.env.ROBOTDOJO_DB_BUSY_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  // The interactive server must never park the Node event loop for a long SQLite
  // writer wait. Background scripts keep the longer timeout so offline work can
  // ride through transient locks without throwing.
  const serverRaw = Number(process.env.ROBOTDOJO_SERVER_DB_BUSY_TIMEOUT_MS);
  if (isForegroundServerProcess()) {
    return Number.isFinite(serverRaw) && serverRaw >= 0 ? Math.floor(serverRaw) : 100;
  }
  return 30000;
}

const DB_BUSY_TIMEOUT_MS = configuredBusyTimeoutMs();
const BOOT_PRAGMA_RETRY_MS = 25;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runBootPragma(database, sql) {
  const deadline = Date.now() + DB_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      return database.pragma(sql);
    } catch (err) {
      if (err?.code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw err;
      sleepSync(Math.min(BOOT_PRAGMA_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

let db;
if (isRobotDojoPath) {
  db = new EncryptedDatabase(DB_PATH, { timeout: DB_BUSY_TIMEOUT_MS });
  applyKeyPragma(db, LOCAL_DB_KEY);
} else if (process.env.ROBOTDOJO_ALLOW_PLAINTEXT === '1' || TEST_DB_PATH) {
  const { default: PlainDatabase } = await import('better-sqlite3');
  db = new PlainDatabase(DB_PATH, { timeout: DB_BUSY_TIMEOUT_MS });
  console.warn(`[db] plaintext mode (explicit opt-in via ROBOTDOJO_ALLOW_PLAINTEXT=1): ${DB_PATH}`);
} else {
  throw new Error(
    `[db] refusing to open non-encrypted DB at ${DB_PATH}. ` +
    `Either set ROBOTDOJO_DB to a path under ~/.robotdojo/ or ~/robotdojo/user/databases/ (for SQLCipher) ` +
    `or explicitly opt in with ROBOTDOJO_ALLOW_PLAINTEXT=1 (dev only).`,
  );
}

runBootPragma(db, `busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
runBootPragma(db, 'journal_mode = WAL');
runBootPragma(db, 'foreign_keys = ON');

function hasSplitVectorMigrationState(database) {
  try {
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='topic_vec_migrations'",
    ).get();
    if (!table) return false;
    const row = database.prepare('SELECT COUNT(*) AS n FROM topic_vec_migrations').get();
    return (row?.n || 0) > 0;
  } catch {
    return false;
  }
}

function shouldInvalidateAnnSidecarsForDb(database = db) {
  if (!(ANN_DIR_EXPLICIT || (isRobotDojoPath && DB_PATH !== ':memory:'))) return false;
  // The local-embedding migration invalidated old cloud-vector sidecars. Once
  // split-vector migration state exists, the install is past that seam: deleting
  // only sidecar.json makes healthy hot/full artifacts look missing and starts a
  // rebuild under foreground traffic.
  if (hasSplitVectorMigrationState(database)) return false;
  return true;
}

// ── Slow-statement logger (diagnostic; OFF by default) ───────────────────────
// st_2cd1af73 AC-1: the residual chat-slowness cause is a synchronous
// better-sqlite3 statement that walks + AES-decrypts cold pages on the server's
// MAIN thread, starving the event loop for seconds (proven via `sample`:
// Statement::JS_all → sqlite3BtreeNext → DecryptPageSQLCipherCipher). To NAME
// the exact offending query on the live server without guessing, set
// ROBOTDOJO_DB_SLOW_STMT_MS=<ms>: any .get()/.all()/.run() whose synchronous
// execution exceeds that many ms logs its SQL (first 200 chars) + duration +
// row count to stderr. Default unset → zero overhead (the wrapper is not even
// installed), so this is a safe permanent diagnostic, not a perf cost.
//
// WHY here, on the singleton: every server query flows through this one
// connection's prepared statements, so wrapping Statement.prototype catches the
// caller regardless of which lib/ module issued it.
const SLOW_STMT_MS = Number(process.env.ROBOTDOJO_DB_SLOW_STMT_MS || 0);
if (Number.isFinite(SLOW_STMT_MS) && SLOW_STMT_MS > 0) {
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  for (const method of ['get', 'all', 'run']) {
    const orig = proto[method];
    if (typeof orig !== 'function' || orig.__rdSlowWrapped) continue;
    const wrapped = function (...args) {
      const t0 = performance.now();
      const out = orig.apply(this, args);
      const dt = performance.now() - t0;
      if (dt >= SLOW_STMT_MS) {
        const sql = String(this.source || '').replace(/\s+/g, ' ').slice(0, 200);
        const n = Array.isArray(out) ? out.length : (out ? 1 : 0);
        process.stderr.write(`[db-slow] ${dt.toFixed(0)}ms ${method}() rows=${n} :: ${sql}\n`);
      }
      return out;
    };
    wrapped.__rdSlowWrapped = true;
    proto[method] = wrapped;
  }
  console.error(`[db] slow-statement logger armed at ${SLOW_STMT_MS}ms`);
}

// st_27561b77 P2 — disable automatic WAL checkpoint.
//
// WHY: SQLCipher's per-page AES-256 transform is paid every time SQLite
// traverses a page. The default wal_autocheckpoint=1000 fires inline at
// commit time when the WAL crosses 1000 frames — on a 6.1 GB DB that turn
// every commit into a multi-second blocking scan whenever the WAL has
// grown. Setting wal_autocheckpoint=0 takes that inline checkpoint off the
// commit path entirely; the dedicated supervisor in startInProcessSupervisor
// (lib/server.js) calls PRAGMA wal_checkpoint(PASSIVE) between drain slices
// from a separate short-lived connection so checkpoints happen in idle
// windows, never inline with a write.
//
// F5 safety valve: openPassiveCheckpointConnection() exposes a short-lived
// read-only connection that the supervisor uses; if PASSIVE returns
// log > 10000 frames (~40 MB) the supervisor forces another PASSIVE pass
// even outside an idle window so the WAL stays bounded.
db.pragma('wal_autocheckpoint = 0');

// WHY mmap_size 16 GB: st_74f45a1a Round 2 measured cold-start TTFB at 22 s
// driven entirely by searchAll's serial fan-out across 39 topic vec tables
// (1.2 M chunks). Most of that cost is page-cache miss when the OS has not
// recently warmed the DB file. PRAGMA mmap_size pins the DB pages into the
// OS file cache: SQLite memory-maps up to N bytes of the file, so subsequent
// reads skip the userspace read() boundary and pay only the page-fault cost
// (already amortized after one warmup pass).
//
// 17179869184 = 16 GiB. The live DB is ~18 GiB; mmap caps at the file size,
// not the limit, so 16 GiB covers virtually all reads. SQLCipher is fully
// compatible with mmap (encryption happens above the VFS layer).
//
// Cost: a one-time virtual-memory reservation (no RSS growth until pages
// are faulted in by reads). The OS unmaps under memory pressure — safe.
//
// st_27561b77 (expansion) — ROBOTDOJO_MMAP_SIZE env override. The
// persistent embedding worker (scripts/persistent-embed-worker.js) holds
// a ~2GB ONNX model resident for the life of the process. macOS jetsam
// kills Background-QoS processes whose RSS+virtual footprint balloons
// under memory pressure. Setting ROBOTDOJO_MMAP_SIZE=0 in the worker's
// environment skips the 16 GiB virtual reservation entirely so the
// worker's footprint is dominated by the model alone, dramatically
// reducing jetsam exposure. Foreground server keeps the default.
const MMAP_OVERRIDE = process.env.ROBOTDOJO_MMAP_SIZE !== undefined
  ? Number(process.env.ROBOTDOJO_MMAP_SIZE)
  : null;
const MMAP_SIZE = Number.isFinite(MMAP_OVERRIDE) && MMAP_OVERRIDE >= 0
  ? MMAP_OVERRIDE
  : 17179869184;
db.pragma(`mmap_size = ${MMAP_SIZE}`);

// st_2cd1af73 AC-1 — SQLite page cache size (the hot-page decrypt cache).
//
// WHY this is load-bearing on an encrypted DB: SQLCipher decrypts every page
// (AES-256-CBC + an HMAC-SHA-512 verify) on the way OUT of the file and into
// the page cache. A page that is RESIDENT in the page cache is already
// decrypted — re-reading it is a pointer hit, zero crypto. A page that fell out
// of the cache must be re-read AND re-decrypted. `sample` of the live server
// proved the residual chat-slowness floor is exactly this: the main thread
// sitting in DecryptPageSQLCipherCipher → RijndaelDecrypt → sha512_transf under
// chat's read scans (the chunk_entities↔chunks joins, ~800ms cold each), every
// turn re-paying decrypt for pages the previous turn already decrypted.
//
// The default cache_size is -2000 (2MB); the better-sqlite3 fork left this DB
// at -16000 (16MB) — only ~4000 pages of a 7.7GB / ~1.9M-page database. The
// working set chat touches (entity rows, their chunk joins, conversation +
// metrics tables, topic context) does not fit, so it churns and re-decrypts.
//
// WHY mmap does NOT already cover this: macOS caps SQLite's mmap at ~2GB
// regardless of the 16GiB request above (verified live: mmap_size reported
// ~2.1e9, not 1.7e10). The 7.7GB file is far larger than the 2GB mmap window,
// so most pages still arrive through the read()+decrypt path — which the page
// cache, not mmap, is what shortcuts on repeat access.
//
// Default 1024MB: holds ~262k decrypted 4KB pages — enough for chat's recurring
// working set to stay hot across turns without re-decrypt — while leaving ample
// headroom on the 16GB box (the server process sits ~1GB RSS; the embed daemon
// runs with ROBOTDOJO_MMAP_SIZE=0 and its own connection, so this cache is the
// server's alone). Negative value = KiB of memory (SQLite convention), so
// -(MB*1024). Env-overridable via ROBOTDOJO_CACHE_SIZE_MB for a smaller box or
// to A/B the effect; <=0 leaves the driver default untouched.
//
// WHY the default drops to 64MB when ROBOTDOJO_MMAP_SIZE=0 is set: that env is
// the established "this is a memory-constrained background process" signal — the
// chunk-embed daemon sets it in its plist because it holds a ~2GB ONNX model
// resident and macOS jetsam kills Background-QoS processes whose footprint
// balloons. A 1GB page cache on top of that 2GB model is exactly the jetsam
// exposure that signal exists to avoid, so a process that opted out of mmap also
// opts down to a small cache by default. The interactive server (mmap at its
// 16GiB default) keeps the full 1024MB. An explicit ROBOTDOJO_CACHE_SIZE_MB
// always wins over both defaults.
// Default scales with the machine (owner call, 2026-06-10): ~8% of physical
// RAM, clamped to [256MB, 2048MB] — a 16GB box lands at the proven 1GB+,
// a 32/64GB box earns a bigger shelf, an 8GB box stays safe at ~640MB. The
// memory-constrained background signal (ROBOTDOJO_MMAP_SIZE=0) still pins 64MB.
const _machineCacheMb = Math.max(256, Math.min(2048, Math.round((totalmem() / 1048576) * 0.08)));
const CACHE_DEFAULT_MB = process.env.ROBOTDOJO_MMAP_SIZE === '0' ? 64 : _machineCacheMb;
const CACHE_SIZE_MB = process.env.ROBOTDOJO_CACHE_SIZE_MB !== undefined
  ? Number(process.env.ROBOTDOJO_CACHE_SIZE_MB)
  : CACHE_DEFAULT_MB;
if (Number.isFinite(CACHE_SIZE_MB) && CACHE_SIZE_MB > 0) {
  db.pragma(`cache_size = ${-(Math.round(CACHE_SIZE_MB) * 1024)}`);
}

// WHY: Load sqlite-vec extension immediately after opening the DB so all
// subsequent code (migrations, RAG search, embedding, ingestion scripts)
// can use vec0 virtual tables without each needing to load it separately.
// rag-search.js also calls sqliteVec.load(db) — that's a no-op on the same
// connection since the extension is already loaded (idempotent).
sqliteVec.load(db);

// Migration ledger — shared by both SQL-file and inline migrations.
db.exec(`CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

function dbBootNotice(message) {
  if (process.env.ROBOTDOJO_SUPPRESS_DB_BOOT_NOTICES === '1') return;
  console.error(message);
}

/**
 * st_fd14cdd4 AC9 — run a non-boot-critical boot write so a writer-lock
 * contention can NEVER crash module load.
 *
 * WHY this exists (the crash-loop root cause): db.js runs several SYNCHRONOUS
 * writes at module-load time (the every-boot taxonomy seed, the generated-
 * keychain cleanup DELETE, the workbench reconcile). The night-mode embed lanes
 * hold the single SQLite WAL writer while draining the ~283k-chunk backlog. A
 * WAL write-write conflict returns SQLITE_BUSY *immediately* — busy_timeout only
 * waits for a held *lock*, not for a peer connection's open write transaction,
 * and a long lane batch can outlast even the 30s timeout. An unguarded boot
 * write that loses that race throws an uncaught SqliteError → boot fails →
 * launchd KeepAlive respawns → lanes still writing → locked again → infinite
 * restart loop → chat never has a warm server. The confirmed fatal signature
 * was the unguarded `DELETE FROM keychain_integrations ...` below.
 *
 * The contract: these writes are idempotent catch-up work, NOT boot-critical
 * for correctness. On a lock, LOG and DEFER — the server MUST finish booting;
 * the deferred work runs on the next boot (the taxonomy seed and workbench
 * reconcile are every-boot reconciles by design; the keychain cleanup is a pure
 * test-residue sweep). Any OTHER error is a real bug and re-throws so it is
 * never silently swallowed. The value_rank backfill carries its own equivalent
 * per-slice guard already (backfillChunkValueRank), so it is not routed here.
 *
 * @param {string} label  short trace name for the deferred-on-lock log line
 * @param {() => void} fn  the boot write to run
 * @returns {boolean} true if it ran, false if it was deferred under contention
 */
export function bootWriteResilient(label, fn) {
  try {
    fn();
    return true;
  } catch (err) {
    if (/SQLITE_BUSY|database is locked/i.test(err?.message || '')) {
      dbBootNotice(`[db] boot write '${label}' deferred under writer contention (resumes next boot) — boot continues`);
      return false;
    }
    throw err;
  }
}

/**
 * Run a versioned migration. Idempotent — tracks applied migrations.
 */
export function migrate(name, fn) {
  if (skipSchemaWrites()) return;
  const exists = db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name);
  if (exists) return;

  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    if (db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) {
      db.exec('ROLLBACK');
      inTransaction = false;
      return;
    }
    fn(db);
    db.prepare('INSERT OR IGNORE INTO migrations (name) VALUES (?)').run(name);
    db.exec('COMMIT');
    inTransaction = false;
    console.error(`[db] migration applied: ${name}`);
  } catch (err) {
    if (inTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migration renames — aliases for historical file names so DBs that applied
 * the old name don't try to re-apply the renamed file (which would fail on
 * non-idempotent ALTER TABLE ADD COLUMN). Keyed by NEW name → OLD name.
 *
 * Background: duplicate `008_…` migrations were fixed 2026-04-17 by renaming
 * 008_billing_channel → 009, and bumping 009/010 accordingly. Any DB created
 * before this rename has the old names in `migrations`; we record the new
 * names as already-applied so the runner skips them.
 */
const MIGRATION_RENAMES = {
  '009_billing_channel.sql':    '008_billing_channel.sql',
  '010_health_schema.sql':      '009_health_schema.sql',
  '011_person_professional.sql': '010_person_professional.sql',
};

/**
 * Apply every .sql file in lib/migrations/ in name order (once each).
 * File name is the migration key in the `migrations` table.
 */
function applySqlMigrations() {
  if (skipSchemaWrites()) {
    dbBootNotice('[db] schema writes skipped (background process — server owns migrations)');
    return;
  }
  const dir = resolve(import.meta.dirname, 'migrations');
  let files;
  try { files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort(); }
  catch { return; }

  const insertMigration = db.prepare('INSERT INTO migrations (name) VALUES (?)');
  const insertMigrationIfAbsent = db.prepare('INSERT OR IGNORE INTO migrations (name) VALUES (?)');
  const existsStmt = db.prepare('SELECT 1 FROM migrations WHERE name = ?');

  // Honor rename aliases before running — if the OLD name is applied, record
  // the NEW name as applied so the runner skips it (see MIGRATION_RENAMES).
  for (const [newName, oldName] of Object.entries(MIGRATION_RENAMES)) {
    if (existsStmt.get(oldName) && !existsStmt.get(newName)) {
      insertMigrationIfAbsent.run(newName);
      console.error(`[db] migration alias recorded: ${oldName} → ${newName}`);
    }
  }

  for (const file of files) {
    if (existsStmt.get(file)) continue;
    const sql = readFileSync(resolve(dir, file), 'utf8');
    let inTransaction = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      if (existsStmt.get(file)) {
        db.exec('ROLLBACK');
        inTransaction = false;
        continue;
      }
      db.exec(sql);
      insertMigrationIfAbsent.run(file);
      db.exec('COMMIT');
      inTransaction = false;
      console.error(`[db] migration applied: ${file}`);
    } catch (err) {
      if (inTransaction) db.exec('ROLLBACK');
      if (err.message?.includes('duplicate column name')) {
        throw new Error(
          `[db] migration ${file} hit a duplicate column. ` +
          `The migration was not recorded as applied because other statements in the file may still be missing. ` +
          `Make the migration idempotent or repair the schema, then rerun migrations. Original error: ${err.message}`,
        );
      }
      console.error(`[db] migration failed (${file}):`, err.message);
      throw err;
    }
  }
}

applySqlMigrations();

// Backfill: compute HMAC-SHA256(email, SESSION_SECRET) for every existing user
// row that still has a plaintext email. Runs once (tracked in migrations table).
migrate('038-email-backfill', (db) => {
  const rows = db.prepare("SELECT id, email FROM users WHERE email IS NOT NULL AND email LIKE '%@%'").all();
  if (rows.length === 0) return; // nothing to hash — skip secret check

  const s = config.sessionSecret;
  if (!s || Buffer.from(s).length < 32) {
    throw new Error('SESSION_SECRET must be ≥32 bytes for email hashing — set it in Keychain before starting');
  }
  // Store the hash in BOTH email and email_hash columns. email is NOT NULL and
  // can't be dropped without a table rebuild — storing the hash there satisfies
  // the constraint while ensuring plaintext is never on disk.
  const update = db.prepare('UPDATE users SET email_hash = ?, email = ? WHERE id = ?');
  const backfill = db.transaction(() => {
    for (const row of rows) {
      const hash = crypto.createHmac('sha256', s)
        .update(row.email.trim().toLowerCase())
        .digest('hex');
      update.run(hash, hash, row.id);
    }
  });
  backfill();
  console.error(`[db] email backfill: hashed ${rows.length} user(s)`);
});

/**
 * Safe ALTER TABLE ADD COLUMN — silences "duplicate column" errors.
 */
export function addColumn(table, column, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    if (!err.message.includes('duplicate column')) {
      console.error(`[db] addColumn ${table}.${column} failed:`, err.message);
    }
  }
}

// --- Migrations ---

// User-managed topics (White Belt — users create their own topic structure)
migrate('create-user-topics', (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS user_topics (
    slug TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
});

// Add icon and visible columns for topic customization
migrate('user-topics-icon-visible', (db) => {
  addColumn('user_topics', 'icon', "TEXT DEFAULT 'label'");
  addColumn('user_topics', 'visible', 'INTEGER DEFAULT 1');
});

// Track entity confidence + source for quality gating
migrate('people-confidence-source', (db) => {
  addColumn('people', 'confidence', 'REAL DEFAULT 0');
  addColumn('people', 'source_count', 'INTEGER DEFAULT 0');
  addColumn('people', 'primary_source', "TEXT DEFAULT 'unknown'");
});

// Company types: company, school, nonprofit, government, other
migrate('company-type', (db) => {
  addColumn('companies', 'company_type', "TEXT DEFAULT 'company'");
});

// Place subtype (restaurant, bar, hotel, etc.) — column originally named venue_type, renamed to place_subtype
migrate('place-venue-type', (db) => {
  addColumn('places', 'place_subtype', "TEXT DEFAULT 'other'");
});

// Rename venue_type → place_subtype (idempotent — only if venue_type exists and place_subtype doesn't)
migrate('place-venue-type-rename', (db) => {
  const placeCols = db.prepare('PRAGMA table_info(places)').all().map(c => c.name);
  if (placeCols.includes('venue_type') && !placeCols.includes('place_subtype')) {
    db.exec('ALTER TABLE places RENAME COLUMN venue_type TO place_subtype');
  }
});

// Places intelligence columns
migrate('places-intelligence-v1', (db) => {
  addColumn('places', 'useful', 'INTEGER DEFAULT 1');
  addColumn('places', 'sub_type', 'TEXT');
  addColumn('places', 'years_lived', 'INTEGER DEFAULT 0');
  addColumn('places', 'total_visits', 'INTEGER DEFAULT 0');
});

// Install session tracking (onboarding chat)
migrate('install-sessions', (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS install_sessions (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'active',
    step TEXT DEFAULT 'welcome',
    messages TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    cost_cents INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
});

// Topic context docs — user-owned markdown per topic + version history
migrate('topic-context-history', (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS topic_context_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_slug TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
});

migrate('user-topics-context-md', () => {
  addColumn('user_topics', 'context_md', 'TEXT');
});

// Topic nesting — parent_slug references another user_topics.slug (null = root).
// No FK constraint: allows reparenting before children are cleaned up without
// stranding rows, and matches the rest of the soft-ref pattern in this schema.
migrate('user-topics-parent-slug', () => {
  addColumn('user_topics', 'parent_slug', 'TEXT');
});

// notion_page_id moved from 023_transcripts.sql (SQL files run before inline
// migrate() calls, so cross-table ALTERs must live here instead).
migrate('user-topics-notion-page-id', () => {
  addColumn('user_topics', 'notion_page_id', 'TEXT');
});

// User settings (Chat-as-IDE: preferences set via conversation)
migrate('create-user-settings', (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
});

// Health notes source column (Chat-as-IDE: track where notes come from)
migrate('health-notes-source', () => {
  addColumn('health_notes', 'source', "TEXT DEFAULT 'user'");
});

// Health dashboard history indexes depend on inline-created schema above:
// topic_context_history is created inline, and older DBs receive
// health_notes.source from the migration immediately before this one.
migrate('health-dashboard-history-inline-indexes', (db) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_health_notes_source_date
    ON health_notes(source, date DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_health_notes_owner_history
    ON health_notes(date DESC, id DESC)
    WHERE source = 'owner_attested_health_history'
       OR tags LIKE '%health_history%'
       OR tags LIKE '%owner_attested%'
       OR tags LIKE '%tier_1_owner_attested%';

    CREATE INDEX IF NOT EXISTS idx_topic_context_history_health_recent
    ON topic_context_history(topic_slug, source, id DESC);
  `);
});

migrate('health-intel-material-context-created-at-index', (db) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_topic_context_history_health_material_created_at
    ON topic_context_history(topic_slug, created_at)
    WHERE COALESCE(source, '') != 'synthesis';
  `);
});

// Added after the first history-index migration shipped so upgraded DBs that
// already recorded that migration still receive the owner-history partial index.
migrate('health-dashboard-owner-history-index', (db) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_health_notes_owner_history
    ON health_notes(date DESC, id DESC)
    WHERE source = 'owner_attested_health_history'
       OR tags LIKE '%health_history%'
       OR tags LIKE '%owner_attested%'
       OR tags LIKE '%tier_1_owner_attested%';
  `);
});

// Seed default health_groups on first boot. Runs once (tracked in migrations
// ledger) but is idempotent inside — INSERT OR IGNORE on stable ids. Users
// can rename/add/remove groups; re-running the migration never clobbers them.
// The same seed set lives in scripts/seed-health-groups.js for manual re-runs.
migrate('seed-health-groups', (db) => {
  const DEFAULT_GROUPS = [
    ['vitals',            'Vitals',             'Blood pressure, heart rate, temperature'],
    ['body_composition',  'Body Composition',   'Weight, BMI, body fat, waist'],
    ['metabolic',         'Metabolic',          'Glucose, A1C, insulin, lipids'],
    ['cardiovascular',    'Cardiovascular',     'Cholesterol, triglycerides, blood pressure'],
    ['blood',             'Blood Counts',       'CBC: hemoglobin, WBC, platelets'],
    ['kidney',            'Kidney',             'Creatinine, eGFR, BUN'],
    ['liver',             'Liver',              'ALT, AST, bilirubin, alk phos'],
    ['hormones',          'Hormones',           'Thyroid, testosterone, cortisol'],
    ['inflammation',      'Inflammation',       'CRP, ESR, immune markers'],
    ['vitamins_minerals', 'Vitamins & Minerals', 'Vitamin D, B12, iron, magnesium'],
    ['sleep',             'Sleep & Recovery',   'Sleep stages, HRV, resting heart rate'],
    ['user_tracked',      'User Tracked',       'Manually tracked metrics'],
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO health_groups (id, name, description) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => { for (const r of rows) ins.run(...r); });
  tx(DEFAULT_GROUPS);
});

migrate('health-coach-v1', (db) => {
  ensureHealthCoachSchema(db);
});

// Health chart points dedup by source_id, not by (marker, date, filename).
// The legacy uniqueness rule could hide same-day user data from different
// source files and made FHIR's source_id contract depend on a manual script.
migrate('health-data-points-source-id-dedup', (db) => {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='health_data_points'").get();
  if (!table) return;

  const cols = new Set(db.prepare('PRAGMA table_info(health_data_points)').all().map(c => c.name));
  const expr = (name, fallback) => cols.has(name) ? name : `${fallback} AS ${name}`;
  const rows = db.prepare(`
    SELECT
      id, marker_id, date, value,
      ${expr('source', "'manual'")},
      ${expr('source_file', "''")},
      ${expr('source_id', "''")},
      ${expr('specimen_type', "'unknown'")},
      ${expr('excluded', '0')},
      ${expr('exclude_reason', 'NULL')},
      ${expr('created_at', "datetime('now')")},
      ${expr('updated_at', 'created_at')}
    FROM health_data_points
    ORDER BY id
  `).all();

  db.exec(`
    CREATE TABLE health_data_points_new (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      marker_id      TEXT NOT NULL REFERENCES health_markers(id),
      date           TEXT NOT NULL,
      value          REAL NOT NULL,
      source         TEXT NOT NULL DEFAULT 'manual',
      source_file    TEXT NOT NULL DEFAULT '',
      source_id      TEXT NOT NULL,
      specimen_type  TEXT NOT NULL DEFAULT 'unknown',
      excluded       INTEGER NOT NULL DEFAULT 0,
      exclude_reason TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id)
    )
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO health_data_points_new
      (id, marker_id, date, value, source, source_file, source_id, specimen_type, excluded, exclude_reason, created_at, updated_at)
    VALUES
      (@id, @marker_id, @date, @value, @source, @source_file, @source_id, @specimen_type, @excluded, @exclude_reason, @created_at, @updated_at)
  `);
  for (const row of rows) {
    const source = row.source === 'pdf' ? 'pdf-lab' : (row.source || 'manual');
    insert.run({
      ...row,
      source,
      source_file: row.source_file || '',
      source_id: healthDataPointSourceId({
        source,
        markerId: row.marker_id,
        date: row.date,
        value: row.value,
        sourceFile: row.source_file || '',
        sourceRunId: row.source === 'pdf' || row.source === 'pdf-lab' ? row.source_file || '' : '',
        rowId: row.id,
        excluded: row.excluded,
      }),
      specimen_type: row.specimen_type && row.specimen_type !== 'unknown'
        ? row.specimen_type
        : deriveHealthSpecimenType(row.marker_id),
      excluded: row.excluded ?? 0,
    });
  }

  db.exec(`
    DROP TABLE health_data_points;
    ALTER TABLE health_data_points_new RENAME TO health_data_points;
    CREATE INDEX IF NOT EXISTS idx_hdp_marker ON health_data_points(marker_id);
    CREATE INDEX IF NOT EXISTS idx_hdp_date   ON health_data_points(date);
    CREATE INDEX IF NOT EXISTS idx_hdp_source ON health_data_points(source);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hdp_source_id ON health_data_points(source_id);
    CREATE INDEX IF NOT EXISTS idx_hdp_active_marker_date
      ON health_data_points(marker_id, date)
      WHERE excluded = 0;
    CREATE INDEX IF NOT EXISTS idx_hdp_active_dashboard_covering
      ON health_data_points(marker_id, date, value, source, source_file, source_id, specimen_type)
      WHERE excluded = 0;
    CREATE INDEX IF NOT EXISTS idx_hdp_active_source_coverage
      ON health_data_points(source, marker_id, source_file, date)
      WHERE excluded = 0;
    CREATE INDEX IF NOT EXISTS idx_hdp_updated_at ON health_data_points(updated_at);
  `);
});

// Chart payload cache invalidation needs a row-change clock. `created_at` is
// the clinical/source clock, so import corrections must not overload it.
migrate('health-data-points-updated-at-v1', (db) => {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='health_data_points'").get();
  if (!table) return;
  const cols = new Set(db.prepare('PRAGMA table_info(health_data_points)').all().map(c => c.name));
  if (!cols.has('updated_at')) {
    db.exec(`ALTER TABLE health_data_points ADD COLUMN updated_at TEXT`);
  }
  db.prepare(`
    UPDATE health_data_points
    SET updated_at = COALESCE(NULLIF(updated_at, ''), created_at, strftime('%Y-%m-%d %H:%M:%f', 'now'))
    WHERE updated_at IS NULL OR updated_at = ''
  `).run();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hdp_updated_at ON health_data_points(updated_at)`);
});

// Health dashboard source-coverage index. This runs after the source_id dedup
// rebuild above because that migration reconstructs health_data_points and
// therefore drops indexes created earlier in the boot sequence.
migrate('health-dashboard-source-coverage-index', (db) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_hdp_active_source_coverage
    ON health_data_points(source, marker_id, source_file, date)
    WHERE excluded = 0;
  `);
});

// C1 fix: person_groups.group_identifier was missing from the base schema.
// scoring.js and family-inference.js both query this column — without it
// maintenance scoring and family-inference silently fail.
migrate('person_groups_identifier', () => {
  addColumn('person_groups', 'group_identifier', 'TEXT');
});

// accounts.vendor + accounts.type — required by connect-account tool,
// setup helpers, and Google/Microsoft OAuth flows. The 000_base_entities.sql
// shell omits them for historical reasons (columns were added in dojo).
// New installs need them; existing installs get safe no-ops via addColumn.
migrate('accounts-vendor-type', () => {
  addColumn('accounts', 'vendor', "TEXT NOT NULL DEFAULT ''");
  addColumn('accounts', 'type',   "TEXT NOT NULL DEFAULT 'other'");
  addColumn('accounts', 'synced_at', 'TEXT');
});

migrate('accounts-topic-slug', () => {
  addColumn('accounts', 'topic_slug', 'TEXT');
});

// Seed missing taxonomy rows on boot. user_topics is the live source of truth;
// taxonomy.user.json must not overwrite existing topic edits. Lock-tolerant: the
// seed is an every-boot reconcile of an ON CONFLICT DO NOTHING upsert, so a write
// lock under embed-lane contention defers to the next boot rather than crashing it
// (was the err-log taxonomy.js:211 boot crash).
if (!skipSchemaWrites()) {
  bootWriteResilient('taxonomy-seed', () => syncTaxonomyToDb(db));
}

// Work email domain for LinkedIn disambiguation — used by lib/linkedin-scraper.js.
// people.linkedin_url already exists in 000_base_entities.sql, so only the new
// column needs adding here.
migrate('people-linkedin-enrichment', () => {
  addColumn('people', 'work_email_domain', 'TEXT');
});

// needs_regen flag — set to 1 when new data arrives that would change the context file.
// regen-entities.js checks this flag to know which entities to regenerate on the next pass.
migrate('entity-needs-regen', () => {
  addColumn('people', 'needs_regen', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('companies', 'needs_regen', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('places', 'needs_regen', 'INTEGER NOT NULL DEFAULT 0');
});

// context_file_path for companies and places — people already has this in base schema.
// WHY separate migration: entity-needs-regen ran before these columns were added to that
// migration. A new migration handles fresh installs + live DBs in the same pass.
migrate('entity-context-file-paths', () => {
  addColumn('companies', 'context_file_path', 'TEXT');
  addColumn('places', 'context_file_path', 'TEXT');
});

migrate('entity-context-file-path-indexes', (db) => {
  addColumn('companies', 'context_file_path', 'TEXT');
  addColumn('places', 'context_file_path', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_people_context_file_path
      ON people(context_file_path)
      WHERE context_file_path IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_companies_context_file_path
      ON companies(context_file_path)
      WHERE context_file_path IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_places_context_file_path
      ON places(context_file_path)
      WHERE context_file_path IS NOT NULL;
  `);
});

// Integration health monitoring — per-integration status + consecutive failure tracking.
// calendar_events.source was added in graph-calendar-sync but the migration was never
// run against the live DB; addColumn guard makes this safe on all installs.
migrate('integration-health', () => {
  addColumn('accounts', 'last_error', 'TEXT');
  addColumn('calendar_events', 'source', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_health (
      name                 TEXT PRIMARY KEY,
      status               TEXT NOT NULL DEFAULT 'unknown',
      last_check           TEXT,
      last_sync            TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
});

// st_bf4978b0 — `verified_at` is the honest live-verification signal, distinct
// from last_check (probe-run time) and last_sync (content-arrival time). It
// advances ONLY on a real live verification and is what earns a Healthy dot.
// NULL = never verified live = not-Healthy (the correct default; no backfill).
//
// WHY an inline addColumn co-located with the table's DDL, not a
// lib/migrations/*.sql ALTER (Failure manifest #4): SQL migrations run in
// applySqlMigrations() BEFORE these inline migrate() blocks, so an
// `ALTER TABLE integration_health ADD COLUMN` in a .sql file would execute
// before the CREATE TABLE above and crash a fresh install. Co-located inline
// addColumn is idempotent on fresh AND existing installs. Nullable only:
// SQLite cannot add a NOT NULL column without a full table rebuild, and NULL is
// exactly the "never verified" default we want.
migrate('integration-health-verified-at', () => {
  addColumn('integration_health', 'verified_at', 'TEXT');
});

// st_bf4978b0 — the Google AI cadence probe now writes under 'google' (the name
// the Google AI card reads, provider='google'), closing the google vs google-ai
// name seam. Drop the orphaned 'google-ai' residue so it can't linger as a
// never-verified ghost row. Idempotent no-op on fresh installs.
migrate('integration-health-google-ai-rename', () => {
  try { db.prepare("DELETE FROM integration_health WHERE name='google-ai'").run(); } catch { /* table may be fresh */ }
});

migrate('remove-orphan-reconciler-passive-job-v1', (db) => {
  const hasPassiveJobs = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name='passive_jobs'
  `).get();
  if (!hasPassiveJobs) return;
  db.prepare("DELETE FROM passive_jobs WHERE job_type = 'reconciler'").run();
});

migrate('label-overrides', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS label_overrides (
      tag_name      TEXT    PRIMARY KEY,
      display_name  TEXT,
      visible       INTEGER NOT NULL DEFAULT 1,
      sort_order    INTEGER NOT NULL DEFAULT 9999,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
});

migrate('label-overrides-v2', () => {
  addColumn('label_overrides', 'parent_tag_name', 'TEXT');
  addColumn('label_overrides', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
});

migrate('classify-confidence', () => {
  addColumn('drop_folder_files', 'classify_confidence', 'REAL');
});

// Integration registry — add keychain_key column so API-key integrations are
// stored alongside OAuth accounts in the canonical accounts table.
migrate('accounts-keychain-key', () => {
  addColumn('accounts', 'keychain_key', 'TEXT');
});

migrate('accounts-normalize-connected-status-v1', (db) => {
  db.prepare("UPDATE accounts SET status='active' WHERE status='connected'").run();
});

// st_dd0e19d8 AC20 — carry a legacy second-Asana account slot onto the canonical
// `asana_secondary` identifier, so an install created before the rename keeps
// working with no reconnection.
//
// INLINE, not lib/migrations/*.sql, for the reason the integration-health block
// above states: SQL migrations run BEFORE these blocks, and this one touches
// accounts.vendor / .type / .keychain_key, all of which are added by the inline
// addColumn() calls just above. Measured: the first draft shipped as
// 146_*.sql and aborted every fresh install with `no such column: vendor`.
//
// The legacy identifier is DISCOVERED from the data rather than named, because
// naming it would write the owner's employer initials back into a tracked file —
// the exact thing AC20 removes. See lib/legacy-provider-rename.js.
migrate('asana-secondary-identifier-v1', (db) => {
  const { legacy, moved } = migrateLegacySecondAsana(db);
  for (const id of legacy) {
    const m = moved[id] || {};
    console.error(
      `[db] second-Asana slot migrated to asana_secondary: accounts ${m.accounts || 0}, `
        + `catalog ${m.keychain_integrations || 0}, health ${m.integration_health || 0}, `
        + `chunks ${m.chunks_source_id || 0} (+${m.chunks_metadata || 0} metadata)`
    );
  }
});

// NOTE: timeline-wire index migration lives in lib/timeline-schema.js (migrate
// 'timeline-wire-indexes') because timeline_events is created there. Keeping
// infrastructure indexes co-located with the table DDL avoids fresh-DB ordering
// problems — db.js runs before timeline-schema.js is imported, so any index
// migration here would fail on a DB that hasn't run timeline_events_v1 yet.

// Seed API-key integrations as accounts rows. IDs are deterministic slugs
// (vendor:type) so re-running this migration is a safe no-op via INSERT OR IGNORE.
// provider='api_key' distinguishes these from OAuth rows (google, microsoft).
migrate('seed-api-key-integrations', (db) => {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO accounts
      (id, provider, vendor, type, display_name, keychain_key, status, metadata, created_at, updated_at)
    VALUES (?, 'api_key', ?, ?, ?, ?, 'active', '{}', datetime('now'), datetime('now'))
  `);
  const tx = db.transaction((rows) => { for (const r of rows) ins.run(...r); });
  tx([
    ['asana:task',      'asana',      'task',     'Asana',        'robotdojo-ASANA_PAT'],
    ['elevenlabs:voice','elevenlabs', 'voice',    'ElevenLabs',   'robotdojo-ELEVENLABS_API_KEY'],
    ['speechify:voice', 'speechify',  'voice',    'Speechify',    'robotdojo-SPEECHIFY_API_KEY'],
    ['stripe:payments', 'stripe',     'payments', 'Stripe',       'robotdojo-STRIPE_SECRET_KEY'],
    ['openai:other',    'openai',     'other',    'OpenAI',       'robotdojo-OPENAI_API_KEY'],
    ['telegram:other',  'telegram',   'other',    'Telegram',     'robotdojo-TELEGRAM_BOT_TOKEN'],
    ['notion:other',    'notion',     'other',    'Notion',       'robotdojo-NOTION_TOKEN'],
    ['oura:health',     'oura',       'health',   'Oura',         'robotdojo-OURA_PAT'],
    ['figma:other',     'figma',      'other',    'Figma',        'robotdojo-FIGMA_PAT'],
    ['brave:other',     'brave',      'other',    'Brave Search', 'robotdojo-BRAVE_API_KEY'],
    ['godaddy:domains', 'godaddy',    'domains',  'GoDaddy',      'robotdojo-GODADDY_API_KEY'],
    ['slab:other',      'slab',       'other',    'Slab',         'robotdojo-SLAB_API_TOKEN'],
    ['iproyal:proxy',   'iproyal',    'proxy',    'iProyal',      'robotdojo-IPROYAL_PROXY'],
  ]);
});

// Display name — user-facing name shown in greetings and profile (not the internal slug).
migrate('add-display-name-to-users', (db) => {
  db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
});

// Account name — editable Accounts label. Kept separate from user_slug, which
// is the local server/login name.
migrate('add-account-name-to-users', () => {
  addColumn('users', 'name', 'TEXT');
});

// st_5a63545d AC 7 — make users.email nullable.
// Since migration 038, email_hash is the durable identifier; the email column
// is no longer the primary identity surface. Token-handoff-created users
// (no real email collected) need to be insertable without a synthetic email.
// SQLite can't ALTER COLUMN ... DROP NOT NULL — full table rebuild required.
// WHY here (inline) and not as 074 SQL: SQL migrations run BEFORE all inline
// ALTER TABLE ADD COLUMN calls; on a fresh DB the users table has only the
// base columns from 002 at SQL-migration time. Running inline (after all
// add-column migrations) lets the rebuild copy every column that exists.
//
// Introspection-driven copy: PRAGMA table_info() returns the live column list,
// so the rebuild works on both production DBs (full schema) and fresh DBs
// (subset). The new schema declares every column we know about; INSERT carries
// over only those present in the source. Missing columns get their declared
// default.
migrate('users-email-nullable', (db) => {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  // Skip if email is already nullable (re-run safety).
  const emailCol = db.prepare("PRAGMA table_info(users)").all().find(r => r.name === 'email');
  if (emailCol && emailCol.notnull === 0) return;

  // FK enforcement blocks DROP TABLE users on production DBs where sessions
  // (and any other FK-referencing table) hold live references. Disable FK
  // checks for the rebuild, run the swap inside a transaction, then re-enable.
  // This is the canonical SQLite ALTER-via-rebuild pattern from the docs.
  const fkBefore = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        email                TEXT    UNIQUE,
        user_slug            TEXT    UNIQUE NOT NULL,
        subscription_status  TEXT    NOT NULL DEFAULT 'none',
        encryption_key_hash  TEXT,
        tunnel_token         TEXT,
        created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
        last_login_at        TEXT,
        is_admin             INTEGER NOT NULL DEFAULT 0,
        email_hash           TEXT,
        uuid                 TEXT,
        user_handle          TEXT,
        name                 TEXT,
        display_name         TEXT,
        onboarding_stage     INTEGER NOT NULL DEFAULT 1
      )
    `);

    const copyCols = ['id','email','user_slug','subscription_status','encryption_key_hash',
                      'tunnel_token','created_at','last_login_at','is_admin','email_hash',
                      'uuid','user_handle','name','display_name','onboarding_stage']
                     .filter(c => cols.includes(c));
    const list = copyCols.join(', ');
    db.exec(`INSERT OR IGNORE INTO users_new (${list}) SELECT ${list} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug  ON users(user_slug)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_hash_idx ON users(email_hash)');
  } finally {
    if (fkBefore) db.pragma('foreign_keys = ON');
  }
});

// Reset conversation chunks so reclassify (st_f0adee6f) re-indexes them under their
// new topic assignments. Runs once via migrate() ledger — only on the first boot after
// migrations 056–058 land. WHY here vs. SQL file: needs to run AFTER conversation_topics
// table exists AND after migrations 056/057/058 have been ledger-recorded.
migrate('st-f0adee6f-reset-conversation-embeds', () => {
  db.exec("UPDATE chunks SET embedded=0 WHERE source_type='conversation'");
});

migrate('uncategorized-root-topic-v1', (db) => {
  const hasTable = (name) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name);
  const hasColumn = (table, column) => {
    if (!hasTable(table)) return false;
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  };

  db.prepare(`
    INSERT OR IGNORE INTO user_topics
      (slug, label, description, icon, sort_order, parent_slug, visible, created_at, updated_at)
    VALUES
      ('uncategorized', '${UNCATEGORIZED_LABEL.replace(/'/g, "''")}', 'Searchable holding area for data that has not yet earned a coherent durable topic.', 'inbox', 999, NULL, 0, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    UPDATE user_topics
       SET parent_slug = NULL,
           visible = 0,
           updated_at = datetime('now')
     WHERE slug = 'uncategorized'
  `).run();

  if (hasTable('drop_folder_files') && hasColumn('drop_folder_files', 'topic_t1') && hasColumn('drop_folder_files', 'topic_t2')) {
    db.prepare(`
      UPDATE drop_folder_files
         SET topic_t1 = 'uncategorized',
             topic_t2 = NULL
       WHERE topic_t1 = 'uncategorized'
         AND topic_t2 = 'needs-routing'
    `).run();
  }
  if (hasTable('chunks') && hasColumn('chunks', 'topic')) {
    db.prepare("UPDATE chunks SET topic = 'uncategorized' WHERE topic = 'needs-routing'").run();
  }
  if (hasTable('conversations') && hasColumn('conversations', 'topic_slug')) {
    db.prepare(`
      UPDATE conversations
         SET topic_slug = 'uncategorized',
             updated_at = datetime('now')
       WHERE topic_slug = 'needs-routing'
    `).run();
    db.prepare(`
      UPDATE conversations
         SET topic_slug = NULL,
             updated_at = datetime('now')
       WHERE topic_slug IN ('tool-parent', 'tool-child')
    `).run();
  }
  if (hasTable('conversation_topics') && hasColumn('conversation_topics', 'topic_slug')) {
    db.prepare("UPDATE OR IGNORE conversation_topics SET topic_slug = 'uncategorized' WHERE topic_slug = 'needs-routing'").run();
    db.prepare("DELETE FROM conversation_topics WHERE topic_slug = 'needs-routing'").run();
    db.prepare("DELETE FROM conversation_topics WHERE topic_slug IN ('tool-parent', 'tool-child')").run();
  }
  if (hasTable('memory_event_links') && hasColumn('memory_event_links', 'target_id')) {
    db.prepare(`
      UPDATE OR IGNORE memory_event_links
         SET target_id = 'uncategorized'
       WHERE target_type = 'topic'
         AND target_id = 'needs-routing'
    `).run();
    db.prepare(`
      DELETE FROM memory_event_links
       WHERE target_type = 'topic'
         AND target_id = 'needs-routing'
    `).run();
  }
  if (hasTable('workbench_items') && hasColumn('workbench_items', 'workbench_id')) {
    db.prepare(`
      DELETE FROM workbench_items
       WHERE workbench_id IN ('wk_tool_child', 'wk_tool_parent')
    `).run();
  }
  if (hasTable('workbench_attachments') && hasColumn('workbench_attachments', 'target_id')) {
    db.prepare(`
      DELETE FROM workbench_attachments
       WHERE target_type = 'topic'
         AND target_id IN ('tool-child', 'tool-parent')
    `).run();
  }
  if (hasTable('workbenches')) {
    db.prepare(`
      DELETE FROM workbenches
       WHERE id IN ('wk_tool_child', 'wk_tool_parent')
          OR slug IN ('tool-child-workbench', 'tool-parent-workbench')
          OR root_path = 'user/workbenches/topics/tool-parent/wk_tool_parent'
          OR root_path = 'user/workbenches/topics/tool-parent/tool-child/wk_tool_child'
    `).run();
  }
  for (const table of ['drive_files', 'transcripts']) {
    if (hasTable(table) && hasColumn(table, 'topic')) {
      db.prepare(`UPDATE ${table} SET topic = 'uncategorized' WHERE topic = 'needs-routing'`).run();
    }
  }

  db.prepare(`
    DELETE FROM user_topics
     WHERE (slug = 'tool-child' AND label = 'Tool Child')
        OR (slug = 'tool-parent' AND label = 'Tool Parent')
        OR (slug = 'needs-routing' AND (label = 'Needs Routing' OR parent_slug = 'uncategorized'))
  `).run();
});

migrate('uncategorized-routing-residue-v2', (db) => {
  const hasTable = (name) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name);
  const hasColumn = (table, column) => {
    if (!hasTable(table)) return false;
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  };
  const personalImportSourceTypes = [
    'llm_export',
    'drive',
    'transcript',
    'file',
    'document',
    'drop_folder_file',
  ];
  const sourcePlaceholders = personalImportSourceTypes.map(() => '?').join(',');

  db.prepare(`
    INSERT OR IGNORE INTO user_topics
      (slug, label, description, icon, sort_order, parent_slug, visible, created_at, updated_at)
    VALUES
      ('uncategorized', '${UNCATEGORIZED_LABEL.replace(/'/g, "''")}', 'Searchable holding area for data that has not yet earned a coherent durable topic.', 'inbox', 999, NULL, 0, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    UPDATE user_topics
       SET parent_slug = NULL,
           visible = 0,
           updated_at = datetime('now')
     WHERE slug = 'uncategorized'
  `).run();

  if (hasTable('chunks') && hasColumn('chunks', 'topic')) {
    db.prepare("UPDATE chunks SET topic = 'uncategorized' WHERE topic = 'needs-routing'").run();
    if (hasColumn('chunks', 'source_type')) {
      db.prepare(`
        UPDATE chunks
           SET topic = 'uncategorized'
         WHERE topic = 'personal'
           AND source_type IN (${sourcePlaceholders})
      `).run(...personalImportSourceTypes);
    }
  }

  if (hasTable('drop_folder_files') && hasColumn('drop_folder_files', 'topic_t1') && hasColumn('drop_folder_files', 'topic_t2')) {
    db.prepare(`
      UPDATE drop_folder_files
         SET topic_t1 = 'uncategorized',
             topic_t2 = NULL
       WHERE topic_t1 = 'uncategorized'
         AND topic_t2 = 'needs-routing'
    `).run();
  }
  for (const table of ['drive_files', 'transcripts']) {
    if (hasTable(table) && hasColumn(table, 'topic')) {
      db.prepare(`UPDATE ${table} SET topic = 'uncategorized' WHERE topic = 'needs-routing'`).run();
    }
  }
  if (hasTable('conversations') && hasColumn('conversations', 'topic_slug')) {
    db.prepare(`
      UPDATE conversations
         SET topic_slug = 'uncategorized',
             updated_at = datetime('now')
       WHERE topic_slug = 'needs-routing'
    `).run();
  }
  if (hasTable('conversation_topics') && hasColumn('conversation_topics', 'topic_slug')) {
    db.prepare("UPDATE OR IGNORE conversation_topics SET topic_slug = 'uncategorized' WHERE topic_slug = 'needs-routing'").run();
    db.prepare("DELETE FROM conversation_topics WHERE topic_slug = 'needs-routing'").run();
  }
  if (hasTable('memory_event_links') && hasColumn('memory_event_links', 'target_id')) {
    db.prepare(`
      UPDATE OR IGNORE memory_event_links
         SET target_id = 'uncategorized'
       WHERE target_type = 'topic'
         AND target_id = 'needs-routing'
    `).run();
    db.prepare(`
      DELETE FROM memory_event_links
       WHERE target_type = 'topic'
         AND target_id = 'needs-routing'
    `).run();
  }
});

migrate('tool-fixture-topic-cleanup-v1', (db) => {
  const hasTable = (name) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name);
  const hasColumn = (table, column) => {
    if (!hasTable(table)) return false;
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  };

  if (hasTable('conversations') && hasColumn('conversations', 'topic_slug')) {
    db.prepare(`
      UPDATE conversations
         SET topic_slug = NULL,
             updated_at = datetime('now')
       WHERE topic_slug IN ('tool-parent', 'tool-child')
    `).run();
  }
  if (hasTable('conversation_topics') && hasColumn('conversation_topics', 'topic_slug')) {
    db.prepare("DELETE FROM conversation_topics WHERE topic_slug IN ('tool-parent', 'tool-child')").run();
  }
  if (hasTable('workbench_items') && hasColumn('workbench_items', 'workbench_id')) {
    db.prepare(`
      DELETE FROM workbench_items
       WHERE workbench_id IN ('wk_tool_child', 'wk_tool_parent')
    `).run();
  }
  if (hasTable('workbench_attachments') && hasColumn('workbench_attachments', 'target_id')) {
    db.prepare(`
      DELETE FROM workbench_attachments
       WHERE target_type = 'topic'
         AND target_id IN ('tool-child', 'tool-parent')
    `).run();
  }
  if (hasTable('workbenches')) {
    db.prepare(`
      DELETE FROM workbenches
       WHERE id IN ('wk_tool_child', 'wk_tool_parent')
          OR slug IN ('tool-child-workbench', 'tool-parent-workbench')
          OR root_path = 'user/workbenches/topics/tool-parent/wk_tool_parent'
          OR root_path = 'user/workbenches/topics/tool-parent/tool-child/wk_tool_child'
    `).run();
  }
  if (hasTable('user_topics')) {
    db.prepare(`
      DELETE FROM user_topics
       WHERE slug = 'tool-child'
         AND label = 'Tool Child'
         AND parent_slug = 'tool-parent'
    `).run();
    db.prepare(`
      DELETE FROM user_topics
       WHERE slug = 'tool-parent'
         AND label = 'Tool Parent'
    `).run();
  }
});

migrate('fixture-topic-quarantine-v2', (db) => {
  const hasTable = (name) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name);
  const hasColumn = (table, column) => {
    if (!hasTable(table)) return false;
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  };

  const fixtureTopicWhere = `
    slug IN ('tool-parent', 'tool-child')
    OR slug LIKE 'qa-persist-%'
    OR slug LIKE 'qa-probe-%'
    OR slug LIKE 'qa-rename-modal-%'
  `;
  const fixtureTargetWhere = `
    target_id IN ('tool-parent', 'tool-child')
    OR target_id LIKE 'qa-persist-%'
    OR target_id LIKE 'qa-probe-%'
    OR target_id LIKE 'qa-rename-modal-%'
  `;
  const fixtureConversationWhere = `
    topic_slug IN ('tool-parent', 'tool-child')
    OR topic_slug LIKE 'qa-persist-%'
    OR topic_slug LIKE 'qa-probe-%'
    OR topic_slug LIKE 'qa-rename-modal-%'
  `;

  if (hasTable('user_topics')) {
    db.prepare(`
      UPDATE user_topics
         SET visible = 0,
             needs_regen = 0,
             updated_at = datetime('now')
       WHERE ${fixtureTopicWhere}
    `).run();
  }
  if (hasTable('conversations') && hasColumn('conversations', 'topic_slug')) {
    db.prepare(`
      UPDATE conversations
         SET topic_slug = NULL,
             topic_set_method = NULL,
             updated_at = datetime('now')
       WHERE ${fixtureConversationWhere}
    `).run();
  }
  if (hasTable('conversation_topics') && hasColumn('conversation_topics', 'topic_slug')) {
    db.prepare(`
      DELETE FROM conversation_topics
       WHERE topic_slug IN ('tool-parent', 'tool-child')
          OR topic_slug LIKE 'qa-persist-%'
          OR topic_slug LIKE 'qa-probe-%'
          OR topic_slug LIKE 'qa-rename-modal-%'
    `).run();
  }
  if (hasTable('memory_event_links') && hasColumn('memory_event_links', 'target_id')) {
    db.prepare(`
      DELETE FROM memory_event_links
       WHERE target_type = 'topic'
         AND (${fixtureTargetWhere})
    `).run();
  }
});

migrate('fixture-topic-delete-v3', (db) => {
  const hasTable = (name) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name);
  const hasColumn = (table, column) => {
    if (!hasTable(table)) return false;
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  };
  const fixtureTopicWhere = `
    slug IN ('tool-parent', 'tool-child')
    OR slug LIKE 'qa-persist-%'
    OR slug LIKE 'qa-probe-%'
    OR slug LIKE 'qa-rename-modal-%'
  `;
  if (hasTable('conversations') && hasColumn('conversations', 'topic_slug')) {
    db.prepare(`
      UPDATE conversations
         SET topic_slug = NULL, topic_set_method = NULL, updated_at = datetime('now')
       WHERE topic_slug IN ('tool-parent', 'tool-child')
          OR topic_slug LIKE 'qa-persist-%'
          OR topic_slug LIKE 'qa-probe-%'
          OR topic_slug LIKE 'qa-rename-modal-%'
    `).run();
  }
  if (hasTable('conversation_topics') && hasColumn('conversation_topics', 'topic_slug')) {
    db.prepare(`
      DELETE FROM conversation_topics
       WHERE topic_slug IN ('tool-parent', 'tool-child')
          OR topic_slug LIKE 'qa-persist-%'
          OR topic_slug LIKE 'qa-probe-%'
          OR topic_slug LIKE 'qa-rename-modal-%'
    `).run();
  }
  if (hasTable('workbench_items')) {
    db.prepare(`
      DELETE FROM workbench_items
       WHERE workbench_id LIKE 'wk_qa_%'
          OR workbench_id IN ('wk_tool_child', 'wk_tool_parent')
    `).run();
  }
  if (hasTable('workbench_attachments')) {
    db.prepare(`
      DELETE FROM workbench_attachments
       WHERE target_type = 'topic'
         AND (
           target_id IN ('tool-parent', 'tool-child')
           OR target_id LIKE 'qa-persist-%'
           OR target_id LIKE 'qa-probe-%'
           OR target_id LIKE 'qa-rename-modal-%'
         )
    `).run();
  }
  if (hasTable('workbenches')) {
    db.prepare(`
      DELETE FROM workbenches
       WHERE id LIKE 'wk_qa_%'
          OR slug LIKE 'qa-%'
          OR id IN ('wk_tool_child', 'wk_tool_parent')
    `).run();
  }
  if (hasTable('user_topics')) {
    db.prepare(`DELETE FROM user_topics WHERE ${fixtureTopicWhere}`).run();
  }
});

// Seed default setup_steps rows (st_42799dbe — WB onboarding task tiles).
// Three tiles render at top of /account integrations page, in the documented order:
//   1. integrate_accounts  — Google OAuth "proceed with caution" guidance
//   2. installation_faq    — installation FAQ link
//   3. assistant_intro     — @miyagi prompt
// WHY here vs SQL file: SQL migrations run before inline migrate() calls.
// INSERT OR IGNORE makes this safe to re-run on upgrades without overwriting
// dismissed state — existing rows keep their dismissed_at / completed_at values.
migrate('seed-setup-steps', (db) => {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO setup_steps (step, completed_at, dismissed_at) VALUES (?, NULL, NULL)'
  );
  const tx = db.transaction((steps) => { for (const s of steps) ins.run(s); });
  tx(['integrate_accounts', 'installation_faq', 'assistant_intro']);
});

// Canonical Gemini key service. Some early launch builds wrote
// robotdojo-GOOGLE_API_KEY; runtime reads keep that as a legacy fallback, but
// the registry and setup flow should converge on the precise Google AI name.
migrate('google-ai-keychain-canonical', (db) => {
  db.prepare(`
    UPDATE keychain_integrations
       SET keychain_key = 'robotdojo-GOOGLE_AI_API_KEY',
           display_name = 'Google AI',
           section = 'foundation_models'
     WHERE provider = 'google'
  `).run();
});

// Notion runtime reads robotdojo-NOTION_TOKEN. Early catalog seeds used
// robotdojo-NOTION_API_KEY, which made setup cards say "needs key" while sync
// and health were reading the real token.
migrate('notion-keychain-canonical', (db) => {
  db.prepare(`
    UPDATE keychain_integrations
       SET keychain_key = 'robotdojo-NOTION_TOKEN',
           display_name = 'Notion',
           section = 'productivity'
     WHERE provider = 'notion'
  `).run();

  db.prepare(`
    UPDATE accounts
       SET keychain_key = 'robotdojo-NOTION_TOKEN'
     WHERE vendor = 'notion'
  `).run();
});

// Oura API v2 data sync uses a Personal Access Token, not an OAuth client
// secret. Early launch seeds exposed robotdojo-OURA_CLIENT_SECRET in Accounts,
// which made the card look configured while runtime sync read robotdojo-OURA_PAT.
migrate('oura-keychain-canonical', (db) => {
  db.prepare(`
    UPDATE keychain_integrations
       SET keychain_key = 'robotdojo-OURA_PAT',
           display_name = 'Oura',
           section = 'health'
     WHERE provider = 'oura'
  `).run();

  db.prepare(`
    UPDATE accounts
       SET keychain_key = 'robotdojo-OURA_PAT'
     WHERE vendor = 'oura'
  `).run();
});

// Historical ledger for cloud embedding calls made before the local-only
// embedding policy. Runtime embedding code must not write paid spend here.
migrate('embedding-usage-ledger', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      topic TEXT,
      chunk_count INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      estimated_cost_micro_usd INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS embedding_usage_ledger_created_idx
      ON embedding_usage_ledger(created_at);
  `);
});

// Local-only embedding metadata. Old cloud vectors are derived artifacts:
// preserve raw chunks/source rows, drop vec0 tables, and rebuild locally.
migrate('local-embedding-signatures-v1', (db) => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n || 0;

  addColumn('chunks', 'content_hash', 'TEXT');
  addColumn('chunks', 'embedding_model_id', 'TEXT');
  addColumn('chunks', 'embedding_dim', 'INTEGER');
  addColumn('chunks', 'embedding_signature', 'TEXT');
  addColumn('chunks', 'embedded_at', 'TEXT');
  addColumn('user_topics', 'description_embedding_model_id', 'TEXT');
  addColumn('user_topics', 'description_embedding_dim', 'INTEGER');
  addColumn('user_topics', 'description_embedding_signature', 'TEXT');
  addColumn('user_topics', 'description_embedding_at', 'TEXT');

  const vecTables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name LIKE 'chunk_vec_%'
      AND sql LIKE '%USING vec0%'
  `).all();
  for (const row of vecTables) {
    const name = String(row.name || '');
    if (!/^chunk_vec_[A-Za-z0-9_]+$/.test(name)) continue;
    db.exec(`DROP TABLE IF EXISTS ${name}`);
  }

  const annDir = process.env.ROBOTDOJO_ANN_DIR || join(homedir(), '.robotdojo-ann');
  if (shouldInvalidateAnnSidecarsForDb()) {
    try {
      // Invalidate ANN metadata only. Deleting the whole artifact directory can
      // turn a migration/import into a live rebuild storm.
      rmSync(join(annDir, 'sidecar.json'), { force: true });
      for (const entry of readdirSync(annDir, { withFileTypes: true })) {
        if (entry.isDirectory()) rmSync(join(annDir, entry.name, 'sidecar.json'), { force: true });
      }
    } catch { /* derived ANN sidecars will rebuild from local vectors */ }
  }

  db.exec(`
    UPDATE chunks
       SET embedded = 0,
           content_hash = NULL,
           embedding_model_id = NULL,
           embedding_dim = NULL,
           embedding_signature = NULL,
           embedded_at = NULL
     WHERE embedded != 0
        OR content_hash IS NOT NULL
        OR embedding_model_id IS NOT NULL
        OR embedding_dim IS NOT NULL
        OR embedding_signature IS NOT NULL
        OR embedded_at IS NOT NULL;

    UPDATE user_topics
       SET description_embedding = NULL,
           description_embedding_model_id = NULL,
           description_embedding_dim = NULL,
           description_embedding_signature = NULL,
           description_embedding_at = NULL
     WHERE description_embedding IS NOT NULL
        OR description_embedding_model_id IS NOT NULL
        OR description_embedding_dim IS NOT NULL
        OR description_embedding_signature IS NOT NULL
        OR description_embedding_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS chunks_embedding_signature_idx
      ON chunks(topic, embedded, skip_embed, embedding_model_id, embedding_dim, embedding_signature);

    CREATE INDEX IF NOT EXISTS idx_chunks_fresh_embedding_overlay
      ON chunks(embedded, embedded_at)
      WHERE embedded = 1;

    DROP TRIGGER IF EXISTS chunks_embedding_restore_same_content_au;
    CREATE TRIGGER chunks_embedding_restore_same_content_au
    AFTER UPDATE OF embedded ON chunks
    WHEN OLD.embedded = 1
     AND NEW.embedded = 0
     AND OLD.content IS NEW.content
     AND OLD.topic IS NEW.topic
     AND OLD.skip_embed IS NEW.skip_embed
    BEGIN
      UPDATE chunks
         SET embedded = OLD.embedded,
             content_hash = OLD.content_hash,
             embedding_model_id = OLD.embedding_model_id,
             embedding_dim = OLD.embedding_dim,
             embedding_signature = OLD.embedding_signature,
             embedded_at = OLD.embedded_at
       WHERE id = NEW.id;
    END;

    DROP TRIGGER IF EXISTS chunks_embedding_invalidate_content_topic_au;
    CREATE TRIGGER chunks_embedding_invalidate_content_topic_au
    AFTER UPDATE OF content, topic ON chunks
    WHEN OLD.content IS NOT NEW.content
      OR OLD.topic IS NOT NEW.topic
    BEGIN
      UPDATE chunks SET embedded = 0 WHERE id = NEW.id;
    END;
  `);

  const after = db.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n || 0;
  if (before !== after) {
    throw new Error(`local embedding migration changed chunk count: ${before} -> ${after}`);
  }
});

// Oura belongs with Health, not Productivity. Keep this separate from the
// key-name migration above so already-upgraded databases move sections too.
migrate('oura-health-section', (db) => {
  db.prepare(`
    UPDATE keychain_integrations
       SET section = 'health',
           display_name = 'Oura',
           keychain_key = 'robotdojo-OURA_PAT'
     WHERE provider = 'oura'
  `).run();
});

// st_27561b77 P4/AC2 — make passive_jobs.unique_key and id nullable with
// auto-generated defaults so the AC2 / AC9 load-test harnesses (which raw-
// INSERT into passive_jobs without supplying these columns) succeed.
//
// enqueuePassiveJob() always supplies both columns explicitly; the
// ON CONFLICT(unique_key) semantics are preserved because explicit callers
// never pass NULL. Raw INSERTs get a randomly-generated unique_key/id pair
// that will not collide with any explicit one (12 bytes of randomness ≈
// 96 bits, well above collision threshold for any test workload).
//
// SQLite cannot ALTER COLUMN to drop NOT NULL — full table rebuild required.
// Pattern mirrors the users-email-nullable migration above.
migrate('passive-jobs-nullable-keys', (db) => {
  // Skip if already nullable (re-run safety).
  const ukCol = db.prepare("PRAGMA table_info(passive_jobs)").all().find(r => r.name === 'unique_key');
  if (!ukCol || ukCol.notnull === 0) return;

  const cols = db.prepare("PRAGMA table_info(passive_jobs)").all().map(r => r.name);
  const fkBefore = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS passive_jobs_new (
        id                  TEXT    PRIMARY KEY DEFAULT ('pj_' || lower(hex(randomblob(12)))),
        queue               TEXT    NOT NULL DEFAULT 'default',
        job_type            TEXT    NOT NULL,
        unique_key          TEXT    UNIQUE DEFAULT ('auto:' || lower(hex(randomblob(12)))),
        target_type         TEXT    NOT NULL DEFAULT 'system',
        target_id           TEXT    NOT NULL DEFAULT '',
        payload             TEXT    NOT NULL DEFAULT '{}',
        status              TEXT    NOT NULL DEFAULT 'queued',
        priority            INTEGER NOT NULL DEFAULT 50,
        attempts            INTEGER NOT NULL DEFAULT 0,
        max_attempts        INTEGER NOT NULL DEFAULT 5,
        retry_count         INTEGER NOT NULL DEFAULT 0,
        -- st_b50005df Phase 2 — benign-reclaim counter (lease expiry, idle or
        -- clean stop). Separate from attempts (real failures) so a reclaimed
        -- job never marches to quarantine. Kept in the rebuild DDL so a fresh
        -- DB (where this rebuild fires after the 095 ALTER) keeps the column;
        -- 095_passive_jobs_reclaims.sql covers already-rebuilt live DBs.
        reclaims            INTEGER NOT NULL DEFAULT 0,
        -- df_02d633dc — round-robin stall guard. stall_probe_at is the
        -- re-plan-immune escape-hatch cooldown timestamp; stall_streak counts
        -- consecutive non-progressing busy-retry / lease-reclaim / benign
        -- requeue turns and resets on success. Kept in the rebuild DDL so a
        -- fresh DB (where this rebuild fires after 128_passive_jobs_stall_probe
        -- ALTERs) keeps both columns — same reason reclaims is here.
        stall_probe_at      TEXT,
        stall_streak        INTEGER NOT NULL DEFAULT 0,
        run_after           TEXT    NOT NULL DEFAULT (datetime('now')),
        lease_owner         TEXT,
        lease_expires_at    TEXT,
        timeout_ms          INTEGER NOT NULL DEFAULT 30000,
        last_success_at     TEXT,
        last_failure_at     TEXT,
        last_error          TEXT,
        quarantine_reason   TEXT,
        metadata            TEXT    NOT NULL DEFAULT '{}',
        created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
        started_at          TEXT,
        finished_at         TEXT,
        updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Copy every column that exists in the source.
    const copyCols = ['id','queue','job_type','unique_key','target_type','target_id','payload',
                      'status','priority','attempts','max_attempts','retry_count','reclaims',
                      'stall_probe_at','stall_streak','run_after',
                      'lease_owner','lease_expires_at','timeout_ms','last_success_at',
                      'last_failure_at','last_error','quarantine_reason','metadata',
                      'created_at','started_at','finished_at','updated_at']
                     .filter(c => cols.includes(c));
    const list = copyCols.join(', ');
    db.exec(`INSERT INTO passive_jobs_new (${list}) SELECT ${list} FROM passive_jobs`);
    db.exec('DROP TABLE passive_jobs');
    db.exec('ALTER TABLE passive_jobs_new RENAME TO passive_jobs');
    // Re-create the indices that 091_passive_jobs.sql + 094 defined.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_passive_jobs_claim
        ON passive_jobs(queue, status, run_after, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_passive_jobs_lease
        ON passive_jobs(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_passive_jobs_type_status
        ON passive_jobs(job_type, status, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_passive_jobs_unique_key
        ON passive_jobs(unique_key) WHERE unique_key IS NOT NULL;
      -- Covering index for getPassiveJobSummary's detail aggregate (migration 147).
      -- The trailing four columns ARE the aggregate's payload; without them SQLite
      -- does a rowid lookup per row and walks past the payload column through its
      -- overflow chain, paying an AES decrypt + HMAC per page on this SQLCipher DB
      -- (~21s per call measured, vs ~35ms covered). Keep this column list in sync
      -- with lib/migrations/147 -- narrowing it here silently restores the slow
      -- plan on the next table rebuild.
      CREATE INDEX IF NOT EXISTS idx_passive_jobs_summary
        ON passive_jobs(queue, job_type, status, retry_count, run_after, last_success_at, last_failure_at);
    `);
  } finally {
    if (fkBefore) db.pragma('foreign_keys = ON');
  }
});

// st_2cd1af73 — server-activity signal. A single-row table is the cross-process
// channel the chunk-embed daemon reads to decide whether to pause. The server
// (a separate process from the daemon) UPDATEs this row in-place on every
// request: in_flight bumps on start, decrements + last_request_at stamps on
// finish. The daemon polls it between embed batches and yields while a request
// is in flight or recent. UPDATE-in-place means the table never grows past one
// row. CREATE TABLE IF NOT EXISTS + seed the single row so the UPDATE always has
// a target (migration discipline: a fresh DB gets the seeded row here).
migrate('st-2cd1af73-server-activity', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_activity (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      in_flight       INTEGER NOT NULL DEFAULT 0,
      last_request_at INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.prepare('INSERT OR IGNORE INTO server_activity (id, in_flight, last_request_at, updated_at) VALUES (1, 0, 0, 0)').run();
});

// st_2cd1af73 AC-3 — last_chat_request_at: a CHAT-ONLY recency stamp, distinct
// from last_request_at (which every request stamps). WHY this column exists:
// last_request_at is bumped by ALL traffic — health probes, login-probe, sync,
// integration-monitor, the supervisor's own localhost calls, maintenance children.
// Overnight that background traffic NEVER lets the gap since last_request_at
// exceed the daemon's 30s long-input quiet window, so the daemon's long-dominated
// bulk (the 333k email backlog) defers forever and the night is wasted draining
// only tiny topics (the Phase-1 → AC-3 overnight wedge). The long-input wide-quiet
// gate must consult REAL chat quiet, not any-request quiet: this column is stamped
// ONLY by the chat-stream routes (authenticated + public), so a night with no human
// in chat reads as quiet even while background machinery hits /api/* constantly.
// The normal slice gate still keys off last_request_at (yield the WAL writer to ANY
// DB contention — correct); only the long-input start gate keys off this.
// Additive ALTER with a NOT NULL default is safe on the existing single row.
migrate('st-2cd1af73-chat-activity-stamp', (db) => {
  const cols = db.prepare(`PRAGMA table_info(server_activity)`).all();
  if (!cols.some((c) => c.name === 'last_chat_request_at')) {
    db.exec(`ALTER TABLE server_activity ADD COLUMN last_chat_request_at INTEGER NOT NULL DEFAULT 0`);
  }
});

// st_fd14cdd4 AC9 — last_chat_app_active_at: stamped when the CHAT APP is OPEN,
// not just when a chat turn is submitted. WHY this column exists and is distinct
// from last_chat_request_at: the prior yield keyed off a chat REQUEST (submit). By
// the time the user submits, the embedder is mid-write-batch holding the single
// SQLCipher writer, so that turn's RAG reads contend — the ~1-in-3 5–9s spike the
// owner measured under embedder drain. The fix is to yield the instant the chat app
// LOADS (and on focus / visibility / heartbeat while it stays open), so the writer
// is already free before the user finishes typing. The chat app POSTs /api/chat/active
// on load + a heartbeat; lib/server.js stamps this column via recordChatAppActive.
// The embedder treats a fresh app-active stamp as "drop the in-flight chunk and stay
// paused while the app is open" — broader and earlier than the per-turn signal.
// Additive ALTER with a NOT NULL default is safe on the existing single row.
migrate('st-fd14cdd4-chat-app-active-stamp', (db) => {
  const cols = db.prepare(`PRAGMA table_info(server_activity)`).all();
  if (!cols.some((c) => c.name === 'last_chat_app_active_at')) {
    db.exec(`ALTER TABLE server_activity ADD COLUMN last_chat_app_active_at INTEGER NOT NULL DEFAULT 0`);
  }
});

// st_2cd1af73 AC-1 — supervisor maintenance status. Cross-process channel for
// the off-thread maintenance worker (scripts/supervisor-maintenance-worker.mjs).
// The worker runs the PASSIVE WAL checkpoint + deep-health integrity scan that
// st_27561b77 used to run inline on the SERVER's main thread (the 12–17s event-
// loop stalls that froze chat). It writes the results here; the server's
// /api/server-health reads this single row instead of running those scans on the
// request thread. Single-row UPDATE-in-place (same pattern as server_activity):
// the table never grows past one row. Seeded so the worker's UPDATE always has a
// target on a fresh DB (migration discipline).
migrate('st-2cd1af73-supervisor-status', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_status (
      id                        INTEGER PRIMARY KEY CHECK (id = 1),
      checkpoint_busy           INTEGER NOT NULL DEFAULT 0,
      checkpoint_log            INTEGER NOT NULL DEFAULT 0,
      checkpointed              INTEGER NOT NULL DEFAULT 0,
      checkpoint_ts             INTEGER NOT NULL DEFAULT 0,
      deep_health_json          TEXT,
      deep_health_duration_ms   INTEGER NOT NULL DEFAULT 0,
      deep_health_ts            INTEGER NOT NULL DEFAULT 0,
      -- st_2cd1af73 AC-1 (round 2): the passive-jobs summary + session-log queue
      -- summary, computed BY THE WORKER and read cheaply by the server. The
      -- aggregate scans over passive_jobs decrypt last_error overflow pages and
      -- cost seconds on the server thread when the WAL is large; moving them here
      -- takes the last heavy DB scan off the request thread entirely.
      passive_summary_json      TEXT,
      passive_summary_ts        INTEGER NOT NULL DEFAULT 0,
      session_log_summary_json  TEXT,
      session_log_summary_ts    INTEGER NOT NULL DEFAULT 0,
      heartbeat_ts              INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.prepare('INSERT OR IGNORE INTO supervisor_status (id) VALUES (1)').run();
});

// st_2cd1af73 AC-1 (round 2) — add the summary columns to supervisor_status for
// any DB where the original migration above already ran with the earlier shape
// (the CREATE TABLE in the prior migration is a no-op on an existing table, so
// editing it could not add columns — migration discipline). This ALTERs them in
// idempotently: a fresh DB already has them from the CREATE above and the
// pragma_table_info guard skips the ALTER; an existing DB gets them added. The
// worker publishes the passive-jobs + session-log summaries here so the server
// reads one small row instead of scanning passive_jobs on its main thread.
migrate('st-2cd1af73-supervisor-status-summaries', (db) => {
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('supervisor_status')").all().map((r) => r.name));
  const adds = [
    ['passive_summary_json', 'TEXT'],
    ['passive_summary_ts', 'INTEGER NOT NULL DEFAULT 0'],
    ['session_log_summary_json', 'TEXT'],
    ['session_log_summary_ts', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, type] of adds) {
    if (!cols.has(name)) db.exec(`ALTER TABLE supervisor_status ADD COLUMN ${name} ${type}`);
  }
});

// st_db4b3118 API-HEALTH SIGNAL — publish the Anthropic warmup health into the
// supervisor_status row so ANY process can consult it (no scratch watcher ever
// again). The maintenance worker parses the warmup ping log (3 consecutive sub-
// 1500ms `ok t=<ms>` lines = healthy) and writes api_healthy + last_ok_latency_ms
// here each tick. Columns added idempotently for an already-created table.
migrate('st-db4b3118-supervisor-status-api-health', (db) => {
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('supervisor_status')").all().map((r) => r.name));
  const adds = [
    ['api_healthy', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_ok_latency_ms', 'INTEGER NOT NULL DEFAULT 0'],
    ['api_health_ts', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, type] of adds) {
    if (!cols.has(name)) db.exec(`ALTER TABLE supervisor_status ADD COLUMN ${name} ${type}`);
  }
});

// st_2cd1af73 Phase 6 — honest TTFT metric. `request_start_ms` and
// `first_token_ms` are both absolute epochs; the real time-to-first-token is
// their DIFFERENCE, never materialized before now (st_2cd1af73 research §5:
// dashboards/queries that read first_token_ms as if it were a duration report
// garbage). recordFirstToken() now writes ttft_ms = Date.now() - request_start_ms
// at the moment of the first model delta; this migration adds the column and
// backfills it for existing rows where it is computable.
//
// WHY warmup rows are excluded from the backfill: the (now-removed) speculative
// warmup ping wrote first_token_ms = completion_ms (an epoch, set when the
// 1-token ping returns) into rows with operation_name='warmup-ping'. Those rows
// are historical observability for the socket-warming experiment, NOT real chat turns; their
// observability for the socket-warming experiment, NOT real chat turns; their
// "first_token_ms - request_start_ms" is the whole 1-token round-trip, which
// would poison any TTFT aggregate. So ttft_ms stays NULL on warmup-ping rows
// and they are filtered everywhere TTFT is read (ttft-sample.js, the AC query).
//
// Idempotent: ADD COLUMN only when absent (migrate() ledger already guards
// re-run, but the column check makes a hand-rerun safe too). Backfill is a
// bounded single UPDATE over a small table (~hundreds of rows) — safe under the
// live embed daemon's short-transaction rule.
migrate('st-2cd1af73-ttft-ms', (db) => {
  const hasCol = db.prepare(
    "SELECT COUNT(*) n FROM pragma_table_info('chat_turn_metrics') WHERE name='ttft_ms'",
  ).get().n;
  if (!hasCol) {
    db.exec('ALTER TABLE chat_turn_metrics ADD COLUMN ttft_ms INTEGER');
  }
  // Backfill real (non-warmup) turns where both timestamps are present and
  // first_token came after request_start. Warmup-ping rows are left NULL.
  const res = db.prepare(`
    UPDATE chat_turn_metrics
    SET ttft_ms = first_token_ms - request_start_ms
    WHERE ttft_ms IS NULL
      AND operation_name != 'warmup-ping'
      AND first_token_ms IS NOT NULL
      AND request_start_ms IS NOT NULL
      AND first_token_ms > request_start_ms
  `).run();
  console.error(`[db] st-2cd1af73-ttft-ms backfilled ttft_ms for ${res.changes} chat rows`);
});

// st_db4b3118 VALUE-FIRST DRAIN ORDER — precomputed value_rank on chunks.
//
// WHY a precomputed INTEGER and NOT a per-fetch ORDER BY (this repo's scar): the
// embed daemon fetches a batch of un-embedded chunks for a topic up to ~340k rows
// (the `personal` pile). A per-fetch ORDER BY over entity-linkedness + recency +
// LENGTH(content) would re-sort that whole 300k-row range EVERY 8-16 chunks — the
// exact unindexed work-order that pinned a core at 100% for ~50s/pass in st_b50005df.
// Instead we MATERIALIZE the value ordering into one INTEGER column and add a
// PARTIAL INDEX so the fetch is `ORDER BY value_rank DESC LIMIT n` walking the
// index in order — O(batch) per fetch, no whole-topic re-sort, ever.
//
// THE COMPOSITE (monotone, sorts DESC correctly — documented so it is auditable):
//   value_rank = base + entityTerm + sourceSignalTerm + recencyTerm + lengthTerm
//     base        = 1                                            (ranked-floor sentinel)
//     entityTerm  = entity_linked ? 1_000_000_000_000 : 0       (1e12 — dominates ALL)
//     sourceSignalTerm = (3 - MIN(content_rank,3)) * 100_000_000_000
//                                                                 (non-email first-use signal)
//     recencyTerm = MIN(epoch_DAYS(event_time), 60_000) * 1_000_000
//     lengthTerm  = MIN(LENGTH(content), 999_999)
//   - epoch_DAYS = strftime('%s', event_time) / 86400 (whole days since 1970).
//     Day granularity, not seconds, because (a) event_time is mostly day-precise
//     anyway (YYYY-MM-DDT00:00:00 for imessage/calendar) and (b) it keeps every
//     term orders of magnitude apart inside the JS safe-integer budget. NULL/''
//     event_time → 0 (oldest), exactly the "0 if null" the value contract specifies.
//   - The epoch_days is CLAMPED to [0, 60_000] (day 60000 ≈ year 2134). This is the
//     load-bearing fix: garbage future-dated rows (the corpus has some) must NEVER
//     let a non-entity chunk's recency term cross the entity floor. Capped at 60k
//     days, max recencyTerm = 60_000 × 1e6 = 6e10 — far below the 1e12 entity term.
//   - base=1 makes a RANKED rank always >= 1, so value_rank=0 is an unambiguous
//     "not yet ranked" sentinel — the self-healing backfill keys on value_rank=0
//     and converges (even a genuinely-lowest chunk gets rank 1 and drops out, so
//     the always-run guard COUNT reaches 0 and the backfill goes quiet). The base
//     shifts every term up by 1 uniformly, so it changes NO ordering.
//   - The terms are sized so each dominates the next with a wide, overlap-free gap:
//       * entityTerm 1e12  >>  max recencyTerm 6e10 (≈16×), so an entity-linked
//         chunk ALWAYS outranks a non-entity-linked one, even the newest-possible.
//         (1) entity-linked first is absolute — even for bad far-future dates.
//       * sourceSignalTerm max 3e11 > max recencyTerm 6e10, so native/high-signal
//         material (content_rank 0/1/2) outranks email bulk before embeddings are
//         complete. This is the first-use intelligence fast lane.
//       * recency multiplier 1e6  >  lengthTerm cap 999_999, so a longer body NEVER
//         bleeds into the recency digit — recency strictly precedes length.
//   - Max value = 1e12 + 3e11 + 6e10 + 1e6 ≈ 1.36e12 < Number.MAX_SAFE_INTEGER (9.007e15)
//     and well within SQLite's signed-64-bit INTEGER. No overflow, huge headroom.
//   - Result: DESC sort yields (1) entity-linked, then (2) high-signal source, then
//     (3) newest, then (4) richer — the killer-feature substrate drains FIRST.
//
// The column defaults to 0 (a fresh chunk before backfill / a row the insert path
// has not yet ranked sorts last, which is harmless — it just embeds after ranked
// rows). lib/chunk-worker.js sets value_rank at INSERT (entity links don't exist
// yet at insert, so a new chunk gets a recency-dominated rank — correct; the
// maintenance VALUE-RANK REFRESH tick re-ranks it once its entity links appear).
//
// BACKFILL: batched short UPDATE transactions over the live DB while two embed
// lanes drain concurrently. Each batch is its own transaction so the writer-hold
// is tiny and a contended SQLITE_BUSY is tolerated (retry next boot — the column
// is additive; a partially-backfilled corpus still sorts correctly, the un-ranked
// tail just sorts last until a later boot finishes it).
const VALUE_RANK_BASE = 1;                       // ranked-floor sentinel (rank>=1 ⇒ ranked)
const VALUE_RANK_ENTITY_TERM = 1_000_000_000_000; // 1e12 — entity bit dominates all (>>6e10)
const VALUE_RANK_SOURCE_SIGNAL_MULT = 100_000_000_000; // source tier above recency, below entity
const VALUE_RANK_RECENCY_MULT = 1_000_000;        // epoch-DAYS shifted above the length cap
const VALUE_RANK_DAYS_CAP = 60_000;               // clamp bad far-future dates (~year 2134)
const VALUE_RANK_LENGTH_CAP = 999_999;            // length tiebreak, below the recency mult
const SECONDS_PER_DAY = 86_400;

migrate('st-db4b3118-chunks-value-rank', (db) => {
  const hasCol = db.prepare(
    "SELECT COUNT(*) n FROM pragma_table_info('chunks') WHERE name='value_rank'",
  ).get().n;
  if (!hasCol) {
    db.exec('ALTER TABLE chunks ADD COLUMN value_rank INTEGER NOT NULL DEFAULT 0');
  }
  // Partial index on the embed-drain predicate, ordered by value_rank DESC so the
  // daemon's fetch walks it in value order. Partial (WHERE skip_embed=0) keeps it
  // small (skipped chunks never embed). topic leads so a single topic's drain is a
  // contiguous index range; embedded is included so the un-embedded slice is a
  // covered prefix within the topic.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_value_drain
      ON chunks(topic, embedded, value_rank DESC)
      WHERE skip_embed = 0
  `);
  // Work-order derive covering index. This belongs beside value_rank, not in a
  // plain SQL migration, because SQL migrations run before this programmatic
  // value_rank column is added on fresh databases.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_work_order_covering
      ON chunks(embedded, topic, value_rank, source_type, content_rank)
      WHERE skip_embed = 0 AND topic IS NOT NULL
  `);
});

// st_2d941f89 (gap 2) ENTITY-RANK ORDINAL BANDING — per-class prominence rank.
//
// WHY a precomputed column, not a live window function inside VALUE_RANK_SQL_EXPR:
// people/companies/places have prominence signals (people.score, companies.
// people_count, places.total_visits) but no `rank` column, and none of the three
// tables share an id space (person id=5, company id=5, place id=5 can all exist
// independently) — an ordinal has to be DERIVED, and deriving it with
// ROW_NUMBER() OVER (...) inside a per-chunk correlated subquery would re-rank
// the WHOLE class table on every row touched (the exact unindexed-resort scar
// value_rank itself exists to avoid). Instead each class is ranked ONCE, in a
// single set-based UPDATE (computeEntityRanks, lib/scoring.js — run inside the
// daily RESCORE phase, right after computeAllScores/computePlaceScores already
// recompute the SAME underlying prominence signals), and only the top
// ENTITY_RANK_CAP rows per class get a non-NULL entity_rank. A partial index
// (WHERE entity_rank IS NOT NULL) then keeps every per-chunk lookup a cheap
// point/range hit instead of a table scan, class table size notwithstanding.
const hasColumn = (database, table, column) => database.prepare(
  `SELECT COUNT(*) n FROM pragma_table_info('${table}') WHERE name='${column}'`,
).get().n > 0;

migrate('st-2d941f89-entity-rank-columns', (db) => {
  for (const table of ['people', 'companies', 'places']) {
    if (!hasColumn(db, table, 'entity_rank')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN entity_rank INTEGER`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_entity_rank ON ${table}(entity_rank) WHERE entity_rank IS NOT NULL`);
  }
});

// The cap is per entity CLASS (person/place/company each get their own top
// ENTITY_RANK_CAP), matching the story's "capped ~rank 500 per entity class"
// ask verbatim. A module constant, not an env/config tunable: like every other
// value_rank formula constant in this file, it must stay bit-identical across
// the three call sites (this SQL expression, lib/scoring.js's writer, and any
// future reader) — an env override here would let one call site drift from
// another with no compile-time signal, exactly the drift class this file's
// other WHY comments warn against.
export const ENTITY_RANK_CAP = 500;
// Bonus-per-rank-step multiplier. MUST be a multiple of VALUE_RANK_RECENCY_MULT
// (1_000_000) — lib/rag/work-order.js recovers a ranked chunk's content length
// via `(value_rank - BASE) % 1_000_000`, which only works when every OTHER term
// in the composite is itself a multiple of 1e6 (see that file's WHY comment).
// Sized at 1e12 (matching VALUE_RANK_ENTITY_TERM's own magnitude) so a SINGLE
// rank-step difference (e.g. rank 3 vs rank 4 within the top 500) swamps the
// entire non-entity portion of the formula (max ~3.61e11: source-signal +
// recency + length combined) — entity rank strictly determines order within
// the ranked band; source/recency/length only tiebreak chunks tied on the
// EXACT same best-ranked entity. Max bonus = CAP × STEP = 500 × 1e12 = 5e14,
// comfortably under Number.MAX_SAFE_INTEGER (9.007e15) and SQLite's signed
// 64-bit INTEGER ceiling.
export const ENTITY_RANK_STEP = 1_000_000_000_000;

// The per-chunk "best qualifying entity rank" bonus, ADDITIVE on top of the
// existing flat VALUE_RANK_ENTITY_TERM (that term's binary "linked to ANY
// entity" semantics are UNCHANGED — a chunk linked only to a long-tail entity
// outside the top CAP still crosses the SAME floor it always did, and
// lib/rag/work-order.js's `value_rank >= entityFloor` entity-density check
// keeps working exactly as before). This ADDS a second, higher-magnitude tier
// ON TOP of that floor: a chunk linked to a top-1 person/place/company now
// outranks one linked only to rank 499 (bonus scales with rank), which in
// turn still outranks a chunk linked to no ranked (top-CAP) entity (bonus 0 —
// that chunk keeps its EXISTING flat-floor position, tiebroken by source-
// signal/recency/length exactly as before this story; it does not drop to a
// non-entity chunk's level). THREE separate UNION ALL branches (one per class), each
// filtering chunk_entities by entity_type FIRST (index idx_chunk_entities_
// type_entity_chunk / idx_chunk_entities_chunk) before joining to its class
// table's primary key — never a class-wide scan, and never conflates a
// person id with a company/place id that happens to share the same integer
// (the three tables do NOT share an id space).
const ENTITY_RANK_BONUS_SQL = `
    COALESCE((
      SELECT MAX(bonus) FROM (
        SELECT (${ENTITY_RANK_CAP} + 1 - p.entity_rank) * ${ENTITY_RANK_STEP} AS bonus
          FROM chunk_entities ce JOIN people p ON p.id = ce.entity_id
         WHERE ce.chunk_id = chunks.id AND ce.entity_type = 'person' AND p.entity_rank IS NOT NULL
        UNION ALL
        SELECT (${ENTITY_RANK_CAP} + 1 - c2.entity_rank) * ${ENTITY_RANK_STEP}
          FROM chunk_entities ce JOIN companies c2 ON c2.id = ce.entity_id
         WHERE ce.chunk_id = chunks.id AND ce.entity_type = 'company' AND c2.entity_rank IS NOT NULL
        UNION ALL
        SELECT (${ENTITY_RANK_CAP} + 1 - pl.entity_rank) * ${ENTITY_RANK_STEP}
          FROM chunk_entities ce JOIN places pl ON pl.id = ce.entity_id
         WHERE ce.chunk_id = chunks.id AND ce.entity_type = 'place' AND pl.entity_rank IS NOT NULL
      )
    ), 0)
  `;

// st_db4b3118 — value_rank SQL recompute expression, the single source of truth
// for the composite. Used by the always-run backfill below AND exported (as
// VALUE_RANK_SQL_EXPR) so lib/chunk-worker.js sets the same rank at insert and the
// maintenance VALUE-RANK REFRESH tick re-ranks identically — one formula, three
// callers, no drift. `strftime('%s', event_time)` yields epoch seconds (NULL on a
// NULL/'' event_time → COALESCE 0 = oldest). The whole expression stays in SQL so
// no chunk row ever crosses into JS — the backfill is pure extraction-tier work.
export const VALUE_RANK_SQL_EXPR = `
    ${VALUE_RANK_BASE}
    + (CASE WHEN EXISTS (SELECT 1 FROM chunk_entities ce WHERE ce.chunk_id = chunks.id)
          THEN ${VALUE_RANK_ENTITY_TERM} ELSE 0 END)
    + ${ENTITY_RANK_BONUS_SQL}
    + ((3 - MIN(3, MAX(0, COALESCE(content_rank, 3)))) * ${VALUE_RANK_SOURCE_SIGNAL_MULT})
    + (MIN(${VALUE_RANK_DAYS_CAP}, MAX(0, COALESCE(CAST(strftime('%s', event_time) AS INTEGER), 0) / ${SECONDS_PER_DAY})) * ${VALUE_RANK_RECENCY_MULT})
    + MIN(LENGTH(content), ${VALUE_RANK_LENGTH_CAP})
  `;

/**
 * st_db4b3118 — insert-time value_rank, computed in JS so lib/chunk-worker.js can
 * stamp a newly-inserted chunk's rank without a second UPDATE. At INSERT a chunk
 * has NO entity links yet (chunk_entities rows are created later by the entity
 * pipeline), so the entity term is always 0 here. The source-signal term is known
 * at insert time, so high-signal sources get the first-use fast lane immediately;
 * the maintenance VALUE-RANK REFRESH tick promotes later entity-linked chunks to
 * the entity tier. This mirrors VALUE_RANK_SQL_EXPR term-for-term (base + 0·entity
 * + source + recency + length) so the JS and SQL ranks never diverge.
 *
 * MUST match VALUE_RANK_SQL_EXPR bit-for-bit. Two subtleties the SQL forces:
 *   - UTC: SQLite's strftime('%s', 'YYYY-MM-DDTHH:MM:SS') treats a timezone-less
 *     ISO string as UTC. JS Date.parse treats the SAME string as LOCAL time. So a
 *     timezone-less event_time gets a trailing 'Z' appended here before parsing,
 *     making JS parse it as UTC too — otherwise insert-time and backfill ranks
 *     drift by the local UTC offset (the bug the value-rank test caught).
 *   - DAYS, clamped: epoch is divided to whole days (floor) and clamped to
 *     [0, VALUE_RANK_DAYS_CAP], identical to the SQL MIN(cap, MAX(0, sec/86400)).
 * An empty/unparseable value → 0 days (oldest), matching the SQL COALESCE(...,0).
 *
 * @param {string|null} eventTime ISO timestamp or '' / null
 * @param {string} content the chunk body
 * @param {number} [contentRank=3] chunks.content_rank; lower means higher signal
 * @returns {number} value_rank (>= 1)
 */
export function computeInsertValueRank(eventTime, content, contentRank = 3) {
  let epochDays = 0;
  const et = String(eventTime || '').trim();
  if (et) {
    // Append 'Z' for a timezone-less ISO string so JS parses it as UTC (matching
    // SQLite). A string that already carries a zone offset / 'Z' is left as-is.
    const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(et);
    const ms = Date.parse(hasZone ? et : `${et}Z`);
    if (Number.isFinite(ms)) {
      const days = Math.floor(ms / 1000 / SECONDS_PER_DAY);
      epochDays = Math.min(VALUE_RANK_DAYS_CAP, Math.max(0, days));
    }
  }
  const rankRaw = Number(contentRank);
  const rank = Number.isFinite(rankRaw) ? Math.min(3, Math.max(0, Math.floor(rankRaw))) : 3;
  const sourceSignal = (3 - rank) * VALUE_RANK_SOURCE_SIGNAL_MULT;
  const len = Math.min(String(content || '').length, VALUE_RANK_LENGTH_CAP);
  return VALUE_RANK_BASE + sourceSignal + (epochDays * VALUE_RANK_RECENCY_MULT) + len;
}

// st_db4b3118 — ALWAYS-RUN, self-healing value_rank backfill (NOT ledger-gated).
//
// WHY always-run and not a one-shot migrate(): the live DB has two embed lanes
// writing concurrently, so the backfill can hit SQLITE_BUSY and pause part-way. A
// migrate()-ledgered backfill would be recorded as "applied" on that partial pass
// and never resume — the unranked tail would sort wrong forever. Per the owner's
// "everything must self heal" directive, this runs every boot, is a single indexed
// COUNT when already complete (sub-ms — nothing to do), and ranks the remaining
// value_rank=0 rows in bounded short transactions until the whole corpus is done.
// A partial pass is always CORRECT (the un-ranked tail just sorts last) and the
// next boot finishes it. The maintenance VALUE-RANK REFRESH tick keeps it honest
// thereafter (re-ranking chunks whose entity links appeared after insert).
//
// Skipped in :memory: mode is unnecessary — an in-memory DB's backlog is tiny and
// the guard COUNT is free; tests that want a clean slate set value_rank explicitly.
// The maximum value_rank the CURRENT composite can produce. Any row above this was
// ranked by a SUPERSEDED formula (e.g. a pre-ship seconds-based recency term) and
// must be reset to 0 so the backfill re-ranks it with the live formula — the
// self-healing reconcile for a composite change. Headroom of +1 keeps the boundary
// exclusive of legitimate maxima.
const VALUE_RANK_MAX = VALUE_RANK_BASE + VALUE_RANK_ENTITY_TERM
  + (ENTITY_RANK_CAP * ENTITY_RANK_STEP)
  + (3 * VALUE_RANK_SOURCE_SIGNAL_MULT)
  + (VALUE_RANK_DAYS_CAP * VALUE_RANK_RECENCY_MULT) + VALUE_RANK_LENGTH_CAP;

function backfillChunkValueRank(database) {
  // Self-heal a composite change: reset any row ranked above the current ceiling
  // (a stale formula) back to the 0 sentinel so the backfill below re-ranks it.
  // Bounded single UPDATE; a no-op once the corpus is on the current formula.
  try {
    const stale = database.prepare(
      `UPDATE chunks SET value_rank = 0 WHERE value_rank > ${VALUE_RANK_MAX}`,
    ).run().changes;
    if (stale > 0) console.error(`[db] st-db4b3118 value_rank: reset ${stale} stale-formula rows for re-rank`);
  } catch { /* chunks table absent / contended — the backfill below still runs */ }
  let total;
  try {
    total = database.prepare("SELECT COUNT(*) n FROM chunks WHERE value_rank = 0").get().n;
  } catch {
    return; // chunks table absent (minimal probe DBs) — nothing to do
  }
  if (total === 0) return; // fully ranked — the cheap steady-state path
  const BATCH = Number(process.env.ROBOTDOJO_VALUE_RANK_BACKFILL_BATCH) || 5000;
  // Walk ascending id in fixed-size slices; each UPDATE is its own implicit
  // transaction (one prepared-statement run) so the writer-hold is one BATCH-row
  // UPDATE — small enough to interleave with the live lanes. A SQLITE_BUSY aborts
  // THIS boot's pass cleanly; the next boot resumes from the still-zero tail.
  const selectSlice = database.prepare(
    'SELECT id FROM chunks WHERE value_rank = 0 AND id > ? ORDER BY id ASC LIMIT ?',
  );
  const updateSlice = database.prepare(`
    UPDATE chunks SET value_rank = ${VALUE_RANK_SQL_EXPR}
    WHERE id > ? AND id <= ? AND value_rank = 0
  `);
  let updated = 0;
  let lastId = 0;
  try {
    while (true) {
      const ids = selectSlice.all(lastId, BATCH);
      if (!ids.length) break;
      const hiId = ids[ids.length - 1].id;
      updated += updateSlice.run(lastId, hiId).changes;
      lastId = hiId;
    }
    console.error(`[db] st-db4b3118 value_rank backfill: ranked ${updated}/${total} chunks`);
  } catch (err) {
    if (/SQLITE_BUSY|database is locked/i.test(err?.message || '')) {
      console.error(`[db] st-db4b3118 value_rank backfill paused under contention at id=${lastId} (ranked ${updated}; resumes next boot)`);
    } else {
      throw err;
    }
  }
}
const VALUE_RANK_BACKFILL_ON_BOOT =
  process.env.ROBOTDOJO_ENABLE_VALUE_RANK_BACKFILL_ON_BOOT === '1'
  || (
    isForegroundServerProcess()
    && process.env.ROBOTDOJO_ENABLE_FOREGROUND_VALUE_RANK_BACKFILL === '1'
  );
if (VALUE_RANK_BACKFILL_ON_BOOT) {
  backfillChunkValueRank(db);
} else {
  dbBootNotice('[db] st-db4b3118 value_rank backfill skipped on boot — maintenance will resume it');
}

migrate('st-1cfe9061-topic-vec-migrations', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_vec_migrations (
      topic       TEXT PRIMARY KEY,
      migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
});

migrate('split-vec-safe-embedding-restore-trigger-v1', (db) => {
  db.exec(`
    DROP TRIGGER IF EXISTS chunks_embedding_restore_same_content_au;
    CREATE TRIGGER chunks_embedding_restore_same_content_au
    AFTER UPDATE OF embedded ON chunks
    WHEN OLD.embedded = 1
     AND NEW.embedded = 0
     AND OLD.content IS NEW.content
     AND OLD.topic IS NEW.topic
     AND OLD.skip_embed IS NEW.skip_embed
     AND NOT EXISTS (
       SELECT 1 FROM topic_vec_migrations WHERE topic = OLD.topic
     )
    BEGIN
      UPDATE chunks
         SET embedded = OLD.embedded,
             content_hash = OLD.content_hash,
             embedding_model_id = OLD.embedding_model_id,
             embedding_dim = OLD.embedding_dim,
             embedding_signature = OLD.embedding_signature,
             embedded_at = OLD.embedded_at
       WHERE id = NEW.id;
    END;
  `);
});

// Geo classification columns for the companies table. Consumed columns, kept
// because a consumed migration cannot be withdrawn without a table rebuild; the
// populating script is a private, untracked working tool and is deliberately not
// named here (st_dd0e19d8 — a tracked pointer at a private script is itself a
// disclosure).
migrate('career-companies-geo', () => {
  addColumn('companies', 'hq_city', 'TEXT');
  addColumn('companies', 'boston_zone', 'TEXT');
});

// Always-run cleanup for generated keychain catalog rows only. Topic cleanup is
// exact-slug test teardown only; boot and WAL checkpoint must never delete
// topics by naming pattern. Lock-tolerant: this is a pure test-residue sweep, not
// boot-critical, so a writer lock defers it to the next boot instead of crashing
// the server (this exact DELETE was the confirmed boot crash-loop signature).
bootWriteResilient('keychain-catalog-cleanup', () =>
  db.prepare("DELETE FROM keychain_integrations WHERE provider LIKE 'test_catalog_auto_%'").run());

// Durable every-boot reconcile of workbenches via on-disk scan of the
// gitignored `user/workbenches/topics/**/wk_*/` tree. Runs for every user
// (owner and customer alike) against their own on-disk tree.
//
// WHY this runs for all users: a customer who uses the product writes their
// topic workbenches into the same `user/workbenches/topics/` shape that
// topicWorkbenchRoot() emits for everyone. On a fresh install the customer's
// tree is empty so the scan is a no-op — the bare-customer-start invariant is
// preserved by the empty filesystem, not by an owner-mode gate. On a
// subsequent boot after the customer has done real work, every-boot reconcile
// is the structure that guarantees the customer's workbenches survive a DB
// rebuild. Gating this on owner mode would deny customers durable workbench
// registration and reproduce the st_f0196b64 customer-facing defect on
// customer installs. (fixtureForTarget — the hardcoded pre-launch fixtures —
// remains owner-mode gated; only the disk-scan reconcile runs for all users.)
//
// WHY every-boot reconcile, NOT a one-shot migration: a migration runs
// exactly once per DB (the ledger row blocks re-runs). If a new workbench is
// added to disk AFTER the first run — exactly the st_f0196b64 production case
// where the live DB already ran an earlier ledger-gated seed but the disk now
// has more — the new workbenches would never enter the live DB without
// manually clearing the ledger or rebuilding the whole DB. Neither qualifies
// as durable. Reconciling on every boot is the only structure that makes
// "new workbench on disk → registered next boot" a guarantee.
//
// WHY here (boot path, not a maintenance routine): workbench resumeability is a boot
// guarantee — first chat after any restart must find existing workbenches
// already registered. Nightly is too late.
//
// Without this, a DB rebuild OR a freshly-added workbench loses
// resumeability — the filesystem persists but workbenches and
// workbench_items remain empty / partial, and topic-named workbenches
// cannot open by target when the topic name collides with same-typed
// entity rows. st_f0196b64 root cause.
//
// WHY disk-scan (no hardcoded list): the user's workbench slugs are PII.
// They live only in the gitignored filesystem; this committed code carries
// no user identifiers. The scan is the single source of truth.
//
// WHY skip in :memory: mode: in-memory DBs are non-durable by definition
// (tests, fresh installs probing config), so a durable reconcile is a no-op.
// Skipping also keeps in-memory tests from picking up unintended pre-seeded
// state from the real on-disk workbench tree.
//
// WHY ROBOTDOJO_REPO_ROOT override: test-only knob. Production runs without
// it and falls back to lib/workbench-files.js REPO_ROOT (the install root).
// Tests set it to an isolated temp dir so customer-mode reconcile assertions
// do not contaminate or read from the owner's real workbenches/ tree.
//
// Boot-cost discipline: reconcileWorkbenchesFromDisk uses a cheap content
// signature (file_count + max mtime, stat-only walk) per workbench and only
// re-scans / re-indexes substrate when the signature changed. On a
// steady-state boot with nothing changed, the per-workbench cost is a single
// stat-only walk + an INDEX.md re-read — well under a second total even for
// the largest known workbench (~675 files).
//
// Idempotency: registerWorkbench upserts via ON CONFLICT for workbenches,
// workbench_attachments, and workbench_items, and disk-scan passes
// preserveExistingIndex so the user-curated INDEX.md is left intact. The
// signature gate ensures unchanged workbenches produce zero row churn beyond
// the cheap resume-pointer refresh when INDEX.md prose changed.
// df_974525f2 — all [db] init banners write to stderr (console.error), never
// stdout: importing db.js is a module-init side effect of any CLI whose stdout
// may be machine-parsed (e.g. workbench-open.js --json captured to
// open-payload.json), and a banner on stdout corrupts that capture.
// Lock-tolerant: the reconcile is an every-boot upsert (registerWorkbench uses
// ON CONFLICT), idempotent by design, so a write lock under embed-lane contention
// defers it to the next boot rather than crashing module load. The filesystem
// remains the source of truth; resumeability is restored on the next clean boot.
if (DB_PATH !== ':memory:' && !skipSchemaWrites()) {
  bootWriteResilient('workbench-reconcile', () => {
    const repoRootOverride = process.env.ROBOTDOJO_REPO_ROOT || undefined;
    const result = reconcileWorkbenchesFromDisk(db, { repoRoot: repoRootOverride });
    if (result.registered.length) {
      dbBootNotice(`[db] workbenches registered: ${result.registered.join(', ')}`);
    }
    if (result.refreshed?.length) {
      dbBootNotice(`[db] workbenches refreshed: ${result.refreshed.join(', ')}`);
    }
    if (result.skipped.length) {
      dbBootNotice(`[db] workbenches skipped: ${result.skipped.join(', ')}`);
    }
    if (result.strays?.length) {
      dbBootNotice(`[db] workbench duplicate dirs found (owner cleanup): ${result.strays.join(', ')}`);
    }
  });
}

/**
 * st_27561b77 P2 — open a short-lived read-only connection for
 * PRAGMA wal_checkpoint(PASSIVE).
 *
 * WHY a separate connection: the server's write connection is the one
 * inline-WAL-autocheckpoint *would* fire on; calling the checkpoint pragma
 * from that same connection re-couples checkpoint cost to the write path.
 * A separate connection — opened, called, closed — gives us:
 *
 *   1. The checkpoint runs on a connection with no pending writes.
 *      PASSIVE only checkpoints pages not held by any reader; it never
 *      blocks writes. The result tuple {busy, log, checkpointed} reports
 *      back whether reader contention prevented progress.
 *   2. The connection lives for the duration of one pragma. No
 *      long-lived second writer; no chance of two writers contending
 *      over the same WAL.
 *   3. SQLCipher key is reapplied via applyKeyPragma — the encrypted DB
 *      needs the key on every fresh connection.
 *
 * The caller is responsible for `result.close()` after reading the pragma
 * result. Returns null if encryption is disabled or the key is missing
 * (test paths and explicit-plaintext mode).
 */
export function openPassiveCheckpointConnection() {
  if (DB_PATH === ':memory:') return null;
  let conn;
  if (isRobotDojoPath && LOCAL_DB_KEY) {
    conn = new EncryptedDatabase(DB_PATH, { readonly: false });
    applyKeyPragma(conn, LOCAL_DB_KEY);
  } else if (process.env.ROBOTDOJO_ALLOW_PLAINTEXT === '1' || TEST_DB_PATH) {
    // Lazy import to mirror the main `db` open path.
    // eslint-disable-next-line no-unused-expressions
    return null;
  } else {
    return null;
  }
  // Match the main connection's pragmas relevant to checkpoint behavior.
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  return conn;
}

/**
 * st_1cfe9061 — Open a fresh connection to embeddings.db (the background-only
 * vector store). Pattern mirrors openPassiveCheckpointConnection: encrypted,
 * WAL, short busy_timeout (the daemon yields to chat on SQLITE_BUSY; 5000ms
 * is long enough to absorb transient locks, short enough to surface quickly).
 *
 * Callers (chunk-embed-daemon, rag-search) call this once at startup and hold
 * the returned connection. Returns null in test paths and when the key is
 * missing (embeddings.db is a derived artifact — it is recreated by the daemon
 * on first run; the server and search paths must degrade gracefully when it is
 * absent). No ATTACH DATABASE.
 */
export function openEmbeddingsDb() {
  if (DB_PATH === ':memory:') return null;
  if (!isRobotDojoPath || !LOCAL_DB_KEY) return null;
  const embeddingsPath = resolve(config.configDir, 'embeddings.db');
  const conn = new EncryptedDatabase(embeddingsPath);
  applyKeyPragma(conn, LOCAL_DB_KEY);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  sqliteVec.load(conn);
  return conn;
}

export default db;
