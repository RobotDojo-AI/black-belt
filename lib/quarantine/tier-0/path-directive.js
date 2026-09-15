/**
 * tier-0/path-directive.js — parse explicit path directives from file headers.
 *
 * WHY: any author can drop `// @path: <canonical>` (or `# @path:`, `<!-- @path: -->`)
 * at the top of a file to declare its canonical home. This is the cheapest
 * possible signal — zero inference, zero LLM. If the file declares its own
 * destination, trust the declaration.
 *
 * Supported forms (within first 20 lines):
 *   // @path: config/foo.json
 *   # @path: ~/.robotdojo/foo.yaml
 *   <!-- @path: docs/foo.md -->
 *   /* @path: lib/foo.js *\/
 */

import { readFileSync, existsSync, statSync } from 'node:fs';

const RE = /@path:\s*([^\s*-][^\s]*?)(?=\s|$|-->|\*\/)/;

export function detectPathDirective(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    if (!statSync(absPath).isFile()) return null;
  } catch {
    return null;
  }

  let head;
  try {
    head = readFileSync(absPath, 'utf8').split('\n').slice(0, 20).join('\n');
  } catch {
    // binary or permission error — skip
    return null;
  }

  const m = head.match(RE);
  if (!m) return null;

  const declared = m[1].replace(/^~\//, '');
  return {
    signal_name: 'path-directive',
    destination: declared,
    confidence: 0.95,
    reason: `file declares @path: ${declared}`,
    action: 'move-to-canonical',
  };
}
