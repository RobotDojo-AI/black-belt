#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const apply = process.argv.includes('--apply');
const labelIdx = process.argv.indexOf('--label');
const onlyLabel = labelIdx !== -1 ? process.argv[labelIdx + 1] : null;
const root = process.env.ROBOTDOJO_REPO_ROOT || resolve(import.meta.dirname, '..');
const home = process.env.HOME || homedir();
const configDir = process.env.ROBOTDOJO_CONFIG || resolve(home, '.robotdojo');
const launchDir = process.env.ROBOTDOJO_LAUNCH_AGENTS_DIR || resolve(home, 'Library/LaunchAgents');
const quarantineDir = resolve(configDir, 'launch-agents-quarantine');
const permissionApp = process.env.ROBOTDOJO_PERMISSION_APP || resolve(home, 'Applications', 'Robot Dojo.app');
const permissionLauncher = process.env.ROBOTDOJO_PERMISSION_LAUNCHER || resolve(configDir, 'bin', 'Robot Dojo');
const appRuntime = resolve(permissionApp, 'Contents', 'MacOS', 'Robot Dojo');
const runtimeBin = process.env.ROBOTDOJO_RUNTIME_BIN || (existsSync(appRuntime) ? appRuntime : process.execPath);
const manifest = JSON.parse(readFileSync(resolve(root, 'config/launch-agents.json'), 'utf8'));

function expand(text) {
  return text
    .replaceAll('__HOME__', home)
    .replaceAll('__USER__', process.env.USER || 'robotdojo')
    .replaceAll('__CONFIG__', configDir)
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__ROBOTDOJO_RUNTIME__', runtimeBin)
    .replaceAll('__PATH__', process.env.PATH || '')
    .replaceAll('__ROBOTDOJO_APP__', permissionApp)
    .replaceAll('__ROBOTDOJO_LAUNCHER__', permissionLauncher)
    .replaceAll('__ROBOTDOJO_HOME__', root);
}

function run(cmd, args, { allowFailure = false } = {}) {
  if (!apply) {
    console.log(`DRY: ${cmd} ${args.join(' ')}`);
    return;
  }
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0 && !allowFailure) failures.push(`${cmd} ${args.join(' ')} exited ${result.status}`);
}

function settleLaunchdAfterBootout() {
  if (!apply) return;
  spawnSync('/bin/sleep', ['0.5'], { stdio: 'ignore' });
}

if (apply) {
  mkdirSync(launchDir, { recursive: true });
  mkdirSync(quarantineDir, { recursive: true });
}

const uid = process.getuid();
const failures = [];

const labels = new Set();
let repairedCount = 0;
for (const agent of manifest.agents || []) {
  labels.add(agent.label);
  if (onlyLabel && agent.label !== onlyLabel) continue;
  repairedCount += 1;
  const template = resolve(root, agent.template);
  const dest = resolve(launchDir, `${agent.label}.plist`);
  if (!existsSync(template)) throw new Error(`template missing: ${agent.template}`);
  const body = expand(readFileSync(template, 'utf8'));
  if (apply) writeFileSync(dest, body);
  else console.log(`DRY: write ${dest}`);
  run('launchctl', ['bootout', `gui/${uid}/${agent.label}`], { allowFailure: true });
  settleLaunchdAfterBootout();
  run('launchctl', ['bootstrap', `gui/${uid}`, dest]);
}

if (!onlyLabel && existsSync(launchDir)) {
  for (const file of readdirSync(launchDir)) {
    if (!/^com\.robotdojo\..*\.plist$/.test(file)) continue;
    const label = basename(file, '.plist');
    if (labels.has(label)) continue;
    const src = resolve(launchDir, file);
    const dest = resolve(quarantineDir, `${file}.${Date.now()}`);
    if (apply) renameSync(src, dest);
    console.log(`${apply ? 'QUARANTINED' : 'DRY: quarantine'} ${src} -> ${dest}`);
  }
}

if (onlyLabel && repairedCount === 0) {
  failures.push(`unknown launch agent label: ${onlyLabel}`);
}

if (failures.length) {
  console.error('[repair-live-launch-agents] FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(apply ? '[repair-live-launch-agents] applied' : '[repair-live-launch-agents] dry-run only; rerun with --apply after explicit approval');
