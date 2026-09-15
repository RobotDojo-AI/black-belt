#!/usr/bin/env node
// scripts/check-arch-doc-schema.js — architecture doc section schema gate
// (st_0c491456 Phase 2c).
//
// Validates the three top-level architecture docs have the required `##`
// sections. Section text is checked as a prefix match (`## Foo` matches `## Foo bar`).
//
//   architecture/product.md:
//     ## Promise, ## Who it's for, ## Tiers, ## What you can do, ## Launch scope
//
//   architecture/architecture.md:
//     ## System shape, ## Data flow, ## Agent OS, ## Tier enforcement
//
//   architecture/structure.md:
//     ## Top-level directories, ## Doc-class homes, ## Enforcing gates
//
// Exit: 0 clean, 1 with named missing sections.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ARCH_DIR = join(REPO_ROOT, 'architecture');

const SCHEMAS = {
  'product.md': ['Promise', "Who it's for", 'Tiers', 'What you can do', 'Launch scope'],
  'architecture.md': ['System shape', 'Data flow', 'Agent OS', 'Tier enforcement'],
  'structure.md': ['Top-level directories', 'Doc-class homes', 'Enforcing gates'],
};

function findH2(content, name) {
  // Match `## <name>` at start of line, case-insensitive, allowing exact name
  // or `## <name> ...` (so `## Tiers` matches and `## Tier enforcement` also
  // matches an "Tier enforcement" line).
  const escaped = name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escaped}\\b`, 'im');
  return re.test(content);
}

function check() {
  const violations = [];
  for (const [file, sections] of Object.entries(SCHEMAS)) {
    const abs = join(ARCH_DIR, file);
    if (!existsSync(abs)) {
      violations.push(`${file}: missing file`);
      continue;
    }
    const content = readFileSync(abs, 'utf8');
    for (const section of sections) {
      if (!findH2(content, section)) {
        violations.push(`${file}: missing '## ${section}' section`);
      }
    }
  }
  return violations;
}

function main() {
  const violations = check();
  if (violations.length === 0) {
    process.stdout.write(`[check-arch-doc-schema] ok\n`);
    process.exit(0);
  }
  process.stderr.write(`[check-arch-doc-schema] FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}

main();
