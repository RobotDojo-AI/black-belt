#!/usr/bin/env node
/**
 * The ONLY sanctioned path for destructive GCS bucket operations in this repo.
 *
 * Today's incident was a raw `gcloud storage rm -r` typed from memory against the
 * wrong bucket. This script closes the "through repo tooling" path: nothing gets
 * emptied or deleted until the operator proves intent by naming the exact target
 * a second time. (It cannot stop a raw `gcloud` command typed outside any script —
 * that residual gap needs an IAM permission boundary, deferred by scope OOS #4.)
 *
 * Usage:
 *   node scripts/gcs-destroy-bucket.js --bucket <name>
 *       Interactive: prints the resolved target, then requires the operator to
 *       type the exact bucket name back on stdin before proceeding.
 *
 *   node scripts/gcs-destroy-bucket.js --bucket <name> --yes-i-am-sure <name>
 *       Non-interactive: <name> must EXACTLY equal the --bucket value, or the
 *       script exits 1 with no action. Any typo fails safe (blocks the delete;
 *       it can never accidentally trigger one).
 *
 * Deletion (only after confirmation passes): `gcloud storage rm -r gs://<bucket>`
 * to empty objects, then `gcloud storage buckets delete gs://<bucket>`.
 */
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INTELLIGENCE_TIER = 'extraction';

/**
 * Pure confirm-matching gate. No side effects, no gcloud calls — unit-testable.
 *
 * @param {string} bucket        the resolved target bucket name (--bucket)
 * @param {string} confirmValue  the operator's typed-back confirmation
 * @returns {{ok: boolean, reason: string}}
 *   ok:true only when confirmValue exactly equals a non-empty bucket name.
 */
export function resolveAndConfirm(bucket, confirmValue) {
  const target = typeof bucket === 'string' ? bucket.trim() : '';
  const typed = typeof confirmValue === 'string' ? confirmValue.trim() : '';
  if (!target) {
    return { ok: false, reason: 'no --bucket target provided' };
  }
  if (!typed) {
    return { ok: false, reason: 'no confirmation value provided' };
  }
  if (typed !== target) {
    return { ok: false, reason: `confirmation "${typed}" does not match target "${target}"` };
  }
  return { ok: true, reason: 'confirmation matches target' };
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return { bucket: get('--bucket'), confirm: get('--yes-i-am-sure') };
}

function promptConfirmation(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (answer) => { rl.close(); res(answer); }));
}

function destroyBucket(bucket) {
  const uri = `gs://${bucket}`;
  console.log(`[gcs-destroy-bucket] emptying ${uri} …`);
  const empty = spawnSync('gcloud', ['storage', 'rm', '-r', uri], { stdio: 'inherit', encoding: 'utf8' });
  // `rm -r` on an already-empty bucket returns non-zero (nothing matched); the
  // bucket delete below is the authoritative step, so a benign empty result is
  // tolerated and surfaced rather than treated as fatal.
  if (empty.status !== 0) {
    console.warn(`[gcs-destroy-bucket] object removal returned exit ${empty.status} (may already be empty) — proceeding to bucket delete`);
  }
  console.log(`[gcs-destroy-bucket] deleting bucket ${uri} …`);
  const del = spawnSync('gcloud', ['storage', 'buckets', 'delete', uri], { stdio: 'inherit', encoding: 'utf8' });
  if (del.status !== 0) {
    console.error(`[gcs-destroy-bucket] bucket delete failed (exit ${del.status})`);
    process.exit(1);
  }
  console.log(`[gcs-destroy-bucket] done — ${uri} deleted`);
}

async function main() {
  const { bucket, confirm } = parseArgs(process.argv.slice(2));

  if (!bucket) {
    console.error('BLOCKED: --bucket <name> is required');
    process.exit(1);
  }

  console.log(`[gcs-destroy-bucket] resolved destructive target: gs://${bucket}`);

  // Non-interactive path: --yes-i-am-sure must exactly match --bucket.
  if (confirm !== undefined) {
    const gate = resolveAndConfirm(bucket, confirm);
    if (!gate.ok) {
      console.error(`BLOCKED: ${gate.reason} — no action taken`);
      process.exit(1);
    }
    destroyBucket(bucket);
    return;
  }

  // Interactive path: require the operator to type the exact bucket name back.
  const typed = await promptConfirmation(
    `Type the EXACT bucket name to confirm irreversible destruction of gs://${bucket}: `,
  );
  const gate = resolveAndConfirm(bucket, typed);
  if (!gate.ok) {
    console.error(`BLOCKED: ${gate.reason} — no action taken`);
    process.exit(1);
  }
  destroyBucket(bucket);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
