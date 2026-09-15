/**
 * Google Drive sync — lists Drive files, extracts text, ingests to RAG.
 * White Belt: feeds the knowledge base so chat can answer questions about
 * documents stored in Drive.
 */
import crypto from 'node:crypto';
import db, { computeInsertValueRank } from './db.js';
import config from './config.js';
import { CHUNK_SIZE } from './rag.js';
import { classifyChunk } from './junk-classifier.js';
import { insertTimelineEvent } from './timeline-schema.js';
import { NEEDS_ROUTING_TOPIC, normalizeMemoryTopicSlug } from './topic-routing-policy.js';

let _oauth = null;
async function getOAuth() {
  if (_oauth) return _oauth;
  _oauth = await import('./google-oauth.js');
  return _oauth;
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const DRIVE_CONTENT_RANK = 3;

const GOOGLE_EXPORT_AS = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const EXTRACTABLE = new Set([
  'application/pdf',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
]);

// --- Drive file topic classification ---

// WHY generic client labels: this list previously used real
// client/employer names. Users add their own client/topic regexes via
// taxonomy.user.json overrides (gitignored). The generic defaults below
// classify everything reasonable a public user would have.
const TOPIC_RULES = [
  [/health|medical|doctor|lab|prescription|dexa|physical therapy|blood test/i, 'health'],
  [/tax|invoice|receipt|budget|1099|w-2|w2|accounting/i, 'finances'],
  [/wedding|guest.?list|save.the.date|engagement/i, 'relationships'],
  [/resume|cv\b|cover.letter|linkedin|job.search/i, 'career'],
  [/baby|nursery|newborn|pediatr|infant/i, 'family'],
  [/house|apartment|lease|rent|mortgage|renovation|real estate/i, 'home'],
  [/recipe|cooking|travel|backpack|piano|music|hobby/i, 'hobbies'],
  [/writing|blog|essay|draft|article|publish/i, 'writing'],
  [/family|photo|album|holiday|christmas|thanksgiving/i, 'home'],
];

export function classifyDriveFileTopic(name, parentPath = '') {
  const text = `${parentPath} ${name}`.toLowerCase();
  for (const [pattern, topic] of TOPIC_RULES) {
    if (pattern.test(text)) return topic;
  }
  return NEEDS_ROUTING_TOPIC;
}

export function normalizeDriveChunkTopic(topic) {
  const normalized = String(topic || NEEDS_ROUTING_TOPIC)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalizeMemoryTopicSlug(normalized, { fallback: true }) || NEEDS_ROUTING_TOPIC;
}

// --- Folder path map ---

async function buildFolderMap(token) {
  const folders = {};
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      pageSize: '1000',
      fields: 'nextPageToken,files(id,name,parents)',
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${DRIVE_API}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.timeouts.api),
    });
    if (!res.ok) break;

    const data = await res.json();
    pageToken = data.nextPageToken || null;
    for (const f of data.files || []) {
      folders[f.id] = { name: f.name, parentId: f.parents?.[0] || null };
    }
  } while (pageToken);

  const pathCache = {};
  function resolvePath(id) {
    if (!id || !folders[id]) return '';
    if (pathCache[id]) return pathCache[id];
    const f = folders[id];
    const parent = f.parentId ? resolvePath(f.parentId) : '';
    pathCache[id] = parent ? `${parent}/${f.name}` : f.name;
    return pathCache[id];
  }
  for (const id of Object.keys(folders)) resolvePath(id);
  return pathCache;
}

// --- DB helpers ---

const upsertFile = db.prepare(`
  INSERT INTO drive_files (id, drive_file_id, account_id, name, mime_type, modified_at, topic, text_content, indexed_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(drive_file_id) DO UPDATE SET
    name = excluded.name,
    mime_type = excluded.mime_type,
    modified_at = excluded.modified_at,
    topic = excluded.topic,
    text_content = excluded.text_content,
    indexed_at = excluded.indexed_at
`);

const getExisting = db.prepare('SELECT modified_at, indexed_at FROM drive_files WHERE drive_file_id = ?');

