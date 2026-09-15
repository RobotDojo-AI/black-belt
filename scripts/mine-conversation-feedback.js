#!/usr/bin/env node
/**
 * mine-conversation-feedback.js — conversation → memory feedback → standing corrections.
 *
 * Owner rule: when he says "fuck" / "fucking", that is failure telemetry.
 * This miner scans local agent conversation stores, extracts high-signal
 * corrections, appends missing feedback memory entries, rebuilds standing
 * corrections, and optionally regenerates identity adapters.
 *
 * Sources (best-effort, skip if missing):
 *   - ~/.grok/sessions/.../prompt_history.jsonl (and home-level prompt_history)
 *   - ~/.grok/sessions/.../chat_history.jsonl user turns
 *   - Existing user/memory/log feedback (already law — not re-mined as new)
 *
 * Usage:
 *   node scripts/mine-conversation-feedback.js           # mine + write memory + rebuild standing
 *   node scripts/mine-conversation-feedback.js --dry-run # print candidates only
 *   node scripts/mine-conversation-feedback.js --no-identity  # skip generate-identity
 *
 * INTELLIGENCE_TIER: extraction (deterministic heuristics — no LLM).
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendMemory } from '../lib/memory.js';
import { listFeedbackEntries, rebuildStandingCorrectionsFile } from '../lib/standing-corrections.js';
import { REPO_ROOT } from '../lib/robotdojo-paths.js';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const DRY = process.argv.includes('--dry-run');
const NO_IDENTITY = process.argv.includes('--no-identity');
const JSON_OUT = process.argv.includes('--json');

// High-severity: explicit failure telemetry.
const FUCK_RE = /\bfuck(?:ing)?\b/i;
// Medium: repeated-teaching / persona-break signals.
const FRUST_RE = /\b(so tired|same feedback|doesn'?t learn|get better over time|stop trying|why were you|i will not|do you understand|do you undertstand|i am so confused|doesn'?t reflect)\b/i;

/**
 * Map a raw owner line to a stable kebab feedback name + description.
 * Deterministic — same line → same name.
 */
export function crystallizeFeedback(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  if (FUCK_RE.test(t) && /friend|10\/10|machine/i.test(t)) {
    return {
      name: 'no-friend-test-until-ten-of-ten',
      description:
        'Never push friend/external/second-machine testing until the owner declares the product 10/10. Friend machines are not a debug path.',
      severity: 'critical',
      tags: ['persona', 'product', 'fuck-telemetry'],
    };
  }
  if (FUCK_RE.test(t)) {
    return {
      name: 'fuck-is-failure-telemetry',
      description:
        'Owner language fuck/fucking is failure telemetry: stop the current approach, name the break, fix the root cause. Not color, not venting to ignore.',
      severity: 'critical',
      tags: ['persona', 'telemetry', 'fuck-telemetry'],
    };
  }
  if (/miyagi profile|persona|doesn'?t learn|same feedback|get better over time/i.test(t)) {
    return {
      name: 'persona-must-load-and-learn',
      description:
        'Every session must load Miyagi (or named specialist) + standing corrections + voice base. Feedback must compound into standing corrections so the same correction is never re-taught.',
      severity: 'critical',
      tags: ['persona', 'identity', 'learning'],
    };
  }
  if (/print inline|inline here|show me .{0,80}inline/i.test(t)) {
    return {
      name: 'print-the-artifact-inline',
      description:
        'When the owner asks to see a voice file, draft, or decision, print the content in the reply. A path is not the artifact.',
      severity: 'high',
      tags: ['persona', 'format'],
    };
  }
  if (/how i write to (you|miyagi)|not really representative|quick and dirty/i.test(t)) {
    return {
      name: 'operator-chat-is-not-owner-voice',
      description:
        'How the owner types to Miyagi is not how they write to the world. Owner voice compounds from writing samples and sent mail. Chat logs and working-together feedback train Miyagi.',
      severity: 'high',
      tags: ['persona', 'voice', 'sources'],
    };
  }
  if (/stop trying|i will not/i.test(t)) {
    return {
      name: 'owner-hard-stop-obey',
      description:
        'When the owner issues a hard stop ("stop trying X", "I will not Y"), drop that path immediately and do not re-raise it.',
      severity: 'high',
      tags: ['persona', 'obedience'],
    };
  }
  if (FRUST_RE.test(t)) {
    // Generic frustration — store as session note style feedback with hash name
    const slug = t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'frustration-signal';
    return {
      name: `frustration-${slug}`.slice(0, 64).replace(/-+$/g, ''),
      description: t.slice(0, 280),
      severity: 'medium',
      tags: ['persona', 'frustration'],
    };
  }
  return null;
}

