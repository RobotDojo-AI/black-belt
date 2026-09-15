#!/usr/bin/env node
// Delegates to the format skill. Run directly: node agents/skills/format/write.js --help
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runner = path.resolve(__dirname, '../agents/skills/format/write.js');
execFileSync(process.execPath, [runner, ...process.argv.slice(2)], { stdio: 'inherit' });
