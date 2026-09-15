#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runGit(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function readText(relPath) {
  const path = join(REPO_ROOT, relPath);
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  return text.includes('\0') ? '' : text;
}

function isIgnored(relPath) {
  const result = runGit(['check-ignore', relPath]);
  return result.status === 0;
}

function trackedUnder(prefix) {
  const result = runGit(['ls-files', '-z', prefix]);
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean);
}

function main() {
  const errors = [];

  if (!existsSync(join(REPO_ROOT, 'gateway'))) errors.push('canonical gateway/ is missing');
  if (existsSync(join(REPO_ROOT, 'code/gateway'))) {
    errors.push('retired duplicate gateway folder still exists: code/gateway');
  }
  if (trackedUnder('code/gateway').length > 0) {
    errors.push('retired code/gateway has tracked files');
  }

  for (const rel of [
    'gateway/index.js',
    'gateway/Dockerfile',
    'gateway/package.json',
    'gateway/infra/versions.tf',
    'gateway/infra/ecs.tf',
    'gateway/infra/terraform.tfvars.example',
    'gateway/scripts/deploy.sh',
  ]) {
    if (!existsSync(join(REPO_ROOT, rel))) errors.push(`required canonical gateway deploy file missing: ${rel}`);
  }

  const deploy = readText('gateway/scripts/deploy.sh');
  if (/code\/gateway/.test(deploy)) {
    errors.push('gateway deploy script still references retired code/gateway');
  }
  if (!/scripts\/smoke-relay\.sh/.test(deploy)) {
    errors.push('gateway deploy script must preserve public relay smoke hook');
  }

  for (const rel of [
    'gateway/infra/terraform.tfvars',
    'gateway/infra/tfplan',
    'gateway/infra/.terraform/terraform.tfstate',
  ]) {
    if (existsSync(join(REPO_ROOT, rel)) && !isIgnored(rel)) {
      errors.push(`${rel} exists but is not ignored`);
    }
    if (trackedUnder(rel).length > 0) {
      errors.push(`${rel} must not be tracked`);
    }
  }

  if (errors.length) {
    console.error(`[check-gateway-deploy-mirror] FAIL — ${errors.length} violation(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log('[check-gateway-deploy-mirror] ok — gateway/ is sole deploy source and code/gateway is retired');
}

main();
