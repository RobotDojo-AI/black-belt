/**
 * backup-before-rebuild.js — verified backup of the live encrypted DB before the
 * st_f1a40461 entity-pipeline rebuild mutates it.
 *
 * RUN BY THE ORCHESTRATOR (not the builder) — it copies a ~2.3 GB file.
 *
 * Steps:
 *   1. Checkpoint the WAL into the main DB via the shared app connection
 *      (`PRAGMA wal_checkpoint(TRUNCATE)`) so the on-disk .db is self-consistent.
 *   2. Copy the encrypted robotdojo.db + -wal + -shm to
 *      ~/.robotdojo/backups/st_f1a40461-<ISO8601, ':'→'-'>/.
 *   3. SHA-256 each copy and compare to its source (byte-identical).
 *   4. Reopen the .db COPY read-only via better-sqlite3-multiple-ciphers using
 *      the same Keychain key lib/db.js loads, and assert `SELECT count(*) FROM
 *      people` === 17468.
 *   5. Write <backupdir>/verify.json with the result.
 *
 * Exits non-zero (and writes a failing verify.json when possible) if any check
 * fails — the orchestrator must abort the rebuild on a non-zero exit.
 *
 * WHY mirror lib/db.js's key loading rather than importing the live db handle
 * for the reopen: the reopen must be a SEPARATE read-only connection to the COPY
 * (proving the copy is itself a valid, decryptable DB), not the live writable
 * handle to the original.
 */
import EncryptedDatabase from 'better-sqlite3-multiple-ciphers';
import { existsSync, mkdirSync, copyFileSync, createReadStream, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import config from '../../lib/config.js';
import { loadOrGenerateLocalKey, applyKeyPragma } from '../../lib/db-encryption.js';

/** SHA-256 of a file, streamed (handles multi-GB files without buffering). */
function sha256File(path) {
  return new Promise((res, rej) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rej);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => res(hash.digest('hex')));
  });
}

async function main() {
  // Resolve the LIVE encrypted DB path exactly as lib/db.js does (default path).
  const DB_PATH = process.env.ROBOTDOJO_DB || resolve(config.configDir, 'robotdojo.db');
  if (!existsSync(DB_PATH)) {
    console.error(`[backup] live DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  // 1. Checkpoint the WAL through the shared app connection. Importing lib/db.js
  //    opens the same single encrypted handle the server/pipeline use; running
  //    the checkpoint here flushes WAL pages into the main .db so the copy is
  //    self-consistent. (TRUNCATE also zeroes the WAL file.)
  const { default: db } = await import('../../lib/db.js');
  db.pragma('wal_checkpoint(TRUNCATE)');
  // st_f1a40461: verify the COPY against the LIVE source count (the graph grows
  // across runs), not a hardcoded baseline. A valid backup = the copy reopens
  // with the same people count the source has right now.
  const srcPeople = db.prepare('SELECT count(*) AS n FROM people').get().n;

  const created = new Date().toISOString();
  const stamp = created.replace(/:/g, '-');
  const backupDir = join(homedir(), '.robotdojo', 'backups', `st_f1a40461-${stamp}`);
  mkdirSync(backupDir, { recursive: true });

  // 2 + 3. Copy each existing DB file and verify SHA-256 vs source.
  const suffixes = ['', '-wal', '-shm'];
  let shaMatch = true;
  const shaReport = {};
  for (const sfx of suffixes) {
    const src = DB_PATH + sfx;
    if (!existsSync(src)) continue; // -wal/-shm may be absent after TRUNCATE
    const dst = join(backupDir, basename(DB_PATH) + sfx);
    copyFileSync(src, dst);
    const [a, b] = await Promise.all([sha256File(src), sha256File(dst)]);
    shaReport[basename(DB_PATH) + sfx] = { src: a, dst: b, match: a === b };
    if (a !== b) shaMatch = false;
  }

  // 4. Reopen the .db COPY read-only with the same Keychain key and assert count.
  //    allowGenerate:false — an existing encrypted DB must already have its key;
  //    we never mint a replacement.
  let reopened = false;
  let people = null;
  let reopenError = null;
  try {
    const keyHex = loadOrGenerateLocalKey({ allowGenerate: false });
    const copyPath = join(backupDir, basename(DB_PATH));
    const copy = new EncryptedDatabase(copyPath, { readonly: true, fileMustExist: true });
    try {
      applyKeyPragma(copy, keyHex);
      people = copy.prepare('SELECT count(*) AS n FROM people').get().n;
      reopened = true;
    } finally {
      copy.close();
    }
  } catch (err) {
    reopenError = err.message;
  }

  const ok = shaMatch && reopened && people === srcPeople && srcPeople > 0;
  const verify = {
    ok,
    people,
    sha_match: shaMatch,
    reopened,
    backup_dir: backupDir,
    created,
    ...(reopenError ? { reopen_error: reopenError } : {}),
    ...(people !== srcPeople ? { expected_people: srcPeople } : {}),
    sha: shaReport,
  };
  writeFileSync(join(backupDir, 'verify.json'), JSON.stringify(verify, null, 2), 'utf8');

  if (!ok) {
    console.error(`[backup] VERIFICATION FAILED: ${JSON.stringify({ ok, people, shaMatch, reopened, reopenError })}`);
    process.exit(1);
  }
  console.log(`[backup] verified backup at ${backupDir} (people=${people}, sha_match=${shaMatch}, reopened=${reopened})`);
}

main().catch((err) => {
  console.error('[backup] fatal:', err);
  process.exit(1);
});
