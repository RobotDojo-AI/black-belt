#!/usr/bin/env node
/**
 * memory-synthesize.js — clusters feedback memory entries into behavioral themes
 * and synthesizes new failure-mode rules for agents/agents.md via frontier model.
 *
 * WHY this exists:
 *   Feedback entries accumulate as individual observations. After 3+ entries
 *   cluster around the same behavioral pattern, a general rule emerges that
 *   belongs in Miyagi's failure modes section. This script does that synthesis
 *   automatically, preventing behavioral drift from going uncodified.
 *
 * Flow:
 *   1. Read all feedback entries from user/memory/log/
 *   2. Cluster via frontier model (semantic grouping, JSON output)
 *   3. For themes with ≥3 entries, synthesize a one-sentence rule via frontier model
 *   4. Deduplicate against existing agents/agents.md failure modes
 *   5. Append new rules to ### Failure modes in ## Miyagi (宮城) section
 *   6. Write a project memory log entry recording what was added
 *   7. Print "synthesis complete: N new rules added"
 *
 * Idempotent: second run with same log → 0 new rules → exits 0.
 * No API key: exits 0 with "synthesis skipped: no API key".
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { AGENT_ROSTER_PATH, AGENTS_ROOT, USER_MEMORY_DIR } from '../lib/robotdojo-paths.js';
import { modelFor } from '../lib/model-lane.js';

export const INTELLIGENCE_TIER = 'synthesis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LOG_DIR = join(USER_MEMORY_DIR, 'log');
const AGENTS_MANUAL = AGENT_ROSTER_PATH;

// ── API key ───────────────────────────────────────────────────────────────────

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return execSync(
      'security find-generic-password -s "robotdojo-ANTHROPIC_API_KEY" -w',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
  } catch {
    return null;
  }
}

const API_KEY = getApiKey();
if (!API_KEY) {
  console.log('synthesis skipped: no API key');
  process.exit(0);
}

// ── Anthropic SDK ─────────────────────────────────────────────────────────────

let Anthropic;
try {
  const mod = await import('@anthropic-ai/sdk');
  Anthropic = mod.default;
} catch {
  console.log('synthesis skipped: @anthropic-ai/sdk not available');
  process.exit(0);
}

const client = new Anthropic({ apiKey: API_KEY });
// st_4312c9c0 AC-2 — substrate, held capable at sonnet rather than frontier.
// This writes agents/agents.md, which shapes every Miyagi response, so it is
// deliberately NOT swept to the cheapest tier. The earlier "never downgrade this
// to save cost" comment argued against cheapening it; one tier down from
// frontier is the classified substrate tier, not a sweep.
const MODEL = modelFor('balanced');

// ── Load feedback entries ─────────────────────────────────────────────────────

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const lines = content.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) return null;
  const fm = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = m[2];
  }
  return fm;
}

let feedbackEntries = [];
try {
  const files = readdirSync(LOG_DIR)
    .filter(n => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{12}\.md$/.test(n))
    .sort();

  for (const name of files) {
    const content = readFileSync(join(LOG_DIR, name), 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm || fm.type !== 'feedback') continue;
    feedbackEntries.push({ name, description: fm.description || '', timestamp: fm.timestamp || '' });
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('synthesis complete: 0 new rules added (no memory log)');
    process.exit(0);
  }
  throw err;
}

if (feedbackEntries.length === 0) {
  console.log('synthesis complete: 0 new rules added (no feedback entries)');
  process.exit(0);
}

// ── Cluster via Haiku ─────────────────────────────────────────────────────────

const descriptions = feedbackEntries.map(e => e.description);

// Limit to most recent 40 feedback entries to keep prompt manageable
const recentDescriptions = descriptions.slice(-40);

const clusterPrompt = `Analyze these AI assistant feedback descriptions and group them into 5-8 behavioral themes.

Descriptions:
${recentDescriptions.map((d, i) => `[${i}] ${d}`).join('\n')}

Return ONLY valid JSON array. Each entry's "entries" field must contain the EXACT description strings (not index numbers):
[{"theme":"short name","entries":["exact description text","exact description text"]},...]

Group by semantic meaning. Min 2 entries per theme. No markdown, no explanation.`;

let clusters = [];
try {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: clusterPrompt }],
  });
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  // Extract JSON array from response — handle markdown fences and truncation
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      clusters = JSON.parse(jsonMatch[0]);
    } catch {
      // Try to repair truncated JSON by finding last complete object
      const lastClose = jsonMatch[0].lastIndexOf('}');
      if (lastClose > 0) {
        try {
          clusters = JSON.parse(jsonMatch[0].slice(0, lastClose + 1) + ']');
        } catch {
          // Give up on this run
        }
      }
    }
  }
} catch (err) {
  process.stderr.write(`memory-synthesize: clustering failed: ${err.message}\n`);
  console.log('synthesis complete: 0 new rules added (clustering error)');
  process.exit(0);
}

// Filter to themes with ≥3 entries
const significantClusters = clusters.filter(c => Array.isArray(c.entries) && c.entries.length >= 3);

if (significantClusters.length === 0) {
  console.log('synthesis complete: 0 new rules added (no themes with ≥3 entries)');
  process.exit(0);
}

// ── Read existing failure modes from agents/agents.md ──────────────────────

let agentsContent = '';
try {
  agentsContent = readFileSync(AGENTS_MANUAL, 'utf8');
} catch {
  process.stderr.write(`memory-synthesize: agents.md not found at ${AGENTS_MANUAL}\n`);
  console.log('synthesis complete: 0 new rules added (agents.md missing)');
  process.exit(0);
}

// Extract existing failure modes text for deduplication
function extractMiyagiFailureModes(content) {
  const miyagiIdx = content.indexOf('## Miyagi (宮城)');
  if (miyagiIdx === -1) return '';
  const miyagiSection = content.slice(miyagiIdx);
  const fmIdx = miyagiSection.indexOf('### Failure modes');
  if (fmIdx === -1) return '';
  const fmSection = miyagiSection.slice(fmIdx);
  const nextSection = fmSection.indexOf('\n### ', 1);
  return nextSection !== -1 ? fmSection.slice(0, nextSection) : fmSection;
}

const existingFailureModes = extractMiyagiFailureModes(agentsContent).toLowerCase();

// Simple deduplication: check if key words from the synthesized rule already appear
function isAlreadyCovered(rule, existingText) {
  // Extract significant words (>4 chars, not common words)
  const stopWords = new Set(['this', 'that', 'with', 'from', 'when', 'then', 'does', 'have', 'will', 'been', 'they', 'their', 'what', 'should', 'must', 'never', 'always', 'avoid', 'instead']);
  const words = rule.toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !stopWords.has(w));

  if (words.length === 0) return false;

  // If 60%+ of significant words appear in existing text, consider it covered
  const matches = words.filter(w => existingText.includes(w));
  return matches.length / words.length > 0.6;
}

// ── Synthesize rules for significant clusters ─────────────────────────────────

const newRules = [];

for (const cluster of significantClusters) {
  const synthesizePrompt = `Write a failure mode rule for an AI assistant based on these feedback observations:

${cluster.entries.join('\n')}

Format (return ONLY this, no other text):
**[Short name].** [One sentence: what the failure is and what to do instead.]

Requirements: starts with **, ends with period, one complete sentence, direct tone.`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: synthesizePrompt }],
    });
    const rule = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

    // Validate: must be a complete sentence ending in period, must start with **
    if (!rule.startsWith('**') || !rule.endsWith('.')) {
      process.stderr.write(`memory-synthesize: skipping malformed rule: ${rule.slice(0, 80)}\n`);
      continue;
    }

    // Dedup check
    if (isAlreadyCovered(rule, existingFailureModes)) {
      continue;
    }

    newRules.push({ theme: cluster.theme, rule });
  } catch (err) {
    process.stderr.write(`memory-synthesize: synthesis failed for theme "${cluster.theme}": ${err.message}\n`);
  }
}

if (newRules.length === 0) {
  console.log('synthesis complete: already current (0 new rules)');
  process.exit(0);
}

// ── Write synthesized rules to agents/suggestions/ for human review ──────────
//
// st_6f81e248 AC19: previously this block wrote new failure-mode rules directly
// into agents/agents.md (the Miyagi-section body), which produced persona
// bloat without human review and contaminated the per-agent file's hand-curated
// content. The write target is now agents/suggestions/synthesized-{ts}.md.
// Human review then promotes rules into Miyagi.md via the standard owner-edit
// path. sha256 of every agents/personas/*.md file is unchanged before/after
// this script runs.

const ruleNames = newRules.map((r) => {
  const m = r.rule.match(/^\*\*([^*]+)\*\*/);
  return m ? m[1] : r.theme;
});

