#!/usr/bin/env node
/**
 * backfill-timestamps.js
 * Backfill closed_at for terminal stories (kanban: done/cancelled/archived) that are missing it.
 *
 * Source priority for done stories:
 *   1. meta.completed
 *   2. stage-hashes.chain.close.owner_approved
 *   3. stage-hashes.chain.close.agent_sealed
 *   4. meta.json filesystem mtime
 *
 * Source priority for cancelled/archived stories:
 *   1. Latest timestamp from any stage-hashes chain entry
 *   2. meta.json filesystem mtime
 *
 * Idempotent — skips stories that already have closed_at.
 * After writing closed_at, calls Asana API to mark task complete if asana_gid is set.
 *
 * Usage: node scripts/backfill-timestamps.js
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import https from 'node:https';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

const HOME = process.env.HOME;
const STORIES_BASE = PIPELINE_STORIES_DIR;

// ── Asana PAT ─────────────────────────────────────────────────────────────────

function getPAT() {
  if (process.env.ASANA_PAT) return process.env.ASANA_PAT;
  try {
    return execSync('security find-generic-password -s "robotdojo-ASANA_PAT" -a "miyagi" -w', {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null; // PAT optional — skip Asana push if unavailable
  }
}

// ── Asana PATCH ───────────────────────────────────────────────────────────────

function asanaPatch(gid, body, pat) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ data: body });
    const options = {
      hostname: 'app.asana.com',
      path: `/api/1.0/tasks/${gid}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Asana API ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          resolve();
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Timestamp helpers ─────────────────────────────────────────────────────────

function latestChainTimestamp(chain) {
  const timestamps = [];
  for (const entry of Object.values(chain)) {
    if (entry.owner_approved) timestamps.push(entry.owner_approved);
    if (entry.agent_sealed) timestamps.push(entry.agent_sealed);
    if (entry.amended_at) timestamps.push(entry.amended_at);
  }
  if (timestamps.length === 0) return null;
  return timestamps.sort().pop(); // latest
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dirs = readdirSync(STORIES_BASE).filter(d => /^(st|df|wk)_/.test(d));
  const pat = getPAT();

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const dir of dirs) {
    const storyDir = join(STORIES_BASE, dir);
    const metaPath = join(storyDir, 'meta.json');

    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch (e) {
      process.stderr.write(`Warning: skipping ${dir} — cannot read meta.json: ${e.message}\n`);
      errors++;
      continue;
    }

    const { kanban, asana_gid } = meta;

    // Only process terminal stories
    if (!['done', 'cancelled', 'archived'].includes(kanban)) continue;

    // Already has closed_at — idempotent skip
    if (meta.closed_at) {
      skipped++;
      continue;
    }

    // Determine closed_at source
    let closedAt = null;
    let source = null;

    if (kanban === 'done') {
      // Priority 1: meta.completed
      if (meta.completed) {
        closedAt = meta.completed;
        source = 'meta.completed';
      }

      // Priority 2 & 3: stage-hashes close entry
      if (!closedAt) {
        const shPath = join(storyDir, 'stage-hashes.json');
        if (existsSync(shPath)) {
          try {
            const sh = JSON.parse(readFileSync(shPath, 'utf8'));
            const close = sh.chain?.close;
            if (close?.owner_approved) {
              closedAt = close.owner_approved;
              source = 'stage-hashes.close.owner_approved';
            } else if (close?.agent_sealed) {
              closedAt = close.agent_sealed;
              source = 'stage-hashes.close.agent_sealed';
            }
          } catch (e) {
            // fall through to mtime
          }
        }
      }
    } else {
      // cancelled/archived: use latest chain entry timestamp
      const shPath = join(storyDir, 'stage-hashes.json');
      if (existsSync(shPath)) {
        try {
          const sh = JSON.parse(readFileSync(shPath, 'utf8'));
          const latest = latestChainTimestamp(sh.chain || {});
          if (latest) {
            closedAt = latest;
            source = `stage-hashes.chain.latest`;
          }
        } catch (e) {
          // fall through to mtime
        }
      }
    }

    // Final fallback: meta.json filesystem mtime
    if (!closedAt) {
      try {
        const mtime = statSync(metaPath).mtime;
        closedAt = mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
        source = 'meta.json mtime';
      } catch (e) {
        process.stderr.write(`Warning: cannot get mtime for ${dir}: ${e.message}\n`);
        errors++;
        continue;
      }
    }

    // Write closed_at + updated_at to meta.json
    meta.closed_at = closedAt;
    meta.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    try {
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      process.stdout.write(`${dir} | ${kanban} | closed_at=${closedAt} | source=${source}\n`);
      processed++;
    } catch (e) {
      process.stderr.write(`Warning: failed to write meta.json for ${dir}: ${e.message}\n`);
      errors++;
      continue;
    }

    // Sync completion to Asana if task is done and has a GID
    if (kanban === 'done' && asana_gid && pat) {
      try {
        await asanaPatch(asana_gid, { completed: true, completed_at: closedAt }, pat);
        process.stdout.write(`  → Asana task ${asana_gid} marked completed\n`);
      } catch (e) {
        process.stderr.write(`  Warning: Asana sync failed for ${dir} (${asana_gid}): ${e.message}\n`);
      }
    }
  }

  process.stdout.write(`\nBackfill complete: ${processed} updated, ${skipped} already had closed_at, ${errors} errors.\n`);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