const insertChunk = db.prepare(`
  INSERT INTO chunks (
    topic, source_type, source_id, chunk_index, content, metadata, token_count,
    embedded, skip_embed, created_at, content_rank, event_time, value_rank
  )
  VALUES (?, 'drive', ?, ?, ?, ?, ?, 0, 0, datetime('now'), ?, ?, ?)
  ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
    content = excluded.content,
    metadata = excluded.metadata,
    token_count = excluded.token_count,
    content_rank = excluded.content_rank,
    event_time = excluded.event_time,
    value_rank = excluded.value_rank,
    embedded = CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed = 0 THEN chunks.embedded ELSE 0 END,
    skip_embed = 0,
    content_hash = CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed = 0 THEN chunks.content_hash ELSE NULL END,
    embedding_model_id = CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed = 0 THEN chunks.embedding_model_id ELSE NULL END,
    embedding_dim = CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed = 0 THEN chunks.embedding_dim ELSE NULL END,
    embedding_signature = CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed = 0 THEN chunks.embedding_signature ELSE NULL END,
    embedded_at = CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed = 0 THEN chunks.embedded_at ELSE NULL END
`);

// WHY a parallel insertChunkSkip: drive chunks that fall below the junk
// classifier's token floor still get a chunks-table row (so we don't re-
// process them on the next sync), but we set skip_embed=1 so the embedder
// never pulls them.
const insertChunkSkip = db.prepare(`
  INSERT INTO chunks (
    topic, source_type, source_id, chunk_index, content, metadata, token_count,
    embedded, skip_embed, created_at, content_rank, event_time, value_rank
  )
  VALUES (?, 'drive', ?, ?, ?, ?, ?, 0, 1, datetime('now'), ?, ?, ?)
  ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
    content    = excluded.content,
    metadata   = excluded.metadata,
    token_count = excluded.token_count,
    content_rank = excluded.content_rank,
    event_time = excluded.event_time,
    value_rank = excluded.value_rank,
    embedded   = 0,
    skip_embed = 1,
    content_hash = NULL,
    embedding_model_id = NULL,
    embedding_dim = NULL,
    embedding_signature = NULL,
    embedded_at = NULL
`);

// --- Text extraction ---

