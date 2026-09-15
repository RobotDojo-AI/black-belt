// lib/memory-ingest.js — fold flat auto-memory notes into the curated chain.
//
// Story st_b9ec1b7c. The harness writes flat .md notes (with `name` and a
// nested `metadata.type`) into user/memory/auto/. The chain is the
// authoritative store; flat notes are a write-cheap inbox. This module
// exposes the ingest pass used by scripts/maintenance-phases.js#phaseMemoryIngest.
//
// Idempotency contract: a flat note whose `name` already exists as a curated
// chain entry is skipped. The phase is therefore a no-op on a converged
// chain; only newly-written flat notes are appended. We dedupe by `name`
// (not by content) because the chain entry IS the canonical record — the
// flat note can drift; the chain entry is the source of truth for "do we
// have this memory at all".
//
// Living in lib/ (not inline in scripts/maintenance-phases.js) so it can be
// imported by tests without triggering the phase runner's top-level
// withLaunchDbWriterGuard, which opens the real database.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Run one memory-ingest pass.
 *
 * @param {object} opts
 * @param {string} opts.autoDir         directory of flat .md notes
 * @param {function} opts.appendMemory  the locked-append entry point
 * @param {function} opts.getLogIndex   returns the current chain entries
 *                                      (each with a `name` field) so we
 *                                      can dedupe by name
 * @param {function} [opts.warn]        optional warning sink for partial
 *                                      failures; defaults to console.warn
 * @returns {Promise<{ scanned, appended, skipped, failed, names }>}
 */
export async function runMemoryIngest({ autoDir, appendMemory, getLogIndex, warn = console.warn }) {
  let entries;
  try { entries = await readdir(autoDir, { withFileTypes: true }); }
  catch (e) {
    if (e.code === 'ENOENT') return { scanned: 0, appended: 0, skipped: 0, failed: 0, names: [] };
    throw e;
  }

  // WHY index-then-set: the chain may already contain an entry with the
  // same `name`. We materialize the existing names once up front so
  // O(notes) appends do not each pay an O(chain) scan.
  const existing = new Set();
  const index = await getLogIndex();
  for (const rec of index) if (rec.name) existing.add(rec.name);

  let appended = 0;
  let skipped = 0;
  let failed = 0;
  let scanned = 0;
  const appendedNames = [];

  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.endsWith('.md')) continue;
    if (dirent.name === 'MEMORY.md') continue; // projection, not a memory entry
    if (dirent.name.startsWith('.')) continue; // dotfiles / tmp
    scanned++;

    const path = join(autoDir, dirent.name);
    let content;
    try { content = await readFile(path, 'utf8'); }
    catch (e) { failed++; warn(`memory-ingest: read failed ${dirent.name}: ${e.message}`); continue; }

    const parsed = parseFlatNote(content);
    if (!parsed.name) {
      failed++;
      warn(`memory-ingest: ${dirent.name}: missing name in frontmatter — skip`);
      continue;
    }
    if (existing.has(parsed.name)) {
      skipped++;
      continue;
    }

    // Default type is `reference` per the plan — flat notes without an
    // explicit nested metadata.type are treated as background knowledge
    // rather than feedback/project/etc.
    const type = parsed.type || 'reference';
    const description = parsed.description || parsed.name;

    try {
      await appendMemory({
        type,
        name: parsed.name,
        description,
        author: parsed.author || 'auto-memory',
        body: parsed.body,
      });
      appended++;
      appendedNames.push(parsed.name);
      existing.add(parsed.name); // guard against same-name in a single run
    } catch (e) {
      failed++;
      warn(`memory-ingest: append failed for ${parsed.name}: ${e.message}`);
    }
  }

  return { scanned, appended, skipped, failed, names: appendedNames };
}

/**
 * Parse a flat auto-memory note. Frontmatter shape:
 *   ---
 *   name: kebab-case-name
 *   description: one-liner
 *   metadata:
 *     type: project | reference | feedback | session-note | user
 *   ---
 *   <body markdown>
 *
 * The schema differs from chain entries (no prev_hash; type nested under
 * metadata) because flat notes are write-cheap inbox items. The parser is
 * deliberately tolerant: a missing or malformed metadata block falls back
 * to type=undefined rather than aborting, and the caller defaults to
 * `reference`.
 */
export function parseFlatNote(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { name: null, body: content };
  }
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return { name: null, body: content };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) return { name: null, body: content };

  const out = { name: null, description: null, type: null, author: null };
  let inMetadata = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) { inMetadata = false; continue; }
    const top = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (top && !line.startsWith(' ') && !line.startsWith('\t')) {
      const key = top[1];
      const val = top[2];
      if (key === 'metadata') { inMetadata = val === ''; continue; }
      inMetadata = false;
      if (key === 'name') out.name = val.trim();
      else if (key === 'description') out.description = val.trim();
      else if (key === 'type') out.type = val.trim();
      else if (key === 'author') out.author = val.trim();
      continue;
    }
    if (inMetadata) {
      const nested = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
      if (nested && nested[1] === 'type') out.type = nested[2].trim();
    }
  }
  const body = lines.slice(end + 1).join('\n');
  return { ...out, body };
}
