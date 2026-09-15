#!/usr/bin/env node
/**
 * Write the public release manifest served at /version.json.
 *
 * The manifest is intentionally generated in the build path, not only by the
 * deploy wrapper. Direct `vercel build && vercel deploy --prebuilt` must still
 * leave a truthful freshness probe.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATH = resolve(REPO_ROOT, 'apps', 'static', 'version.json');
const SELF_REL = 'apps/static/version.json';

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function git(args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.status === 0 ? result.stdout : '';
}

function splitZ(text) {
  return String(text || '').split('\0').filter(Boolean);
}

function currentSha() {
  return process.env.ROBOTDOJO_RELEASE_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.GITHUB_SHA
    || git(['rev-parse', 'HEAD'], { allowFail: true }).trim()
    || 'unknown';
}

function vercelBuildEnv() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL);
}

function uploadedDirtyManifest(sha, now) {
  if (!vercelBuildEnv() || !existsSync(VERSION_PATH)) return null;
  try {
    const existing = JSON.parse(readFileSync(VERSION_PATH, 'utf8'));
    const sameSha = String(existing?.sha || '') === String(sha || '') || sha === 'unknown';
    const dirty = existing?.dirty === true || existing?.source_state === 'dirty';
    const fingerprint = typeof existing?.source_fingerprint === 'string' && existing.source_fingerprint.length > 0;
    const buildId = typeof existing?.build_id === 'string' && existing.build_id.length > 0;
    const alreadyRemote = existing?.vercel_env || existing?.vercel_url || existing?.vercel_git_commit_sha;
    if (!sameSha || !dirty || !fingerprint || !buildId || alreadyRemote) return null;
    return {
      ...existing,
      built_at: now.toISOString(),
      vercel_env: process.env.VERCEL_ENV || null,
      vercel_url: process.env.VERCEL_URL || null,
      vercel_git_commit_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
      preserved_uploaded_dirty_manifest: true,
    };
  } catch {
    return null;
  }
}

function changedPaths() {
  const tracked = splitZ(git(['diff', '--name-only', '-z', 'HEAD'], { allowFail: true }));
  const untracked = splitZ(git(['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true }));
  return [...new Set([...tracked, ...untracked])]
    .filter((path) => path && path !== SELF_REL)
    .sort();
}

function sourceFingerprint(sha, paths) {
  const hash = createHash('sha256');
  hash.update(`sha:${sha}\n`);
  for (const rel of paths) {
    const abs = resolve(REPO_ROOT, rel);
    hash.update(`path:${rel}\n`);
    if (!existsSync(abs)) {
      hash.update('deleted\n');
      continue;
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      hash.update('directory\n');
      continue;
    }
    const bytes = readFileSync(abs);
    hash.update(`file:${bytes.length}:${sha256(bytes)}\n`);
  }
  return hash.digest('hex');
}

export function buildVersionManifest({ now = new Date() } = {}) {
  const sha = currentSha();
  const uploaded = uploadedDirtyManifest(sha, now);
  if (uploaded) return uploaded;
  const paths = changedPaths();
  const fingerprint = sourceFingerprint(sha, paths);
  const dirty = paths.length > 0;
  return {
    sha,
    deployed_at: now.toISOString(),
    built_at: now.toISOString(),
    source_state: dirty ? 'dirty' : 'clean',
    dirty,
    dirty_file_count: paths.length,
    source_fingerprint: fingerprint,
    build_id: `${String(sha).slice(0, 12)}-${fingerprint.slice(0, 12)}`,
    release_sha: process.env.ROBOTDOJO_RELEASE_SHA || null,
    vercel_env: process.env.VERCEL_ENV || null,
    vercel_url: process.env.VERCEL_URL || null,
    vercel_git_commit_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
  };
}

export function writeVersionJson(options = {}) {
  const manifest = buildVersionManifest(options);
  mkdirSync(dirname(VERSION_PATH), { recursive: true });
  writeFileSync(VERSION_PATH, JSON.stringify(manifest) + '\n', 'utf8');
  return { path: VERSION_PATH, manifest };
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const { path, manifest } = writeVersionJson();
  console.log(`wrote ${path}`);
  console.log(`  sha:                  ${manifest.sha}`);
  console.log(`  source_state:         ${manifest.source_state}`);
  console.log(`  dirty_file_count:     ${manifest.dirty_file_count}`);
  console.log(`  source_fingerprint:   ${manifest.source_fingerprint}`);
  console.log(`  build_id:             ${manifest.build_id}`);
}
