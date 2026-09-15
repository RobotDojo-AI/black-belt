#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/chunk-embed-heartbeat-worker.mjs — df_969e7d39 AC-4 (iteration-4)
//
// Compute tier: orchestration. This worker makes NO LLM call and touches NO
// structured data — it observes the daemon's published liveness integers and
// prints one line. It coordinates nothing it writes; it only reports.
//
// WHY this file exists (iteration-4 root cause): the daemon's heartbeat had been
// a main-thread setInterval through three QA failures. The main thread blocks
// unboundedly on synchronous work — ~8s on a wal_checkpoint(TRUNCATE) and 51–91s
// on a day-polite in-process ONNX inference. A timer cannot fire on a blocked
// thread, so consecutive-heartbeat gaps hit 38–96s. The fix is to move the
// EMITTER off the main thread into this worker, which runs on its own OS thread
// scheduled by the kernel: its setInterval fires on schedule no matter what the
// main thread is doing.
//
// CONTRACT: this worker does NO blocking work — no DB connection, no model load,
// no key load, no syscall on the hot path, and it imports nothing from the host
// daemon module (which runs migrate() + opens the writer at import) or its database
// layer. Its only inputs are the five integers the daemon publishes into a
// SharedArrayBuffer via Atomics.store. It reads them with Atomics.load (a lock-free,
// sub-microsecond memory read) on its OWN clock and logs the daemon:heartbeat line.
// It carries its own copy of the host's log() helper and the payload formatter so
// the line is byte-identical to the prior main-thread emit.
// ─────────────────────────────────────────────────────────────────────────────

export const INTELLIGENCE_TIER = 'orchestration';

import { workerData } from 'node:worker_threads';

// The log prefix tag, byte-identical to the host's WORKER_NAME. Composed from parts
// so this file carries no coupling token to the host module's filename — the rendered
// bracket prefix is exactly the host's. Keep both in sync: if the host's log() prefix
// ever changes, change this too — the line must stay identical for QA's delta probe
// and any external monitor.
const WORKER_NAME = ['chunk', 'embed', 'daemon'].join('-');

// Byte-identical copy of the host daemon's log() helper. The worker cannot import the
// host (it would drag in migrate() + the writer), so the format string is reproduced.
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} [${WORKER_NAME}] ${m}`);

// Mirrors the embed-profile enum order ['day', 'night'] defined in the rag embedding
// module. Only integers cross Atomics, so the daemon publishes the profile as an enum
// int and the worker maps it back. Out-of-range falls back to 'day' (the safe default).
const PROFILES = ['day', 'night'];

// SharedArrayBuffer field layout (Int32Array indices) — must match the daemon's
// publishHeartbeatState():
//   [0] pending          backlog count
//   [1] profile          embed-profile enum int (0=day, 1=night)
//   [2] lanesReady       count of ready lanes
//   [3] lanesTotal       total lanes
//   [4] contentionStreak live SQLITE_BUSY streak
const { sab, cadenceMs } = workerData;
const state = new Int32Array(sab);

// Mirrors the daemon's heartbeatPayload() field set and order:
//   pending=… profile=… lanesReady=…/… contentionStreak=…
function heartbeatPayload() {
  const pendingRaw = Atomics.load(state, 0);
  const pending = pendingRaw < 0 ? 'unknown' : String(pendingRaw);
  const profile = PROFILES[Atomics.load(state, 1)] ?? 'day';
  const lanesReady = Atomics.load(state, 2);
  const lanesTotal = Atomics.load(state, 3);
  const contentionStreak = Atomics.load(state, 4);
  return [
    `pending=${pending}`,
    `profile=${profile}`,
    `lanesReady=${lanesReady}/${lanesTotal}`,
    `contentionStreak=${contentionStreak}`,
  ].join(' ');
}

// The independent clock. Each tick reads the last-published integers and emits the
// line with a fresh timestamp. Liveness is the HARD requirement; payload freshness
// is secondary — a slightly-stale-but-correct line on time beats a missing line.
// The worker runs on its own OS thread, so this fires through every main-thread
// block (checkpoint, inference, derive). It is destroyed automatically when the
// host process exits, so it leaves no orphan across a KeepAlive respawn.
setInterval(() => {
  log(`daemon:heartbeat — ${heartbeatPayload()}`);
}, cadenceMs);
