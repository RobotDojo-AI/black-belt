/**
 * lib/transcripts.js — flat-file transcript archive.
 *
 * Exports:
 *   slugify(title, fallbackId)    — filesystem-safe slug from a title string
 *   writeTranscriptFile(row)      — write a Granola meeting row to user/transcripts/calls/
 *   writeConversationFile(id)     — write a chat conversation to user/transcripts/chat/
 *
 * WHY flat files: the canonical source of record for narrative content lives
 * outside SQLite so it can be indexed by external tools (spotlight, grep, RAG)
 * without requiring a DB connection. DB rows carry file_path as a pointer.
 * SQLite is the index; the flat file is the payload.
 *
 * Write pattern: atomic rename (write .tmp → rename) prevents partial reads.
 * Idempotency: both functions skip rows that already have file_path set.
 */

import { mkdirSync, writeFileSync, appendFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import db from './db.js';
import { USER_TRANSCRIPTS_DIR } from './robotdojo-paths.js';
import { ownerDisplayName, ownerPersonId } from './identity.js';

const CALLS_DIR = join(USER_TRANSCRIPTS_DIR, 'calls');
const CHAT_DIR  = join(USER_TRANSCRIPTS_DIR, 'chat');

function ensureDirs() {
  mkdirSync(CALLS_DIR, { recursive: true });
  mkdirSync(CHAT_DIR,  { recursive: true });
}

/**
 * Produce a filesystem-safe slug from a title string.
 * NFC normalize → lowercase → collapse non-alphanumeric runs to '-' →
 * strip leading/trailing '-' → truncate to 60 chars.
 * Falls back to the first 8 chars of fallbackId if slug is empty.
 */
export function slugify(title, fallbackId) {
  if (!title) return (fallbackId || 'unknown').slice(0, 8);
  const slug = title.normalize('NFC').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || (fallbackId || 'unknown').slice(0, 8);
}

/**
 * Extract YYYY-MM-DD and HHMM from an ISO timestamp string.
 * Returns { dateStr, timeStr } — both strings, never null.
 */
function parseDateTime(isoString) {
  if (!isoString) return { dateStr: '0000-00-00', timeStr: '0000' };
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return { dateStr: '0000-00-00', timeStr: '0000' };
  const iso = d.toISOString(); // e.g. "2026-05-06T15:23:49.930Z"
  const dateStr = iso.slice(0, 10);      // "2026-05-06"
  const timeStr = iso.slice(11, 16).replace(':', ''); // "1523"
  return { dateStr, timeStr };
}

/**
 * Render a transcript body from its attributed turns, one `Name: text` line per
 * turn (st_8a841c68 AC-7). An unassigned turn is labeled `Unassigned:` so the
 * structure is always honest — a name where we know it, an explicit blank where
 * we do not, never an anonymous run-on block. Returns null when the transcript
 * has no segments (caller falls back to the flat transcript_text).
 */
function renderAttributedBody(transcriptId) {
  const segments = db.prepare(
    'SELECT turn_index, speaker_person_id, text FROM transcript_segments WHERE transcript_id = ? ORDER BY turn_index ASC',
  ).all(transcriptId);
  if (segments.length === 0) return null;

  // Batch-resolve display names for the people who actually spoke.
  const ids = [...new Set(segments.map((s) => s.speaker_person_id).filter(Boolean))];
  const nameById = new Map();
  const ownerId = ownerPersonId();
  for (const id of ids) {
    if (id === ownerId) {
      nameById.set(id, ownerDisplayName());
      continue;
    }
    const p = db.prepare('SELECT display_name FROM people WHERE id = ?').get(id);
    nameById.set(id, (p?.display_name || '').trim() || 'Unknown');
  }

  const lines = [];
  for (const s of segments) {
    const label = s.speaker_person_id ? (nameById.get(s.speaker_person_id) || 'Unknown') : 'Unassigned';
    lines.push(`${label}: ${s.text || ''}`);
  }
  return lines.join('\n');
}

/**
 * Write a flat markdown file for a Granola transcript row.
 *
 * Idempotency (st_8a841c68 AC-7): on the first write the row has no file_path,
 * so we always write. On a re-attribution pass the row HAS a file_path; we
 * rewrite only when attributed_at is newer than the on-disk file's mtime — the
 * guard keys on freshness, not mere existence, so a confirm or a new profile
 * refreshes the disk copy while an unchanged call is skipped.
 *
 * The body is the attributed turns when the transcript has segments, else the
 * legacy flat transcript_text. Returns the file path string.
 */
export async function writeTranscriptFile(row) {
  ensureDirs();

  // Decide the target path. Reuse the existing file_path on a rewrite so the
  // re-attribution lands in the same file the chunk and consumers reference.
  let filePath = row.file_path || null;
  const { dateStr, timeStr } = parseDateTime(row.meeting_date);
  if (!filePath) {
    const slug = slugify(row.title, row.id);
    filePath = join(CALLS_DIR, `${dateStr}-${timeStr}-granola-${slug}.md`);
  }

  // Re-attribution freshness guard: if the file already exists, only rewrite
  // when there's a newer attribution pass than the file on disk.
  if (row.file_path && existsSync(filePath)) {
    const attributedAt = row.attributed_at ? Date.parse(row.attributed_at) : NaN;
    let fileMtime = 0;
    try { fileMtime = statSync(filePath).mtimeMs; } catch { fileMtime = 0; }
    if (!Number.isFinite(attributedAt) || attributedAt <= fileMtime) {
      return filePath; // nothing newer to write
    }
  }

  const hh = timeStr.slice(0, 2);
  const mm = timeStr.slice(2, 4);

  const frontmatter = [
    '---',
    `id: "${row.id}"`,
    `date: "${dateStr}"`,
    `time: "${hh}:${mm}"`,
    `source: "granola"`,
    `type: "meeting"`,
    `title: "${(row.title || '').replace(/"/g, '\\"')}"`,
    '---',
    '',
  ].join('\n');

  const body = renderAttributedBody(row.id) ?? (row.transcript_text || '');
  const content = frontmatter + body;

  // Atomic write: write to .tmp then rename
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, filePath);

  db.prepare('UPDATE transcripts SET file_path = ? WHERE id = ?').run(filePath, row.id);

  return filePath;
}

