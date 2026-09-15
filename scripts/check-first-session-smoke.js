#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const surfaces = [
  ['routes/setup/onboarding.js', ['/google-scopes', '/local-help', '/llm-key']],
  ['routes/accounts.js', ['integration-cards', 'launch_state', 'applyLaunchContract']],
  ['apps/account/app.js', ['INTEGRATION_STATE_LABELS', 'launch_required', 'recovery']],
  ['apps/chat/modules/inline-recognition.js', ['bindInlineRecognition', 'entity_recognized', 'passive-entity-inline']],
  ['apps/static/install.sh', ['INTEGRATIONS_HANDOFF_URL', 'CHAT_HANDOFF_URL', '/auth/local-start?token=']],
  ['install.sh', ['apps/static/install.sh', 'exec "$SCRIPT_DIR/apps/static/install.sh" "$@"']],
];

for (const [file, needles] of surfaces) {
  const src = readFileSync(file, 'utf8');
  for (const needle of needles) {
    if (!src.includes(needle)) throw new Error(`${file} missing ${needle}`);
  }
}

process.stdout.write('[check-first-session-smoke] ok\n');
