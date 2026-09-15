#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { requiredLaunchIntegrations } from '../lib/launch-integrations.js';

const ids = new Set(requiredLaunchIntegrations().map((i) => i.id));
for (const id of ['github', 'backup', 'remote-access']) {
  if (!ids.has(id)) throw new Error(`product-state contract missing ${id}`);
}

const accounts = readFileSync('routes/accounts.js', 'utf8');
for (const text of ["{ id: 'product_state'", 'productStateCards', "section: 'product_state'"]) {
  if (accounts.includes(text)) throw new Error(`product-state section still rendered by Account Integrations: ${text}`);
}

const app = readFileSync('apps/account/app.js', 'utf8');
if (app.includes("section.id === 'product_state'")) {
  throw new Error('product-state section still rendered by Account Integrations frontend');
}
if (!app.includes("'remote-access':  renderGeneral")) {
  throw new Error('remote access should remain available on the Admin/Login surface');
}

process.stdout.write('[check-first-session-product-state] ok\n');
