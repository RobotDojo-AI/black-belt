#!/usr/bin/env node
import { fail, read } from './frontend-workbench-lib.js';

const errors = [];
const inventory = JSON.parse(read('config/app-inventory.json'));
const allowed = new Set(inventory.status_contract || []);

const requiredProducts = new Map([
  ['website', 'Website'],
  ['chat', 'Chat'],
  ['health', 'Health'],
  ['network', 'Network'],
  ['account', 'Account'],
]);
const requiredWorkbenches = new Map([
  ['wk_coaching', 'Coaching'],
  ['wk_ecede903', 'Career/Job Search'],
  ['wk_cedar', 'Cedar'],
  ['wk_health', 'Health Workbench'],
  ['wk_robot_dojo', 'Robot Dojo'],
  ['wk_project_maple', 'Project Maple'],
]);

function checkSet(kind, rows, required) {
  const byId = new Map((rows || []).map(row => [row.id, row]));
  for (const [id, name] of required) {
    const row = byId.get(id);
    if (!row) {
      errors.push(`${kind} inventory missing ${id}`);
      continue;
    }
    if (row.name !== name) errors.push(`${kind} ${id} name mismatch: ${row.name}`);
    if (!allowed.has(row.status)) errors.push(`${kind} ${id} invalid status: ${row.status}`);
    if (kind === 'product app' && !row.use_case) errors.push(`${kind} ${id} missing use_case`);
  }
}

checkSet('product app', inventory.product_apps, requiredProducts);
checkSet('workbench app', inventory.workbench_apps, requiredWorkbenches);

const products = new Map((inventory.product_apps || []).map(row => [row.id, row]));
const requiredSubflows = {
  website: ['login', 'faq', 'ask'],
  account: ['how-to', 'general', 'integrations', 'agents', 'skills', 'you', 'shortcuts', 'setup', 'imports'],
};
for (const [id, subflows] of Object.entries(requiredSubflows)) {
  const row = products.get(id);
  const present = new Set(row?.subflows || []);
  for (const subflow of subflows) {
    if (!present.has(subflow)) errors.push(`product app ${id} missing subflow ${subflow}`);
  }
}
if (products.has('ask')) errors.push('ask must be modeled as a website subflow, not a top-level product app');

const serialized = JSON.stringify(inventory);
for (const forbidden of ['user/workbenches/', '/Users/', 'root_path', 'resume_path', 'substrate/external-repo']) {
  if (serialized.includes(forbidden)) errors.push(`inventory embeds private path/data token: ${forbidden}`);
}

fail(errors);
