/**
 * tier-1/intent-context.js — bundle the context for the Haiku prompt.
 *
 * WHY a structured bundle and not a free-form prompt: each piece (canonical
 * paths, sibling files, recent commits, signals, file head) is a deterministic
 * input. Bullet-list format keeps tokens cheap and the model focused. The
 * Haiku call should cost ~$0.001/file at most.
 *
 * Pieces:
 *   - file path + size + first 200 lines
 *   - canonical_paths from registry
 *   - tier-0 signals (with disagreements)
 *   - sibling files in the same directory
 *   - last 5 git commits touching the parent dir
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, basename, join } from 'node:path';

export function buildIntentContext({ absPath, relPath, signals, registry, repoRoot }) {
  const lines = [];

  // File metadata
  lines.push(`# File under classification`);
  lines.push(`Path: ${relPath || absPath}`);
  let size = 0;
  let head = '';
  try {
    if (existsSync(absPath) && statSync(absPath).isFile()) {
      size = statSync(absPath).size;
      // First 200 lines, capped at 8KB to keep token count down
      const raw = readFileSync(absPath, 'utf8');
      head = raw.split('\n').slice(0, 200).join('\n').slice(0, 8000);
    }
  } catch {
    // binary or read error — leave empty
  }
  lines.push(`Size: ${size} bytes`);
  if (head) {
    lines.push(``);
    lines.push(`First lines:`);
    lines.push('```');
    lines.push(head);
    lines.push('```');
  }

  // Canonical paths registry
  lines.push(``);
  lines.push(`# Canonical paths registry`);
  if (registry?.canonical_paths) {
    for (const p of registry.canonical_paths) {
      lines.push(`- ${p.filename} → ${p.path} (${p.reason || 'no reason'})`);
    }
  }

  // Pending migrations
  if (Array.isArray(registry?.pending_migrations) && registry.pending_migrations.length) {
    lines.push(``);
    lines.push(`# Pending migrations`);
    for (const m of registry.pending_migrations) {
      if (!m.active) continue;
      lines.push(`- ${m.from} → ${m.to}`);
    }
  }

  // Tier 0 signals (their reasons + disagreements)
  if (Array.isArray(signals) && signals.length) {
    lines.push(``);
    lines.push(`# Tier-0 signals`);
    for (const s of signals) {
      const action = s.action || '(advisory)';
      const dest = s.destination || '(none)';
      lines.push(`- ${s.signal_name}: ${action} → ${dest} (conf=${s.confidence ?? '?'}) — ${s.reason}`);
    }
  }

  // Sibling files
  try {
    const parent = dirname(absPath);
    if (existsSync(parent)) {
      const sibs = readdirSync(parent).filter(n => n !== basename(absPath)).slice(0, 30);
      if (sibs.length) {
        lines.push(``);
        lines.push(`# Sibling files in ${dirname(relPath || '')}`);
        for (const s of sibs) lines.push(`- ${s}`);
      }
    }
  } catch {}

  // Recent git commits in parent dir
  if (repoRoot) {
    try {
      const parentRel = dirname(relPath || '');
      if (parentRel && parentRel !== '.') {
        const log = execSync(
          `git log -n 5 --pretty=format:'%h %s' -- ${JSON.stringify(parentRel)} 2>/dev/null || true`,
          { cwd: repoRoot, encoding: 'utf8' }
        ).trim();
        if (log) {
          lines.push(``);
          lines.push(`# Recent commits touching ${parentRel}`);
          for (const l of log.split('\n').slice(0, 5)) lines.push(`- ${l}`);
        }
      }
    } catch {}
  }

  // Active story
  try {
    const storiesDir = join(repoRoot || '', 'user', 'workbenches', 'topics', 'work', 'robot-dojo', 'wk_robot_dojo', 'stories');
    if (existsSync(storiesDir)) {
      const stories = readdirSync(storiesDir).filter(d => /^(st|df|wk)_/.test(d));
      const active = stories
        .map(d => {
          try {
            const meta = JSON.parse(readFileSync(join(storiesDir, d, 'meta.json'), 'utf8'));
            return meta.kanban === 'in-progress' ? meta : null;
          } catch { return null; }
        })
        .filter(Boolean);
      if (active.length) {
        lines.push(``);
        lines.push(`# Active stories: ${active.map(m => m.id || '?').join(', ')}`);
      }
    }
  } catch {}

  return lines.join('\n');
}
