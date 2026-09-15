#!/usr/bin/env node
/**
 * Blocks Vercel deploys from packaging local private substrate.
 *
 * Vercel does not reliably inherit the repo's per-directory .gitignore policy,
 * so every PII-bearing or heavyweight local root must be listed explicitly in
 * .vercelignore.
 */
import { readFileSync } from 'node:fs';

const required = [
  '.backup/',
  '.claude/',
  '.git/',
  '.vercel/',
  'code/',
  'config/private.json',
  'config/health-markers.json',
  'config/taxonomy.json',
  'config/taxonomy.user.json',
  'config/vault-manifest.json',
  'config/family.json',
  'config/initial-slug',
  'config/company-aliases.user.json',
  'config/service-vendor-keywords.user.json',
  'agents/dist/',
  'gateway/node_modules/',
  'node_modules/',
  'pipeline/',
  'user/',
  '*.db',
  '*.db-shm',
  '*.db-wal',
  '.env',
  '.env*.local',
  'identity.json',
  'identity.local.json',
  'taxonomy.user.json',
];

const content = readFileSync('.vercelignore', 'utf8');
const lines = new Set(content
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#')));

const missing = required.filter((pattern) => !lines.has(pattern));
if (missing.length) {
  console.error('BLOCKED: .vercelignore is missing private/deploy-excluded patterns:');
  for (const pattern of missing) console.error(`- ${pattern}`);
  process.exit(1);
}

console.log('[check-vercelignore-private-data] ok');
