// lib/agent-personas.js — repo-owned agent persona source of truth.
//
// `agents/agents.md` is the roster and routing contract. The files in
// `agents/personas/*.md` are the full persona bodies. Tool-specific files
// under `agents/dist/` and home-directory adapters are disposable outputs.

import { readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AGENTS_ROOT, AGENT_PERSONAS_DIR, REPO_ROOT } from './robotdojo-paths.js';

export const PERSONA_ORDER = ['Miyagi', 'Tantei', 'Hakase', 'Ori', 'Katagami', 'Bunshin'];

export function identityRoot() {
  return AGENTS_ROOT;
}

export function personasDir() {
  return AGENT_PERSONAS_DIR;
}

export function personaPath(displayName) {
  return join(personasDir(), `${displayName}.md`);
}

export function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---\n')) return { data: {}, body: markdown };
  const end = markdown.indexOf('\n---\n', 4);
  if (end < 0) return { data: {}, body: markdown };
  const raw = markdown.slice(4, end);
  return {
    data: parseSimpleYaml(raw),
    body: markdown.slice(end + '\n---\n'.length),
    raw,
  };
}

function parseSimpleYaml(raw) {
  const data = {};
  const lines = raw.split('\n');
  let key = null;
  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const value = kv[2].trim();
      data[key] = value === '' ? [] : stripQuotes(value);
      continue;
    }
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(stripQuotes(item[1].trim()));
    }
  }
  return data;
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function readPersona(displayName) {
  const path = personaPath(displayName);
  const markdown = readFileSync(path, 'utf8');
  const { data, body, raw } = parseFrontmatter(markdown);
  return {
    displayName,
    path,
    markdown,
    frontmatter: data,
    frontmatterRaw: raw || '',
    body,
    hash: createHash('sha256').update(markdown).digest('hex'),
  };
}

export function readAllPersonas() {
  const present = new Set(
    readdirSync(personasDir())
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, '')),
  );
  const missing = PERSONA_ORDER.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`missing canonical persona file(s): ${missing.join(', ')}`);
  }
  return PERSONA_ORDER.map(readPersona);
}

export function renderPersonaForAdapter(persona, { generated = true } = {}) {
  if (!generated) return persona.markdown;
  let firstMarker = true;
  return persona.markdown.replace(/<!--\s*HUMAN-AUTHORED\.\s*REGEN BLOCKED\.\s*-->/g, () => {
    if (firstMarker) {
      firstMarker = false;
      return '<!-- GENERATED ADAPTER. Edit agents/personas/' + persona.displayName + '.md, not this file. -->';
    }
    return '<!-- GENERATED ADAPTER. Source fragment marker stripped. -->';
  });
}

// ─── Fragment resync (st_463b0bf6) ──────────────────────────────────────────
// Voice-source edits propagate a config/agent-voice/*.md source into all six
// persona files' inlined fragment copies. Before this, nothing wrote into
// the fragment-wrapped region of any persona file — resyncing after a source
// edit was a manual, per-file hand-copy operation (see st_463b0bf6 research
// §5: the "Rescue" commit, a real production instance of six persona files
// drifting out of sync for about an hour after a base.md edit, hand-fixed
// only because someone happened to catch it before the next commit).
//
// INCLUDE_MARKER_RE is shared with scripts/check-persona-ontology.js (moved
// here, verbatim, so a third module doesn't independently re-derive the
// fragment-marker format).

export const INCLUDE_MARKER_RE = /<!--\s*(?:include|default-quality):\s*([^\s]+)\s+sha256=([a-f0-9]{64})\s*-->/g;

// The literal tilde prefix every include marker in agents/personas/*.md
// uses today (`~/robotdojo/config/agent-voice/voice.md`, etc.) — hardcoded,
// not derived from REPO_ROOT, matching check-persona-ontology.js's own
// `resolveIncludePath()` convention (a test/fixture repo root override must
// not change what string the markers themselves contain).
const REPO_TILDE_PREFIX = '~/robotdojo/';