function* walkFiles(root, pred, depth = 0) {
  if (depth > 6 || !existsSync(root)) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      yield* walkFiles(p, pred, depth + 1);
    } else if (ent.isFile() && pred(ent.name, p)) {
      yield p;
    }
  }
}

function collectGrokPrompts() {
  const roots = [
    join(HOME, '.grok', 'sessions'),
  ];
  const prompts = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of walkFiles(root, (name) => name === 'prompt_history.jsonl' || name === 'chat_history.jsonl')) {
      let raw;
      try { raw = readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.is_bash) continue;
          // prompt_history shape
          if (typeof o.prompt === 'string' && o.prompt.trim()) {
            prompts.push({ text: o.prompt.trim(), source: file, ts: o.timestamp || null });
            continue;
          }
          // chat_history user turns
          if (o.type === 'user' && Array.isArray(o.content)) {
            for (const c of o.content) {
              if (c?.type === 'text' && typeof c.text === 'string') {
                const m = c.text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
                const text = (m ? m[1] : c.text).trim();
                if (text) prompts.push({ text, source: file, ts: null });
              }
            }
          }
        } catch { /* skip bad lines */ }
      }
    }
  }
  return prompts;
}

async function main() {
  const existing = new Set(listFeedbackEntries({ limit: 500 }).map((e) => e.name));
  const prompts = collectGrokPrompts();
  const candidates = [];
  const seen = new Set();

  for (const p of prompts) {
    const c = crystallizeFeedback(p.text);
    if (!c) continue;
    if (existing.has(c.name) || seen.has(c.name)) continue;
    // Skip low-value generic frustration slugs that are too long/noisy
    if (c.name.startsWith('frustration-') && c.severity === 'medium') {
      // Keep only if fuck-adjacent or persona-related already handled above
      if (!FUCK_RE.test(p.text) && !/persona|learn|feedback|10\/10|friend/i.test(p.text)) continue;
    }
    seen.add(c.name);
    candidates.push({ ...c, sample: p.text.slice(0, 200), source: p.source });
  }

  // Always ensure the two load-bearing rules from owner doctrine exist
  const doctrine = [
    crystallizeFeedback('when i say fuck, it is telemetry something has gone wrong'),
    crystallizeFeedback('stop trying to get me to install on a friend\'s machine. whole fucking this is 10/10'),
    crystallizeFeedback('persona must load and learn and get better over time same feedback'),
  ].filter(Boolean);
  for (const d of doctrine) {
    if (!existing.has(d.name) && !seen.has(d.name)) {
      seen.add(d.name);
      candidates.push({ ...d, sample: d.description, source: 'doctrine' });
    }
  }

  const written = [];
  if (!DRY) {
    for (const c of candidates) {
      try {
        const r = await appendMemory({
          type: 'feedback',
          name: c.name,
          description: c.description,
          author: 'mine-conversation-feedback',
          body: [
            `Severity: ${c.severity}`,
            `Source: ${c.source}`,
            '',
            'Sample owner language:',
            `> ${c.sample}`,
            '',
            'Rule:',
            c.description,
          ].join('\n'),
          tags: c.tags || ['mined'],
        });
        written.push({ name: c.name, path: r.path });
        existing.add(c.name);
      } catch (err) {
        // Duplicate name / chain issues — surface and continue
        if (!JSON_OUT) console.warn(`skip ${c.name}: ${err.message}`);
      }
    }
  }

  const standing = DRY
    ? { count: listFeedbackEntries().length, changed: false, sha256: '' }
    : rebuildStandingCorrectionsFile();

  let identity = null;
  if (!DRY && !NO_IDENTITY) {
    const gen = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'generate-identity.js')], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    identity = {
      status: gen.status,
      out: (gen.stdout || '').trim(),
      err: (gen.stderr || '').trim(),
    };
  }

  const report = {
    dry_run: DRY,
    prompts_scanned: prompts.length,
    candidates: candidates.map((c) => ({ name: c.name, severity: c.severity, description: c.description })),
    written,
    standing,
    identity,
  };

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`mine-conversation-feedback: scanned ${prompts.length} prompts`);
    console.log(`  candidates: ${candidates.length}${DRY ? ' (dry-run)' : ''}`);
    for (const c of candidates) {
      console.log(`  - [${c.severity}] ${c.name}: ${c.description.slice(0, 100)}`);
    }
    if (!DRY) {
      console.log(`  memory written: ${written.length}`);
      console.log(`  standing-corrections: ${standing.count} rules${standing.changed ? ' updated' : ''}`);
      if (identity) console.log(`  identity: ${identity.out || identity.err || `exit ${identity.status}`}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('mine-conversation-feedback failed:', err.message);
    process.exit(1);
  });
}
