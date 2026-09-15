/**
 * fanout/receipts.js — the on-disk audit trail.
 *
 * Every run writes its full receipts to {baseDir}/fanout/{runId}/ (baseDir is
 * config.configDir = ~/.robotdojo, outside the repo tree — the ontology governs
 * the repo only). The inline result names this path so the operator can open,
 * audit, and interrogate the verdict.
 *
 * newRunId + runDirFor are effectively pure (given injected now/rng); only
 * writeReceipts touches the filesystem.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build a sortable, collision-safe run id: compact ISO timestamp + 6 hex.
 * `now`/`rng` are injected so the id is deterministic in tests; in production
 * defaultDeps supplies a real clock and a crypto-backed rng.
 *
 * @param {() => Date} now
 * @param {() => number} rng - float in [0,1)
 * @returns {string} e.g. 20260714T153000Z-a1b2c3
 */
export function newRunId(now = () => new Date(), rng = Math.random) {
  const iso = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let hex = '';
  for (let i = 0; i < 6; i++) hex += Math.floor(rng() * 16).toString(16);
  return `${iso}-${hex}`;
}

/**
 * The receipts directory for a run.
 * @param {string} baseDir - config.configDir
 * @param {string} runId
 * @returns {string}
 */
export function runDirFor(baseDir, runId) {
  return join(baseDir, 'fanout', runId);
}

/**
 * Write the full receipt set for a run.
 *
 * @param {string} runDir
 * @param {object} payload
 * @param {string} payload.prompt        - prompt.md body
 * @param {Array<{provider:string,text:string}>} payload.rawAnswers - one raw-{provider}.md each
 * @param {object} payload.judge         - judge.json body
 * @param {string} payload.challenger    - challenger.md body
 * @param {string} payload.synthesis     - synthesis.md body
 * @param {object} payload.cost          - cost.json body
 * @param {object} payload.meta          - meta.json body
 * @returns {string} runDir
 */
export function writeReceipts(runDir, payload) {
  mkdirSync(runDir, { recursive: true });
  const write = (name, body) => writeFileSync(join(runDir, name), body);

  write('prompt.md', payload.prompt ?? '');
  for (const raw of payload.rawAnswers || []) {
    write(`raw-${raw.provider}.md`, raw.text ?? '');
  }
  write('judge.json', JSON.stringify(payload.judge ?? {}, null, 2));
  write('challenger.md', payload.challenger ?? '');
  write('synthesis.md', payload.synthesis ?? '');
  write('cost.json', JSON.stringify(payload.cost ?? {}, null, 2));
  write('meta.json', JSON.stringify(payload.meta ?? {}, null, 2));
  return runDir;
}
