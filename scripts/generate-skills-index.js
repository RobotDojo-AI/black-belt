#!/usr/bin/env node
/**
 * generate-skills-index.js
 * Parses all agents/skills/{name}/SKILL.md files and:
 *   --check       Validate Contract blocks are present in all pipeline skills
 *   --check-mece  Validate no trigger overlap across all skills
 *   --emit        Write agents/skills/SKILLS.md meta-map
 *
 * Supports SKILLS_DIR env var override for testing.
 * Exits non-zero on unknown flags or validation failures.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME;
const SKILLS_DIR = process.env.SKILLS_DIR || join(HOME, 'robotdojo/agents/skills');
const OUTPUT_PATH = join(SKILLS_DIR, 'SKILLS.md');

const TOP_LEVEL_SKILLS = ['goal'];
const PIPELINE_SKILLS = ['story', 'defect', 'framing', 'research', 'scope', 'plan', 'build', 'qa', 'close'];
// Domain skills. coach/health/work are deprecated stubs that redirect to /topic; kept here
// so the generated index documents the deprecation status rather than silently dropping them.
const DOMAIN_SKILLS = ['topic', 'write', 'format', 'kanban', 'asana'];
const DEPRECATED_SKILLS = new Set(['coach', 'health']);

// Parse flags
const args = process.argv.slice(2);
const flags = {};
const unknownFlags = [];

for (const arg of args) {
  if (arg === '--check') flags.check = true;
  else if (arg === '--check-mece') flags.checkMece = true;
  else if (arg === '--emit') flags.emit = true;
  else if (arg.startsWith('--')) unknownFlags.push(arg);
}

if (unknownFlags.length > 0) {
  process.stderr.write(`Error: unknown flag(s): ${unknownFlags.join(', ')}\n`);
  process.exit(1);
}

if (!flags.check && !flags.checkMece && !flags.emit) {
  process.stderr.write('Usage: generate-skills-index.js [--check] [--check-mece] [--emit]\n');
  process.exit(1);
}

/**
 * Parse a single SKILL.md file. Returns:
 * {
 *   name,         // directory name (e.g. "story")
 *   trigger,      // from first "# /trigger" line
 *   contract: {
 *     reads,      // text after **Reads:**
 *     produces,   // text after **Produces:**
 *     guarantees, // text after **Guarantees:**
 *   } | null,
 *   entryGate,    // text from "## Entry gate:" line, or null
 *   raw,          // raw file content
 * }
 */
