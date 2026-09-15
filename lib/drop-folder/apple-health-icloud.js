/**
 * Copy Health Auto Export JSON from iCloud Drive into the drop-folder inbox.
 *
 * HAE writes to iCloud Drive/AutoExport/{automation}/. The inbox watcher
 * deletes processed files — never process the iCloud original in place.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat, watch as fsWatch } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { INBOX } from './paths.js';
import { getByHash } from './index-db.js';

export function defaultAutoExportRoot() {
  return process.env.ROBOTDOJO_APPLE_HEALTH_ICLOUD_ROOT
    || join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/AutoExport');
}

function skipName(name) {
  return (
    name.startsWith('.')
    || name.endsWith('.icloud')
    || name.endsWith('.DS_Store')
    || name.endsWith('.crdownload')
    || name.endsWith('.part')
    || name.endsWith('.download')
  );
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const rs = createReadStream(filePath);
    rs.on('data', (b) => h.update(b));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

async function settled(filePath) {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    let s;
    try { s = await stat(filePath); }
    catch { return false; }
    if (s.isDirectory()) return false;
    if (s.size > 0 && s.size === last) return true;
    last = s.size;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function listJsonFiles(root) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    if (!name.toLowerCase().endsWith('.json') || skipName(name)) continue;
    const dir = e.parentPath || e.path || root;
    out.push(join(dir, name));
  }
  return out;
}

export async function copyAutoExportJsonToInbox(src, {
  inbox = INBOX,
  hashOf = sha256,
  alreadyHave = getByHash,
} = {}) {
  if (skipName(basename(src))) return { copied: false, reason: 'skip_name' };
  if (!(await settled(src))) return { copied: false, reason: 'not_settled' };
  const hash = await hashOf(src);
  const dup = alreadyHave(hash);
  if (dup && (dup.status === 'processed' || dup.status === 'upload_pending' || dup.status === 'credentials')) {
    return { copied: false, reason: 'already_ingested', hash };
  }
  await mkdir(inbox, { recursive: true });
  const dest = join(inbox, basename(src));
  try {
    const existing = await stat(dest);
    if (existing.isFile()) {
      const destHash = await hashOf(dest);
      if (destHash === hash) return { copied: false, reason: 'inbox_has_copy', dest };
    }
  } catch { /* dest missing */ }
  await copyFile(src, dest);
  return { copied: true, dest, hash };
}

export async function scanAutoExportToInbox(root, opts = {}) {
  const files = await listJsonFiles(root);
  const results = [];
  for (const src of files) {
    results.push(await copyAutoExportJsonToInbox(src, opts));
  }
  return results;
}

export async function startAppleHealthIcloudBridge({
  root = defaultAutoExportRoot(),
  inbox = INBOX,
  signal,
} = {}) {
  await mkdir(root, { recursive: true });
  await mkdir(inbox, { recursive: true });
  const scan = () => scanAutoExportToInbox(root, { inbox }).catch((err) => {
    console.warn('[apple-health-icloud] scan failed:', err.message);
  });
  await scan();
  (async () => {
    try {
      for await (const evt of fsWatch(root, { recursive: true, signal })) {
        const name = evt?.filename ? basename(evt.filename) : '';
        if (name && skipName(name)) continue;
        setTimeout(() => { scan(); }, 800);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error('[apple-health-icloud] watcher error:', err);
      }
    }
  })();
  console.info(`[apple-health-icloud] watching ${root} → ${inbox}`);
}
