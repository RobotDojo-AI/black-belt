/**
 * AGENTS.md fetcher for the Assistant tab.
 * Story st_d9fc573b — AC 8, AC 9.
 *
 * WHY this isolation: routes/accounts.js stays thin. The two-state read
 * (onboarding vs ready) is testable with a mock db that returns either a
 * canonical_versions row or nothing — without needing a real file on disk.
 *
 * Read path:
 *   1. canonical_versions row WHERE doc_path LIKE '%agents/agents.md'
 *      ORDER BY id DESC LIMIT 1.
 *   2. If no row → state: 'onboarding' with the building-profile placeholder.
 *   3. If row exists → read the file from disk, return content + state: 'ready'.
 *
 * canonical_versions does NOT store the body — only the hash and metadata.
 * The body lives on disk at the canonical path. We expand `~` to homedir.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { AGENTS_INDEX_PATH } from './robotdojo-paths.js';

const ONBOARDING_PLACEHOLDER = 'Currently building agent profile from your history';

function projectAgentsForFrontend(body) {
  const names = [
    ['Miyagi', 'the owner-facing orchestrator and product-intent keeper.'],
    ['Tantei', 'the codebase mapper who finds what the system really does.'],
    ['Hakase', 'the researcher who brings in current, source-backed outside knowledge.'],
    ['Ori', 'the architect for schema, API, and multi-phase design.'],
    ['Katagami', 'the builder who turns sealed plans into product code.'],
    ['Bunshin', 'the auditor who catches weak work before it reaches the owner.'],
  ].filter(([name]) => new RegExp(`\\b${name}\\b`).test(body || ''));

  return [
    '# Agents',
    'Robot Dojo is not a single generic assistant. It is a small operating team with named roles, shared memory, and stage gates so important work gets mapped, scoped, built, and checked.',
    names.length ? '## Team\n\n' + names.map(([name, desc]) => `- **${name}:** ${desc}`).join('\n') : '',
    '## How They Work Together',
    'Miyagi stays with the user. The specialists handle focused work behind the scenes: mapping the codebase, researching outside facts, designing the plan, building the change, and auditing the result.',
    '## Edit Source',
    'Click Edit to tune the real AGENTS.md through a guided chat session. When you approve the final markdown, Robot Dojo writes it back to disk.',
  ].filter(Boolean).join('\n\n');
}

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~')) return resolve(homedir(), p.slice(p.startsWith('~/') ? 2 : 1));
  return p;
}

/**
 * Return AGENTS.md content + state for the Assistant tab.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ forceState?: 'new_user' }} [opts]
 * @returns {{ content: string, state: 'ready'|'onboarding' }}
 */
export function getAgentsMdForFrontend(db, opts = {}) {
  if (opts.forceState === 'new_user') {
    return { content: ONBOARDING_PLACEHOLDER, state: 'onboarding' };
  }

  // canonical_versions row tells us a version exists. The hash is just for
  // integrity; the body is on disk.
  let row;
  try {
    row = db.prepare(
      "SELECT doc_path FROM canonical_versions WHERE doc_path LIKE '%agents/agents.md' ORDER BY id DESC LIMIT 1"
    ).get();
  } catch {
    row = null;
  }

  // Try the canonical path even when the row is missing — on a fresh install
  // the file may exist on disk before the canonical_versions row is recorded.
  // We prefer to surface the actual content if we can read it.
  const candidates = [];
  if (row?.doc_path) candidates.push(expandPath(row.doc_path));
  candidates.push(AGENTS_INDEX_PATH);

  for (const path of candidates) {
    try {
      const body = readFileSync(path, 'utf8');
      if (body && body.length >= 200) {
        return { content: projectAgentsForFrontend(body), state: 'ready', source: 'agents/agents.md' };
      }
    } catch {
      // try next candidate
    }
  }

  return { content: ONBOARDING_PLACEHOLDER, state: 'onboarding' };
}