const suggestionsDir = join(AGENTS_ROOT, 'suggestions');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const suggestionFile = join(suggestionsDir, `synthesized-${stamp}.md`);

const suggestionBody = [
  `# Synthesized failure-mode suggestions (${new Date().toISOString()})`,
  '',
  `Source: ${feedbackEntries.length} feedback entries · clustered themes: ${significantClusters.map((c) => c.theme).join(', ')}`,
  '',
  '_Review and either (a) promote into `agents/personas/Miyagi.md` via owner edit, (b) relocate into `agents/build-conventions.md` for portable rules, or (c) discard. No automatic write to persona bodies (st_6f81e248 AC19)._',
  '',
  ...newRules.map((r) => `${r.rule}\n`),
].join('\n');

writeFileSync(suggestionFile, suggestionBody, 'utf8');

// ── Write memory log entry ────────────────────────────────────────────────────

try {
  const memoryAppend = join(USER_MEMORY_DIR, 'bin/memory-append.js');
  const description = `memory-synthesize wrote ${newRules.length} rule suggestions to agents/suggestions/ for human review: ${ruleNames.join(', ')}`;
  const body = `Synthesized from ${feedbackEntries.length} feedback entries. Themes processed: ${significantClusters.map(c => c.theme).join(', ')}. Suggestions written to ${suggestionFile} — persona bodies untouched.`;

  execSync(
    `node ${memoryAppend} --type project --name memory-synthesize-run-${Date.now()} --description "${description.replace(/"/g, "'")}" --author miyagi --body "${body.replace(/"/g, "'")}"`,
    { encoding: 'utf8', timeout: 30000 }
  );
} catch (err) {
  process.stderr.write(`memory-synthesize: memory log write failed (non-fatal): ${err.message}\n`);
}

console.log(`synthesis complete: ${newRules.length} rule suggestions written to agents/suggestions/ for review`);
