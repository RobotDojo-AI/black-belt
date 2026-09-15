// lib/identity-targets/render.js — shared snapshot → markdown rendering.
//
// Every target adapter wraps this same rendered block differently (HTML
// comment fences for CLAUDE.md, MDC frontmatter for Cursor, custom-
// instructions text area for ChatGPT, etc). The rendered body itself is
// identical across targets — one source of truth per user.

import { SECTION_LABELS } from '../identity-log.js';

/**
 * Turn a snapshot (from identity-log.currentSnapshot) into a single markdown
 * block. Empty sections are skipped. Default sections appear in declared
 * order; custom sections after them, alphabetically.
 *
 * @param {object} snapshot  { sections, order }
 * @param {object} [opts]
 * @param {boolean} [opts.includeHeader]  prepend an intro sentence explaining
 *                                        the block's provenance. Default true.
 * @param {string}  [opts.targetLabel]    target name for the header
 */
export function renderBlock(snapshot, { includeHeader = true, targetLabel = null } = {}) {
  const { sections, order } = snapshot;
  const parts = [];

  if (includeHeader) {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const suffix = targetLabel ? ` for ${targetLabel}` : '';
    parts.push(
      `_The following is a Robot Dojo identity block${suffix}. ` +
      `It describes who you're talking to and how they work. ` +
      `Use it to inform every response. Updated: ${ts}._`,
    );
    parts.push('');
  }

  for (const section of order) {
    const entry = sections[section];
    if (!entry || !entry.body || !entry.body.trim()) continue;
    const label = SECTION_LABELS[section] || humanize(section);
    // H1 dividers so the user's own H2 subsections nest correctly underneath.
    parts.push(`# ${label}`);
    parts.push('');
    parts.push(entry.body.trim());
    parts.push('');
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function humanize(section) {
  return section.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Content hash — used by guided adapters to detect when the user needs to
 * re-paste their identity into a web app.
 */
export function contentHashInput(snapshot) {
  const { sections, order } = snapshot;
  return order.map((s) => `${s}:${(sections[s]?.body || '').trim()}`).join('\n\n');
}
