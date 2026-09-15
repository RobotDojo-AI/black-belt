#!/usr/bin/env node
// scripts/check-fragment-ontology.js — agent-voice ontology gate.
//
// Originally guarded the retired agent-comms + formatting fragment dirs
// (st_0c491456 Phase 2d).
// Under st_73169c14 the agent voice was unified into config/agent-voice/.
// The writing tree is now voice + structure + formatting. This gate guards
// that directory. Two responsibilities:
//
//   (A) config/agent-voice/ ships ONLY PII-free Miyagi writing files:
//       - voice.md           — the shared agent register
//       - structure/*.md     — reply blocking
//       - formatting/*.md    — surface format deltas (coding-agent, web, codex)
//       Owner writing MUST NOT live under config/agent-voice/ — it is calibrated
//       from the owner's real content (PII) and belongs in wk_user/user-voice/
//       (gitignored). The gate fails if any of it appears here.
//
//   (B) Structural contract:
//       - config/agent-voice/voice.md must exist with a purpose header
//         (top-level `# {title}` on the first non-blank line).
//       - config/agent-voice/formatting/coding-agent.md must exist.
//       Include-currency (the personas' `<!-- include: … sha256=… -->` markers)
//       is enforced separately by check-persona-ontology.js, which hashes each
//       referenced file — so this gate does not re-check fragment wrappers or a
//       per-file sha256 marker. Those plain includes carry no wrapper.
//
// Exit: 0 clean, 1 with named violations.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  ? resolve(process.env.ROBOTDOJO_REPO_ROOT)
  : resolve(__dirname, '..');
const AGENT_VOICE_DIR = join(REPO_ROOT, 'config', 'agent-voice');
const FORMATTING_DIR = join(AGENT_VOICE_DIR, 'formatting');
const STRUCTURE_DIR = join(AGENT_VOICE_DIR, 'structure');

// config/agent-voice/ ships only PII-free agent files. Owner voice calibration
// AND the writing-style registers (calibrated from the owner's real content —
// speeches, emails, etc., i.e. PII) live in wk_user/user-voice/ (gitignored),
// never in shipped config.
const FORBIDDEN_OWNER_VOICE = ['base.md.bak', 'owner.md', 'samples', 'writing-templates', 'registers', 'check.md'];

function firstNonBlankLine(content) {
  for (const line of content.split('\n')) {
    if (line.trim() !== '') return line.trim();
  }
  return '';
}

function violatesShape(absPath) {
  const out = [];
  const content = readFileSync(absPath, 'utf8');
  const first = firstNonBlankLine(content);
  if (!/^#\s+\S/.test(first)) {
    out.push(`${absPath}: missing purpose header (first non-blank line must be '# {title}')`);
  }
  return out;
}

function classifyOwnerVoice() {
  // Owner-voice calibration must not surface in shipped config. The check.md
  // tendencies list and the writing registers are owner-calibrated PII.
  const out = [];
  for (const forbidden of FORBIDDEN_OWNER_VOICE) {
    const candidate = join(AGENT_VOICE_DIR, forbidden);
    if (existsSync(candidate)) {
      out.push(`config/agent-voice/${forbidden}: owner voice must live in wk_user/user-voice/, not config/agent-voice/`);
    }
  }
  return out;
}

function listMdFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// --files support: if --files is present, only check agent-voice files that
// appear in the staged file list. The forbidden-owner-voice check always
// runs (an accidental PII surface is a structural error regardless of which
// session staged it). If no staged file maps to any agent-voice path,
// exit clean.
function resolveFilesFilter() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--files');
  if (idx === -1) return null; // no filter — check all
  const files = args.slice(idx + 1).filter(a => !a.startsWith('--'));
  if (files.length === 0) return new Set();
  return new Set(files.map(f => resolve(f)));
}

function main() {
  const filesFilter = resolveFilesFilter();
  const violations = [];

  // Always run the owner-voice PII check — it is a structural invariant
  // that does not depend on which files were staged by this session.
  violations.push(...classifyOwnerVoice());

  // --files with empty list: only the PII check above applies.
  if (filesFilter !== null && filesFilter.size === 0) {
    if (violations.length === 0) {
      process.stdout.write(`[check-fragment-ontology] ok — no agent-voice files staged\n`);
      process.exit(0);
    }
    process.stderr.write(`[check-fragment-ontology] FAIL — ${violations.length} violation(s):\n`);
    for (const v of violations) process.stderr.write(`  ${v}\n`);
    process.exit(1);
  }

  // (A) voice.md — check if not filtered out.
  const voice = join(AGENT_VOICE_DIR, 'voice.md');
  const checkVoice = filesFilter === null || filesFilter.has(resolve(voice));
  if (checkVoice) {
    if (!existsSync(voice)) {
      violations.push('config/agent-voice/voice.md: required Miyagi voice missing');
    } else {
      violations.push(...violatesShape(voice));
    }
  }

  const formattingFiles = listMdFiles(FORMATTING_DIR);
  const structureFiles = listMdFiles(STRUCTURE_DIR);
  const stagedLayerFiles = filesFilter === null
    ? [...formattingFiles, ...structureFiles]
    : [...formattingFiles, ...structureFiles].filter(f => filesFilter.has(resolve(f)));

  if (filesFilter === null) {
    if (!existsSync(FORMATTING_DIR) || !statSync(FORMATTING_DIR).isDirectory()) {
      violations.push('config/agent-voice/formatting/: required formatting directory missing');
    } else if (!existsSync(join(FORMATTING_DIR, 'coding-agent.md'))) {
      violations.push('config/agent-voice/formatting/coding-agent.md: required coding-agent formatting missing');
    }
    if (!existsSync(STRUCTURE_DIR) || !statSync(STRUCTURE_DIR).isDirectory()) {
      violations.push('config/agent-voice/structure/: required structure directory missing');
    }
  }

  for (const f of stagedLayerFiles) {
    violations.push(...violatesShape(f));
  }

  // --files mode: if neither voice.md nor any layer file was staged, and PII is
  // clean, exit clean.
  if (filesFilter !== null && !checkVoice && stagedLayerFiles.length === 0) {
    if (violations.length === 0) {
      process.stdout.write(`[check-fragment-ontology] ok — no agent-voice files staged\n`);
      process.exit(0);
    }
  }

  if (violations.length === 0) {
    process.stdout.write(`[check-fragment-ontology] ok\n`);
    process.exit(0);
  }
  process.stderr.write(`[check-fragment-ontology] FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}

main();