async function extractText(driveFileId, mimeType, token) {
  const exportMime = GOOGLE_EXPORT_AS[mimeType];

  if (exportMime) {
    const res = await fetch(
      `${DRIVE_API}/files/${driveFileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(config.timeouts.api) }
    );
    if (!res.ok) return null;
    return res.text();
  }

  if (mimeType === 'application/pdf') {
    const res = await fetch(`${DRIVE_API}/files/${driveFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.timeouts.api),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      const { extractPdfText } = await import('./text-extractors.js');
      const { content } = await extractPdfText(buf);
      return content;
    } catch {
      return buf.toString('utf-8').replace(/[^\x20-\x7E\n\t\r]/g, ' ');
    }
  }

  if (mimeType === 'text/plain' || mimeType === 'text/markdown' || mimeType === 'text/csv') {
    const res = await fetch(`${DRIVE_API}/files/${driveFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.timeouts.api),
    });
    if (!res.ok) return null;
    return res.text();
  }

  return null;
}

// --- Chunk ingest ---

export function ingestDriveTextChunks(driveFileId, text, topic, meta, eventTime = null) {
  if (!text || !text.trim()) return 0;
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  const safeTopic = normalizeDriveChunkTopic(topic);

  let count = 0;
  db.transaction(() => {
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx].trim();
      if (!chunk) continue;

      // WHY classifyChunk here: enforce the same junk-substance floor on
      // Drive content that chunk-worker enforces on emails. Drive bodies
      // carry no email headers, so the classifier's header signals are
      // inert; the token-floor + short-body check is the active filter.
      // A 3-token PDF page is still junk by the same standard a "thanks!"
      // email is.
      const verdict = classifyChunk({ source_type: 'drive', body: chunk });
      const stmt = verdict.shouldEmbed ? insertChunk : insertChunkSkip;
      stmt.run(
        safeTopic,
        driveFileId,
        idx,
        chunk,
        JSON.stringify({ ...meta, chunk_index: idx, chunk_total: chunks.length }),
        Math.ceil(chunk.length / 4),
        DRIVE_CONTENT_RANK,
        eventTime || null,
        computeInsertValueRank(eventTime || null, chunk, DRIVE_CONTENT_RANK),
      );
      count++;
    }
  })();
  return count;
}

// --- Core sync ---

/**
 * Sync Drive files for a single Google account.
 * @param {string} email - Google account email
 * @param {object} opts
 * @param {string[]} [opts.mimeTypes] - Restrict to these MIME types
 * @param {number|null} [opts.maxFiles=200] - Max files to process per run; null means no cap
 * @param {Date} [opts.sinceDate] - Only process files modified after this date
 */
export async function syncDriveAccount(email, opts = {}) {
  const { mimeTypes, sinceDate } = opts;
  const maxFiles = opts.maxFiles === null ? null : (opts.maxFiles ?? 200);

  let oauth;
  try {
    oauth = await getOAuth();
  } catch (err) {
    console.error('[drive-sync] google-oauth.js not available:', err.message);
    return { error: 'google-oauth.js not available', indexed: 0, ingested: 0 };
  }

  let token;
  try {
    token = await oauth.getValidAccessToken(email);
  } catch (err) {
    console.error(`[drive-sync] failed to get token for ${email}:`, err.message);
    db.prepare(`UPDATE accounts SET last_error=? WHERE vendor='google' AND type='drive' AND email=?`)
      .run(err.message.slice(0, 500), email);
    return { error: err.message, indexed: 0, ingested: 0 };
  }

  const folderPaths = await buildFolderMap(token);

  const filterMimes = mimeTypes ? new Set(mimeTypes) : null;
  const sinceIso = sinceDate ? sinceDate.toISOString() : null;

  let pageToken = null;
  let indexed = 0;
  let ingested = 0;
  let skipped = 0;

  do {
    const params = new URLSearchParams({
      pageSize: '100',
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents)',
      q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
    });
    if (sinceIso) params.set('q', `trashed = false and mimeType != 'application/vnd.google-apps.folder' and modifiedTime > '${sinceIso}'`);
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${DRIVE_API}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.timeouts.api),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive API ${res.status}: ${body}`);
    }

    const data = await res.json();
    pageToken = data.nextPageToken || null;

    for (const file of data.files || []) {
      if (maxFiles !== null && indexed >= maxFiles) { pageToken = null; break; }

      if (!EXTRACTABLE.has(file.mimeType)) { skipped++; continue; }
      if (filterMimes && !filterMimes.has(file.mimeType)) { skipped++; continue; }

      const sizeMb = parseInt(file.size || '0');
      if (sizeMb > MAX_FILE_BYTES) { skipped++; continue; }

      const parentPath = file.parents?.[0] ? (folderPaths[file.parents[0]] || '') : '';
      const topic = classifyDriveFileTopic(file.name, parentPath);
      const recordId = crypto.createHash('sha256').update(`drive:${email}:${file.id}`).digest('hex').slice(0, 24);

      const existing = getExisting.get(file.id);
      const alreadyCurrent = existing && existing.indexed_at && existing.modified_at === file.modifiedTime;
      if (alreadyCurrent) { skipped++; continue; }

      let textContent = null;
      try {
        textContent = await extractText(file.id, file.mimeType, token);
      } catch (err) {
        console.warn(`[drive-sync] extract failed for ${file.name}: ${err.message}`);
      }

      const cappedText = textContent ? textContent.slice(0, 100000) : null;

      upsertFile.run(
        recordId,
        file.id,
        email,
        file.name,
        file.mimeType,
        file.modifiedTime || null,
        topic,
        cappedText,
        new Date().toISOString(),
      );
      insertTimelineEvent({
        sourceType: 'drive',
        sourceId: file.id,
        eventDate: file.modifiedTime || new Date().toISOString(),
        eventType: 'document',
        summary: file.name || 'Drive file',
        content: `${file.name || ''}\n${topic}`,
        metadata: { account_id: email, mime_type: file.mimeType, topic },
      });
      indexed++;

      if (cappedText) {
        const chunks = ingestDriveTextChunks(file.id, cappedText, topic, {
          source: 'drive',
          account: email,
          file_name: file.name,
          mime_type: file.mimeType,
          drive_file_id: file.id,
        }, file.modifiedTime || null);
        ingested += chunks;
      }
    }
  } while (pageToken);

  console.info(`[drive-sync] ${email}: indexed=${indexed} ingested_chunks=${ingested} skipped=${skipped}`);
  db.prepare(`UPDATE accounts SET synced_at=datetime('now'), last_error=NULL WHERE vendor='google' AND type='drive' AND email=?`)
    .run(email);
  return { email, indexed, ingested, skipped };
}

/**
 * Sync Drive for all connected Google accounts.
 */
export async function syncAllDriveAccounts(opts = {}) {
  let oauth;
  try {
    oauth = await getOAuth();
  } catch (err) {
    console.error('[drive-sync] google-oauth.js not available:', err.message);
    return [];
  }

  const accounts = await oauth.listConnectedGoogleAccounts();
  if (!accounts.length) {
    console.info('[drive-sync] no connected Google accounts');
    return [];
  }

  const results = [];
  for (const email of accounts) {
    try {
      const result = await syncDriveAccount(email, opts);
      results.push(result);
    } catch (err) {
      console.error(`[drive-sync] ${email} failed:`, err.message);
      results.push({ email, error: err.message });
    }
  }
  return results;
}
