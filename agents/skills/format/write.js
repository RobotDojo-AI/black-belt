#!/usr/bin/env node
/**
 * Format skill CLI runner.
 * Renders a content file's SEGS array into a Google Doc.
 *
 * Usage:
 *   node agents/skills/format/write.js --doc <id> --account <email> --content <path>
 */
import path from 'path';
import fs from 'fs';
import { render } from './renderer.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node agents/skills/format/write.js --doc <id> --account <email> --content <path>

Flags:
  --doc      Google Doc ID (required)
  --account  Google account email (required)
  --content  Path to content file exporting SEGS array (required)
  --help     Show this help`);
  process.exit(0);
}

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const docId       = getArg('--doc');
const account     = getArg('--account');
const contentFile = getArg('--content');

if (!docId)       { console.error('Error: --doc is required'); process.exit(1); }
if (!account)     { console.error('Error: --account is required'); process.exit(1); }
if (!contentFile) { console.error('Error: --content is required'); process.exit(1); }

const LOG_DIR = path.join(process.env.HOME, 'robotdojo', 'user', 'logs', 'format');
fs.mkdirSync(LOG_DIR, { recursive: true });

function writeLog(data) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(LOG_DIR, `${ts}.json`);
  fs.writeFileSync(logPath, JSON.stringify(data, null, 2));
}

let mod;
try {
  mod = await import(path.resolve(contentFile));
} catch (e) {
  console.error(`Error: could not load content file: ${contentFile}\n${e.message}`);
  process.exit(1);
}

const { SEGS } = mod;
if (!Array.isArray(SEGS)) {
  console.error(`Error: content file must export a SEGS array`);
  process.exit(1);
}

let exitStatus = 0;
try {
  const result = await render(docId, account, SEGS);
  console.log(`Done — ${result.charCount} chars, ${result.requestCount} requests`);
  console.log('https://docs.google.com/document/d/' + docId + '/edit');
} catch (e) {
  exitStatus = 1;
  writeLog({ timestamp: new Date().toISOString(), docId, account, contentFile, segmentCount: SEGS.length, exitStatus });
  throw e;
}

writeLog({ timestamp: new Date().toISOString(), docId, account, contentFile, segmentCount: SEGS.length, exitStatus });
