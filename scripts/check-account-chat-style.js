#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const index = readFileSync('apps/account/index.html', 'utf8');
const app = readFileSync('apps/account/app.js', 'utf8');
const css = readFileSync('apps/account/style.css', 'utf8');

for (const text of [
  '/static/shared/theme.css',
  '/static/shared/shell.css',
  'initShell(',
  'acct-card',
  'integ-table',
  'remote-access-card',
  'dojo-token-card',
]) {
  const haystack = index + '\n' + app + '\n' + css;
  if (!haystack.includes(text)) throw new Error(`account/chat style contract missing ${text}`);
}

process.stdout.write('[check-account-chat-style] ok\n');
