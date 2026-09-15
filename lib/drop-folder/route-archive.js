/**
 * Archive router.
 *
 * Shells out to `unzip` / `tar` (both standard on macOS + Linux) to expand
 * into a sibling temp directory, then re-queues each extracted file into
 * Inbox/ for independent processing through the full classify → route pipeline.
 *
 * WHY re-queue to Inbox rather than process inline: decouples archive expansion
 * from the watcher's recursive-watch behavior. Each extracted file gets its own
 * classify + route pass independently, rather than inheriting the archive's
 * classification. expandDir is cleaned up after re-queuing.
 *
 * Returns metadata describing the archive itself. The original zip/tar is moved
 * to Archive/ by watcher.js after this function returns.
 */

import { spawn } from 'node:child_process';
import { mkdir, stat, rename, rm, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { topicForDocType } from '../taxonomy.js';
import { INBOX } from './paths.js';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`)));
  });
}

async function ensureDir(dir) { await mkdir(dir, { recursive: true }); }

export async function routeArchive({ path: filePath }) {
  const base = basename(filePath, extname(filePath));
  // Use dirname(filePath) so expandDir sits next to the source file.
  // WHY not /tmp: the source file may be on a different volume — same dir
  // avoids cross-device rename errors when re-queuing to Inbox.
  const expandDir = join(dirname(filePath), `${base}.expanded`);
  await ensureDir(expandDir);

  const ext = extname(filePath).toLowerCase();

  try {
    if (ext === '.zip') {
      await run('unzip', ['-q', '-o', filePath, '-d', expandDir]);
    } else if (ext === '.tar') {
      await run('tar', ['-xf', filePath, '-C', expandDir]);
    } else if (ext === '.tgz' || ext === '.gz') {
      await run('tar', ['-xzf', filePath, '-C', expandDir]);
    } else {
      // Unsupported — clean up expand dir and return an error result.
      await rm(expandDir, { recursive: true, force: true }).catch(() => {});
      const topic = topicForDocType('archive');
      return {
        doc_type: 'archive',
        topic_t1: topic.t1,
        topic_t2: topic.t2,
        extracted_json: null, entity_refs: null, confidence: 0,
        error: `unsupported archive extension: ${ext}`,
      };
    }
  } catch (err) {
    await rm(expandDir, { recursive: true, force: true }).catch(() => {});
    const topic = topicForDocType('archive');
    return {
      doc_type: 'archive',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: null, entity_refs: null, confidence: 0,
      error: `expand failed: ${err.message}`,
    };
  }

  // Re-queue extracted files into Inbox for independent processing.
  // Only top-level files — nested dirs are skipped (archives within archives
  // will be classified as archives and re-expanded on their own pass).
  const expandedEntries = await readdir(expandDir, { withFileTypes: true }).catch(() => []);
  let requeued = 0;
  for (const entry of expandedEntries) {
    if (!entry.isFile()) continue;
    const src = join(expandDir, entry.name);
    // st_f1a40461: prefix re-queued files with "<archive>__" so route-email groups
    // every file from one archive (e.g. a Google Takeout or PST→mbox set with many
    // folders) under ONE import account — never one account per folder/file.
    const dst = join(INBOX, `${base.replace(/[^A-Za-z0-9._-]+/g, '-')}__${entry.name}`);
    await rename(src, dst).catch(() => {});
    requeued++;
  }

  // Clean up the now-empty (or partially drained) expand dir.
  await rm(expandDir, { recursive: true, force: true }).catch(() => {});

  const topic = topicForDocType('archive');
  return {
    doc_type: 'archive',
    topic_t1: topic.t1,
    topic_t2: topic.t2,
    extracted_json: JSON.stringify({ expanded_count: requeued }),
    entity_refs: null,
    confidence: 0.7,
  };
}
