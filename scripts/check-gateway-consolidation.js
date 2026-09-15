#!/usr/bin/env node
/**
 * Enforces the launch gateway directory model.
 *
 * Robot Dojo has one live gateway. The deployable source lives at `gateway/`;
 * the old top-level `gateway-src/` name and pre-TCP legacy gateway files must
 * not return to current source.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INTELLIGENCE_TIER = 'extraction';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function gitLsFiles(args = []) {
  const result = spawnSync('git', ['ls-files', '-z', ...args], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.toString('utf8') || 'git ls-files failed');
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
}

function fileText(path) {
  try {
    const text = readFileSync(join(repoRoot, path), 'utf8');
    if (text.includes('\0')) return null;
    return text;
  } catch {
    return null;
  }
}

function main() {
  const errors = [];
  const tracked = gitLsFiles();
  const trackedSet = new Set(tracked);

  if (!existsSync(join(repoRoot, 'gateway'))) errors.push('gateway/ is missing');
  if (existsSync(join(repoRoot, 'code/gateway'))) errors.push('retired duplicate gateway folder exists: code/gateway');
  if (existsSync(join(repoRoot, 'gateway-src'))) errors.push('top-level gateway-src/ exists');

  for (const path of [
    'gateway/Dockerfile',
    'gateway/README.md',
    'gateway/index.js',
    'gateway/package.json',
    'gateway/package-lock.json',
    'gateway/infra/versions.tf',
    'gateway/infra/ecs.tf',
    'gateway/infra/terraform.tfvars.example',
    'gateway/scripts/deploy.sh',
    'gateway/lib/auth.js',
    'gateway/lib/sni.js',
    'gateway/lib/sni-router.js',
    'gateway/lib/tcp-registry.js',
    'gateway/routes/cert-provision.js',
    'gateway/routes/device-registration.js',
    'gateway/routes/tcp-tunnel.js',
    'gateway/routes/tunnel.js',
  ]) {
    if (!existsSync(join(repoRoot, path))) errors.push(`required canonical gateway file missing: ${path}`);
  }

  for (const path of tracked.filter((p) => p === 'gateway-src' || p.startsWith('gateway-src/'))) {
    errors.push(`tracked stale gateway-src path: ${path}`);
  }

  for (const path of [
    'gateway/session-api.js',
    'gateway/sni-router.js',
    'gateway/sni.js',
    'gateway/tunnel-registry.js',
  ]) {
    if (existsSync(join(repoRoot, path)) || trackedSet.has(path)) errors.push(`legacy gateway file remains: ${path}`);
  }

  const lock = readJson('config/root-allowlist.lock.json');
  if (!lock.entries?.gateway) errors.push('root lock is missing gateway entry');
  if (lock.entries?.['gateway-src']) errors.push('root lock still allows gateway-src');
  if (!lock.retired?.includes('gateway-src')) errors.push('root lock does not record gateway-src as retired');
  if (lock.entries?.gateway?.purpose?.toLowerCase().includes('legacy')) errors.push('root lock still describes gateway as legacy');
  for (const ext of ['.tf', '.hcl', '.sh', '.example']) {
    if (!lock.entries?.gateway?.extensions?.includes(ext)) errors.push(`root lock gateway extensions missing ${ext}`);
  }
  if ((lock.gitignore?.per_dir_node_modules_ok || []).includes('gateway-src')) {
    errors.push('root lock per_dir_node_modules_ok still allows gateway-src');
  }

  const knip = readJson('knip.json');
  if (!knip.ignore?.includes('gateway/**')) errors.push('knip.json does not ignore canonical gateway package');
  if (knip.ignore?.includes('gateway-src/**')) errors.push('knip.json still ignores gateway-src');

  const vercelignore = fileText('.vercelignore') || '';
  if (!vercelignore.split('\n').includes('gateway/node_modules/')) errors.push('.vercelignore missing gateway/node_modules/');
  if (vercelignore.includes('gateway-src/')) errors.push('.vercelignore still mentions gateway-src');

  const skipPrefixes = ['user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/', 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/.stage-snapshots/'];
  const skipExact = new Set([
    'config/root-allowlist.lock.json',
    'scripts/check-gateway-consolidation.js',
  ]);
  for (const path of tracked) {
    if (skipExact.has(path)) continue;
    if (skipPrefixes.some((prefix) => path.startsWith(prefix))) continue;
    const text = fileText(path);
    if (!text) continue;
    if (text.includes('gateway-src')) errors.push(`stale gateway-src reference in ${path}`);
    if (text.includes('Legacy Reference Only')) errors.push(`legacy gateway label remains in ${path}`);
  }

  if (errors.length) {
    console.error('BLOCKED: gateway consolidation is incomplete:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log('[check-gateway-consolidation] ok');
}

main();