// fragmentId(includeRef) — the id used in `fragment:start:{id}` /
// `fragment:end:{id}` markers, derived from an include ref. Confirmed against
// all three include types actually present on disk:
//   ~/robotdojo/config/agent-voice/voice.md -> robotdojo/config/agent-voice/voice
//   ~/robotdojo/agents/default-quality.md -> robotdojo/agents/default-quality
//   ~/robotdojo/config/agent-voice/formatting/coding-agent.md
//     -> robotdojo/config/agent-voice/formatting/coding-agent
// Generic over any include marker, not voice-specific — costs nothing extra.
export function fragmentId(includeRef) {
  let id = includeRef;
  if (id.startsWith('~/')) id = id.slice(2);
  if (id.endsWith('.md')) id = id.slice(0, -3);
  return id;
}

// The exact wrapping convention every currently-clean fragment body uses:
// two newlines, the source's own on-disk content (which already ends with
// one trailing newline), one more newline, then the fragment:end tag.
// Verified byte-for-byte against all six personas' base.md fragment today
// before this function ever wrote anything.
function _fragmentBody(sourceContent) {
  return `\n\n${sourceContent}\n`;
}

// Finds a `fragment:start:{fragId}` / `fragment:end:{fragId}` pair
// immediately following `afterIndex` (only whitespace may separate the prior
// marker from the fragment:start tag — the bare `default-quality:` marker
// has no such pair; it is followed by another marker instead). Returns null
// when no such pair immediately follows.
function _findFragmentSpan(content, afterIndex, fragId) {
  const startTag = `<!-- fragment:start:${fragId} -->`;
  const endTag = `<!-- fragment:end:${fragId} -->`;
  const gapMatch = content.slice(afterIndex).match(/^\s*/);
  const tagStart = afterIndex + (gapMatch ? gapMatch[0].length : 0);
  if (!content.startsWith(startTag, tagStart)) return null;
  const bodyStart = tagStart + startTag.length;
  const bodyEnd = content.indexOf(endTag, bodyStart);
  if (bodyEnd === -1) return null;
  return { bodyStart, bodyEnd };
}

// Locates every INCLUDE_MARKER_RE occurrence in `content` whose ref resolves
// to `tildeRef`, in ascending document order.
function _findMarkersForSource(content, tildeRef) {
  const matches = [];
  INCLUDE_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = INCLUDE_MARKER_RE.exec(content)) !== null) {
    if (m[1] === tildeRef) {
      matches.push({ index: m.index, length: m[0].length, hash: m[2] });
    }
  }
  return matches;
}

/**
 * resyncPersonaFragment(sourceRelPath) — propagates a source file (repo-root-
 * relative, e.g. `config/agent-voice/voice.md`) into every persona's inlined
 * fragment copy that embeds it.
 *
 * Three-way match count, not binary (st_463b0bf6 plan — verified against a
 * real gap in an earlier draft):
 *   - zero personas carry any marker for this source → valid no-op. This is
 *     today's correct state for `channels/chat-app.md` / `channels/codex.md`
 *     — live /correction placement-map targets embedded in zero personas.
 *   - some-but-not-all personas carry the marker → a real inconsistency;
 *     throws naming which personas are missing it. Touches zero files.
 *   - all six carry the marker → resyncs all six.
 *
 * Two-phase for the all-six case: every persona's full replacement bytes are
 * computed in memory first; only then is any file written, atomically (tmp +
 * rename). This bounds the failure window to six fast local renames — the
 * only residual risk is a mid-write disk error, the same risk every other
 * canonical write in the repo already carries via _atomicWrite.
 *
 * For each matched marker occurrence: the declared sha256 is always
 * refreshed. Additionally, when that specific occurrence is immediately
 * followed by a `fragment:start`/`fragment:end` pair, the body between them
 * is replaced with the source's current on-disk content. A marker with no
 * following fragment pair (the bare `default-quality:` marker) only gets its
 * sha refreshed.
 */
