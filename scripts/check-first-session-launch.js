#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const installer = readFileSync('apps/static/install.sh', 'utf8');
const account = readFileSync('apps/account/app.js', 'utf8');
// st_fd14cdd4 follow-up (2026-06-13): the @-mention person-search autocomplete
// (mentions.js → /api/entities/search) was removed. Inline entity recognition —
// the server's `entity_recognized` SSE frame painted as inline highlights — is
// the surviving entity surface, and now lives in inline-recognition.js.
const inlineRecognition = readFileSync('apps/chat/modules/inline-recognition.js', 'utf8');

const requiredInstaller = [
  '/auth/local-start?token=',
  'INTEGRATIONS_HANDOFF_URL',
  'CHAT_HANDOFF_URL',
  'context=setup-guide',
];
for (const text of requiredInstaller) {
  if (!installer.includes(text)) throw new Error(`installer missing: ${text}`);
}
if (/localhost:\$\{SITE_PORT\}\/setup"/.test(installer)) {
  throw new Error('installer still opens /setup');
}

for (const text of ['needs key', 'needs sign-in', 'needs permission', 'required']) {
  if (!account.includes(text)) throw new Error(`account integration UI missing: ${text}`);
}

for (const text of ['entity_recognized', 'passive-entity-inline', 'robotdojo:entity-recognized']) {
  if (!inlineRecognition.includes(text)) throw new Error(`chat entity awareness missing: ${text}`);
}

process.stdout.write('[check-first-session-launch] ok\n');
