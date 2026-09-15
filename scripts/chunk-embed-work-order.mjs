#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/chunk-embed-work-order.mjs — df_969e7d39 AC-4 off-thread work-order derive.
//
// Compute tier: extraction. This is a PURE deterministic DB read — no LLM, no write.
// It exists to move the embed daemon's value-first work-order derive (a GROUP BY that
// scans every pending chunk's content blob for LENGTH(), measured at 38–95s under the
// live 318k backlog) OFF the daemon's single main thread into a short-lived child
// process — mirroring how the daemon already offloads inference via the embed lane
// child. With the heavy derive off-thread, the daemon's heartbeat / watchdog /
// activity-watch timers keep firing on schedule (the ≤35s heartbeat bound).
//
// HARD CONTRACT (the single-writer + no-migrate invariants depend on it):
//   - This script NEVER imports the full database module. That module runs migrate()
//     and opens a writer at import — exactly the heavy, write-contending path
//     forbidden here. It imports ONLY the key loader (lib/db-encryption.js), the
//     DB-path resolution (lib/config.js), and the migrate-free ordering module
//     (lib/rag/work-order.js) — verified none of those pull in the database module.
//   - It opens a READ-ONLY keyed SQLCipher connection. It holds no write lock and is
//     SIGKILL-safe: if the parent times it out and kills it, nothing is half-written.
//   - Output contract: stdout = EXACTLY one line, JSON.stringify(order), then exit 0.
//     Any error → stderr + non-zero exit. The parent parses the last non-empty stdout
//     line, so stdout carries ONLY the JSON.
//
// The parent embed daemon spawns this with process.execPath + the absolute script
// path and inherits the daemon's DB-path env (ROBOTDOJO_DB / ROBOTDOJO_CONFIG /
// ROBOTDOJO_LOCAL_DB_KEY) so the child opens the SAME live DB.
// ─────────────────────────────────────────────────────────────────────────────

export const INTELLIGENCE_TIER = 'extraction';

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import EncryptedDatabase from 'better-sqlite3-multiple-ciphers';

const HOME = process.env.HOME || homedir();
const ROOT = process.env.ROBOTDOJO_HOME || resolve(HOME, 'robotdojo');

// Migrate-free imports only (see HARD CONTRACT above): the key loader, the DB-path
// resolution, and the ordering module — none of which open a writer or run migrate.
const { loadOrGenerateLocalKey, applyKeyPragma } = await import(resolve(ROOT, 'lib/db-encryption.js'));
const { default: config } = await import(resolve(ROOT, 'lib/config.js'));
const { computeWorkOrder } = await import(resolve(ROOT, 'lib/rag/work-order.js'));

// Mirror the daemon's module constants as literals so the child does NOT import the
// daemon (which would run migrate + open a writer at module top). These are stable,
// documented composite constants:
//   - LONG_INPUT_CHARS: the char threshold above which a chunk is a LONG input. The
//     daemon reads ROBOTDOJO_EMBED_LONG_INPUT_CHARS || config embed.longInputCharThreshold
//     || 2000; honor the same env override so the child's order matches the parent.
//   - VALUE_RANK_ENTITY_FLOOR: the chunks.value_rank floor that marks a chunk
//     entity-linked (== the database module's VALUE_RANK_ENTITY_TERM). value_rank >=
//     this is the exact, cheap integer test for entity-linkedness the scan uses.
function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const LONG_INPUT_CHARS = envInt('ROBOTDOJO_EMBED_LONG_INPUT_CHARS', 2000);
const VALUE_RANK_ENTITY_FLOOR = 1_000_000_000_000;

function resolveDbPath() {
  // Mirrors the database module's DB_PATH: ROBOTDOJO_DB override, else
  // ~/.robotdojo/robotdojo.db. No test-path branch — this child only ever runs
  // against the live encrypted DB.
  return process.env.ROBOTDOJO_DB || resolve(config.configDir, 'robotdojo.db');
}

async function main() {
  const dbPath = resolveDbPath();

  // Read-only keyed connection — never generate a key (the DB already exists; a
  // missing key is a hard error, not a reason to mint a replacement that can't
  // decrypt the existing file).
  const keyHex = loadOrGenerateLocalKey({ allowGenerate: false });

  // readonly:true takes a WAL read snapshot for the connection's lifetime and holds
  // no write lock. Mirrors the database module's read-only connection helpers
  // (openPassiveCheckpointConnection / openEmbeddingsDb): apply the SQLCipher key and
  // a short busy_timeout so a transient lock surfaces fast (the parent times the
  // whole derive out anyway).
  const conn = new EncryptedDatabase(dbPath, { readonly: true });
  try {
    applyKeyPragma(conn, keyHex);
    conn.pragma('busy_timeout = 5000');

    // Pure path: no cooldownPredicate (the child has no in-process cooldown state;
    // the parent re-applies live cooldown downstream) and no unrankedScorer
    // (production has zero value_rank=0 pending rows, so the pure score is exact).
    const order = computeWorkOrder(conn, {
      now: Date.now(),
      longInputChars: LONG_INPUT_CHARS,
      valueRankFloor: VALUE_RANK_ENTITY_FLOOR,
    });

    // Output contract: EXACTLY one stdout line of JSON, nothing else.
    process.stdout.write(`${JSON.stringify(order)}\n`);
  } finally {
    try { conn.close(); } catch { /* best-effort */ }
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`work-order derive failed: ${err?.message || err}\n`);
  process.exit(1);
}