function parseSkillFile(skillName) {
  const skillPath = join(SKILLS_DIR, skillName, 'SKILL.md');
  if (!existsSync(skillPath)) return null;

  const raw = readFileSync(skillPath, 'utf8');
  const lines = raw.split('\n');

  // Extract trigger from first "# /skillname" line
  let trigger = null;
  for (const line of lines) {
    const m = line.match(/^#\s+(\/\S+)/);
    if (m) {
      trigger = m[1];
      break;
    }
  }

  // Extract Contract block
  let contract = null;
  const contractStart = raw.indexOf('## Contract');
  if (contractStart !== -1) {
    const contractSection = raw.slice(contractStart, contractStart + 2000);
    const readsMatch = contractSection.match(/(?:\*\*)?Reads:(?:\*\*)?\s*([^\n]+)/);
    const producesMatch = contractSection.match(/(?:\*\*)?Produces:(?:\*\*)?\s*([^\n]+)/);
    const stopsMatch = contractSection.match(/(?:\*\*)?Stops with:(?:\*\*)?\s*([^\n]+)/);
    const guaranteesMatch = contractSection.match(/(?:\*\*)?Guarantees:(?:\*\*)?\s*([^\n]+(?:\n(?!##|\*\*)[^\n]*)*)/);
    if (readsMatch && producesMatch && (stopsMatch || guaranteesMatch)) {
      contract = {
        reads: readsMatch[1].trim(),
        produces: producesMatch[1].trim(),
        guarantees: (stopsMatch || guaranteesMatch)[1].trim().replace(/\n/g, ' '),
      };
    }
  }

  // Extract Entry gate
  let entryGate = null;
  const entryMatch = raw.match(/## Entry gate:\s*([^\n]+)/);
  if (entryMatch) {
    entryGate = entryMatch[1].trim();
  }

  return { name: skillName, trigger, contract, entryGate, raw };
}

// Load all skills
const allSkillNames = [];
try {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      allSkillNames.push(entry.name);
    }
  }
} catch (e) {
  process.stderr.write(`Error reading SKILLS_DIR ${SKILLS_DIR}: ${e.message}\n`);
  process.exit(1);
}

const allSkills = {};
for (const name of allSkillNames) {
  const parsed = parseSkillFile(name);
  if (parsed) allSkills[name] = parsed;
}

let exitCode = 0;

// --check: validate Contract blocks in all pipeline skills
if (flags.check) {
  let allOk = true;
  for (const name of PIPELINE_SKILLS) {
    const skill = allSkills[name];
    if (!skill) {
      process.stderr.write(`FAIL: pipeline skill "${name}" — SKILL.md not found in ${SKILLS_DIR}\n`);
      allOk = false;
      continue;
    }
    if (!skill.contract) {
      process.stderr.write(`FAIL: pipeline skill "${name}" — missing ## Contract section with all three subsections (Reads, Produces, Guarantees)\n`);
      allOk = false;
      continue;
    }
    // Verify all three subsections present
    const missing = [];
    if (!skill.contract.reads) missing.push('Reads');
    if (!skill.contract.produces) missing.push('Produces');
    if (!skill.contract.guarantees) missing.push('Guarantees');
    if (missing.length > 0) {
      process.stderr.write(`FAIL: pipeline skill "${name}" — Contract missing subsections: ${missing.join(', ')}\n`);
      allOk = false;
    }
  }
  if (allOk) {
    process.stdout.write('OK — all pipeline skills have complete ## Contract sections (Reads, Produces, Guarantees) — all contracts pass\n');
  } else {
    exitCode = 1;
  }
}

// --check-mece: validate no trigger overlap
if (flags.checkMece) {
  const triggerMap = {}; // trigger → [skillName]
  for (const [name, skill] of Object.entries(allSkills)) {
    if (!skill.trigger) continue;
    if (!triggerMap[skill.trigger]) triggerMap[skill.trigger] = [];
    triggerMap[skill.trigger].push(name);
  }

  let overlapFound = false;
  for (const [trigger, names] of Object.entries(triggerMap)) {
    if (names.length > 1) {
      process.stderr.write(`FAIL: trigger "${trigger}" is shared by multiple skills — overlap found: ${names.join(', ')}\n`);
      overlapFound = true;
    }
  }

  if (!overlapFound) {
    process.stdout.write(`OK — no trigger overlap found across ${Object.keys(allSkills).length} skills — pass: MECE verified\n`);
  } else {
    exitCode = 1;
  }
}

// --emit: generate SKILLS.md
if (flags.emit) {
  const lines = [];

  lines.push('# Skills Map');
  lines.push('');
  lines.push('> Generated by `scripts/generate-skills-index.js --emit`. Never hand-edit — always regenerate.');
  lines.push('');

  // Pipeline flow visualization
  lines.push('## Pipeline flow');
  lines.push('');
  lines.push('```');
  lines.push('goal → story/defect/topic');
  lines.push('story/defect → framing → research → scope → plan → build → qa → close');
  lines.push('topic → topic open/close');
  lines.push('```');
  lines.push('');

  // Top-level goal skill section
  lines.push('## Goal skill');
  lines.push('');

  for (const name of TOP_LEVEL_SKILLS) {
    const skill = allSkills[name];
    if (!skill) {
      lines.push(`### /${name}`);
      lines.push('');
      lines.push('> SKILL.md not found');
      lines.push('');
      continue;
    }

    lines.push(`### ${skill.trigger || `/${name}`}`);
    lines.push('');
    if (skill.contract) {
      lines.push(`**Input:** ${skill.contract.reads}`);
      lines.push('');
      lines.push(`**Output:** ${skill.contract.produces}`);
      lines.push('');
      lines.push(`**Entry gate:** ${skill.entryGate || 'None'}`);
      lines.push('');
      lines.push(`**Contract:** ${skill.contract.guarantees}`);
    } else {
      lines.push('> Missing ## Contract block');
    }
    lines.push('');
  }

  // Pipeline skills section
  lines.push('## Pipeline skills');
  lines.push('');

  for (const name of PIPELINE_SKILLS) {
    const skill = allSkills[name];
    if (!skill) {
      lines.push(`### /${name}`);
      lines.push('');
      lines.push('> SKILL.md not found');
      lines.push('');
      continue;
    }

    lines.push(`### ${skill.trigger || `/${name}`}`);
    lines.push('');
    if (skill.contract) {
      lines.push(`**Input:** ${skill.contract.reads}`);
      lines.push('');
      lines.push(`**Output:** ${skill.contract.produces}`);
      lines.push('');
      lines.push(`**Entry gate:** ${skill.entryGate || 'None'}`);
      lines.push('');
      lines.push(`**Contract:** ${skill.contract.guarantees}`);
    } else {
      lines.push('> Missing ## Contract block');
    }
    lines.push('');
  }

  // Domain skills section
  lines.push('## Domain skills');
  lines.push('');
  lines.push('Non-pipeline skills invocable at any time:');
  lines.push('');

  for (const name of DOMAIN_SKILLS) {
    const skill = allSkills[name];
    if (!skill) {
      lines.push(`- **/${name}** — SKILL.md not found`);
      continue;
    }
    const trigger = skill.trigger || `/${name}`;
    // Try to extract description from front matter
    const descMatch = skill.raw.match(/^description:\s*(.+)$/m);
    const desc = descMatch ? descMatch[1].trim() : '—';
    const prefix = DEPRECATED_SKILLS.has(name) ? ' _(deprecated — use `/topic`)_' : '';
    lines.push(`- **${trigger}**${prefix} — ${desc}`);
  }
  lines.push('');

  const content = lines.join('\n');
  writeFileSync(OUTPUT_PATH, content);
  process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
}

process.exit(exitCode);