/**
 * Write a flat markdown file for a chat conversation.
 * Idempotent: returns existing file_path if conversation already has one.
 * Returns the file path string, or null if the conversation is not found.
 */
export async function writeConversationFile(id) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!conv) return null;
  if (conv.file_path) return conv.file_path;
  ensureDirs();

  // created_at may be "YYYY-MM-DD HH:MM:SS" (SQLite) or ISO format (imported rows)
  let dateStr, timeStr;
  if (conv.created_at) {
    // Use parseDateTime to handle both formats cleanly
    const parsed = parseDateTime(conv.created_at.includes('T') ? conv.created_at : conv.created_at.replace(' ', 'T'));
    dateStr = parsed.dateStr;
    timeStr = parsed.timeStr;
  } else {
    dateStr = '0000-00-00';
    timeStr = '0000';
  }

  // Provider: first segment of model field before '/' or '-', sanitized to filesystem-safe chars.
  // e.g. "chatgpt/gpt-4o" → "chatgpt", "claude-sonnet" → "claude", "grok-fast" → "grok"
  const modelStr = conv.model || 'unknown';
  const provider = modelStr.split('/')[0].split('-')[0].replace(/[^a-z0-9]/gi, '') || 'unknown';

  const slug = slugify(conv.title, conv.id);
  const filename = `${dateStr}-${timeStr}-${provider}-${slug}.md`;
  const filePath = join(CHAT_DIR, filename);

  const hh = timeStr.slice(0, 2);
  const mm = timeStr.slice(2, 4);

  const frontmatter = [
    '---',
    `id: "${conv.id}"`,
    `date: "${dateStr}"`,
    `time: "${hh}:${mm}"`,
    `source: "${provider}"`,
    `type: "chat"`,
    `title: "${(conv.title || '').replace(/"/g, '\\"')}"`,
    '---',
    '',
  ].join('\n');

  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, frontmatter, 'utf8');

  const messages = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq ASC'
  ).all(id);

  for (const msg of messages) {
    const block = `\n**${msg.role}:** ${msg.content || ''}\n`;
    appendFileSync(tmpPath, block, 'utf8');
  }

  renameSync(tmpPath, filePath);

  db.prepare('UPDATE conversations SET file_path = ? WHERE id = ?').run(filePath, conv.id);

  return filePath;
}
