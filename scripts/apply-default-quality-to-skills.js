#!/usr/bin/env node
/**
 * apply-default-quality-to-skills.js — st_43221114 AC 15.
 *
 * Injects or refreshes the default-quality marker comment + `### Default quality`
 * anchor block in each repo skill. Idempotent: re-runs detect existing blocks
 * and only rewrite when the canonical contract hash changed.
 *
 * Marker goes right after the `<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->` line.
 * `### Default quality` anchor goes at the END of `## Contract` (before the
 * `---` separator if present, otherwise before the next `##` header).
 *
 * Run: node ~/robotdojo/scripts/apply-default-quality-to-skills.js
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AGENT_DEFAULT_QUALITY_PATH, AGENT_SKILLS_DIR } from '../lib/robotdojo-paths.js';

const SKILL_DIR = process.env.SKILLS_DIR || AGENT_SKILLS_DIR;
const SKILLS = readdirSync(SKILL_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILL_DIR, entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .sort();

// Read canonical contract verbatim from default-quality.md.
const CANONICAL_PATH = AGENT_DEFAULT_QUALITY_PATH;
const canonical = readFileSync(CANONICAL_PATH, 'utf8');
const HASH = createHash('sha256').update(canonical).digest('hex');

// Extract the prose between the CONTRACT markers — same prose every consumer pastes.
function extractContractProse(text) {
  const start = text.indexOf('<!-- CONTRACT:start -->');
  const end = text.indexOf('<!-- CONTRACT:end -->');
  if (start === -1 || end === -1) throw new Error('CONTRACT markers missing in canonical default-quality.md');
  // Include the markers + everything between.
  return text.slice(start, end + '<!-- CONTRACT:end -->'.length);
}
const CONTRACT_PROSE = extractContractProse(canonical);

const MARKER = `<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=${HASH} -->`;

const DEFAULT_QUALITY_BLOCK = `\n### Default quality\n\n${CONTRACT_PROSE}\n`;

let changed = 0;
for (const skill of SKILLS) {
  const path = join(SKILL_DIR, skill, 'SKILL.md');
  if (!existsSync(path)) {
    console.error(`MISSING — ${path}`);
    process.exit(1);
  }
  let body = readFileSync(path, 'utf8');
  const before = body;

  // (a) Marker comment right after the HUMAN-AUTHORED line.
  if (!body.includes('<!-- default-quality:')) {
    body = body.replace(
      /<!-- HUMAN-AUTHORED\. REGEN BLOCKED\. -->/,
      (m) => `${m}\n${MARKER}`,
    );
  } else {
    // Update existing marker if hash drifted.
    body = body.replace(
      /<!-- default-quality:.*?-->/,
      MARKER,
    );
  }

  // (b) `### Default quality` anchor block. Refresh stale embedded contract if present.
  if (body.includes('<!-- CONTRACT:start -->') && body.includes('<!-- CONTRACT:end -->')) {
    body = body.replace(
      /<!-- CONTRACT:start -->[\s\S]*?<!-- CONTRACT:end -->/,
      CONTRACT_PROSE,
    );
  } else if (!body.includes('### Default quality')) {
    // Insert before the FIRST `---` separator AFTER the `## Contract` header,
    // or before the next `## ` if no separator. This keeps the contract block
    // anchored within the Contract section visually.
    const contractIdx = body.indexOf('## Contract');
    if (contractIdx === -1) {
      // Fallback: insert after the marker line.
      body = body.replace(MARKER, `${MARKER}\n${DEFAULT_QUALITY_BLOCK}`);
    } else {
      const after = body.slice(contractIdx);
      const sepIdx = after.search(/\n---\n/);
      const nextHeaderIdx = after.slice(1).search(/\n## /); // skip past `## Contract` itself
      let insertOffset;
      if (sepIdx !== -1 && (nextHeaderIdx === -1 || sepIdx < nextHeaderIdx)) {
        insertOffset = contractIdx + sepIdx; // insert before the \n--- separator
      } else if (nextHeaderIdx !== -1) {
        insertOffset = contractIdx + 1 + nextHeaderIdx; // insert before next ## header
      } else {
        insertOffset = body.length; // append to end
      }
      body = body.slice(0, insertOffset) + DEFAULT_QUALITY_BLOCK + body.slice(insertOffset);
    }
  }

  if (body !== before) {
    writeFileSync(path, body);
    console.log(`updated: ${path}`);
    changed++;
  } else {
    console.log(`skipped (no change): ${path}`);
  }
}
console.log(`\n${changed} of ${SKILLS.length} SKILL.md files updated.`);
