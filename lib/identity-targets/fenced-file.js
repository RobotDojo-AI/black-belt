// lib/identity-targets/fenced-file.js — shared auto-sync helper.
//
// Writes a managed block to a file, preserving anything outside the fence.
// If the file doesn't exist, it's created. If the fence already exists,
// its contents are replaced. If not, the fence is appended to the file.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const BEGIN = '<!-- BEGIN robotdojo-identity -->';
const END = '<!-- END robotdojo-identity -->';

const BEGIN_RE = /<!--\s*BEGIN\s+robotdojo-identity\s*-->/;
const END_RE = /<!--\s*END\s+robotdojo-identity\s*-->/;

/**
 * Write body into a fenced block inside filePath, preserving any user
 * content outside the fence.
 *
 * @returns {Promise<{ path, action: 'created'|'replaced'|'inserted', bytes }>}
 */
export async function writeFencedBlock(filePath, body) {
  await mkdir(dirname(filePath), { recursive: true });
  let existing = '';
  let existed = false;
  try {
    existing = await readFile(filePath, 'utf8');
    existed = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const fenced = `${BEGIN}\n<!-- Managed by Robot Dojo. Edit via the Robot Dojo chat, not here. -->\n\n${body.trim()}\n\n${END}`;

  let output;
  let action;
  if (!existed) {
    output = fenced + '\n';
    action = 'created';
  } else if (BEGIN_RE.test(existing) && END_RE.test(existing)) {
    const startIdx = existing.search(BEGIN_RE);
    const endMatch = existing.match(END_RE);
    const endIdx = existing.indexOf(endMatch[0], startIdx) + endMatch[0].length;
    output = existing.slice(0, startIdx) + fenced + existing.slice(endIdx);
    action = 'replaced';
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    output = existing + sep + fenced + '\n';
    action = 'inserted';
  }

  await writeFile(filePath, output);
  const s = await stat(filePath);
  return { path: filePath, action, bytes: s.size };
}

export { BEGIN, END };