export function resyncPersonaFragment(sourceRelPath) {
  const tildeRef = `${REPO_TILDE_PREFIX}${sourceRelPath}`;
  const sourceAbsPath = resolve(REPO_ROOT, sourceRelPath);
  const sourceContent = readFileSync(sourceAbsPath, 'utf8');
  const sourceSha = createHash('sha256').update(sourceContent).digest('hex');
  const fragId = fragmentId(tildeRef);

  const perPersona = new Map();
  const withMarker = [];
  const withoutMarker = [];

  for (const name of PERSONA_ORDER) {
    const path = personaPath(name);
    const content = readFileSync(path, 'utf8');
    const matches = _findMarkersForSource(content, tildeRef);
    if (matches.length > 0) withMarker.push(name);
    else withoutMarker.push(name);
    perPersona.set(name, { path, content, matches });
  }

  if (withMarker.length === 0) {
    return { resynced: [], reason: 'no-op — source not embedded in any persona' };
  }
  if (withMarker.length < PERSONA_ORDER.length) {
    throw new Error(
      `resyncPersonaFragment: ${sourceRelPath} is embedded in some but not all personas ` +
        `(missing: ${withoutMarker.join(', ')}) — refusing a partial resync`,
    );
  }

  // Phase 1 — compute every persona's full replacement bytes in memory.
  const writes = [];
  for (const name of PERSONA_ORDER) {
    const { path, content, matches } = perPersona.get(name);
    let next = content;
    // Process from the last match backwards so earlier match indices stay valid.
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const markerEnd = match.index + match.length;
      const oldMarkerText = next.slice(match.index, markerEnd);
      const newMarkerText = oldMarkerText.replace(match.hash, sourceSha);
      const span = _findFragmentSpan(next, markerEnd, fragId);
      if (span) {
        next = next.slice(0, match.index)
          + newMarkerText
          + next.slice(markerEnd, span.bodyStart)
          + _fragmentBody(sourceContent)
          + next.slice(span.bodyEnd);
      } else {
        next = next.slice(0, match.index) + newMarkerText + next.slice(markerEnd);
      }
    }
    writes.push({ path, content: next });
  }

  // Phase 2 — write atomically (tmp + rename), only after all bytes are computed.
  for (const { path, content } of writes) {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, { mode: 0o644 });
    renameSync(tmp, path);
  }

  return { resynced: PERSONA_ORDER.slice(), sourceSha };
}

/**
 * verifyFragmentConsistency(sourceRelPath) — the counterpart check AC4 needs.
 * `check-persona-ontology.js`'s stale-hash check only proves a marker's OWN
 * declared sha256 is current — never that the inlined text between the
 * fragment markers is actually correct. A resync bug that writes a fresh,
 * correct sha but a stale or misplaced body would pass that check silently.
 *
 * Diffs the actual fragment-body bytes across every persona that embeds this
 * source against the source's live on-disk content — not just the marker's
 * claim. Personas with no fragment pair for this source are not checked
 * (mirrors resyncPersonaFragment's own no-op-on-zero-matches rule; a
 * some-but-not-all inconsistency is resyncPersonaFragment's throw, not
 * duplicated here).
 *
 * Returns { ok, checkedCount, mismatches }. `checkedCount === 0` means this
 * source has no fragment pair in any persona today (a valid, checked state,
 * not a failure).
 */
export function verifyFragmentConsistency(sourceRelPath) {
  const tildeRef = `${REPO_TILDE_PREFIX}${sourceRelPath}`;
  const sourceAbsPath = resolve(REPO_ROOT, sourceRelPath);
  const sourceContent = readFileSync(sourceAbsPath, 'utf8');
  const expectedBody = _fragmentBody(sourceContent);
  const fragId = fragmentId(tildeRef);

  const mismatches = [];
  let checkedCount = 0;
  for (const name of PERSONA_ORDER) {
    const content = readFileSync(personaPath(name), 'utf8');
    for (const match of _findMarkersForSource(content, tildeRef)) {
      const span = _findFragmentSpan(content, match.index + match.length, fragId);
      if (!span) continue;
      checkedCount++;
      const actualBody = content.slice(span.bodyStart, span.bodyEnd);
      if (actualBody !== expectedBody) {
        mismatches.push({ persona: name, reason: 'fragment-body-drift' });
      }
    }
  }

  return { ok: mismatches.length === 0, checkedCount, mismatches };
}
