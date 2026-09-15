#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const storyIdx = args.indexOf('--story');
const storyId = storyIdx >= 0 ? args[storyIdx + 1] : '';

if (!storyId) {
  console.error('[check-story-preflight-record] FAIL - pass --story <story_id>');
  process.exit(1);
}

const storyDir = join(process.cwd(), 'pipeline', 'stories', storyId);
const preflightPath = join(storyDir, 'preflight.json');
const metaPath = join(storyDir, 'meta.json');

if (!existsSync(preflightPath)) {
  console.error(`[check-story-preflight-record] FAIL - missing ${preflightPath}`);
  process.exit(1);
}

const preflight = JSON.parse(readFileSync(preflightPath, 'utf8'));
const failures = [];

if (preflight.story_id !== storyId) failures.push('story_id mismatch');
if (!preflight.recorded_at) failures.push('recorded_at missing');
if (!preflight.branch) failures.push('branch missing');
if (!preflight.head) failures.push('head missing');
if (!Array.isArray(preflight.dirty_files)) failures.push('dirty_files must be an array');
if (!Array.isArray(preflight.active_build_tail)) failures.push('active_build_tail must be an array');

const dirtyFiles = Array.isArray(preflight.dirty_files) ? preflight.dirty_files.filter(Boolean) : [];
if (dirtyFiles.length > 0 && !preflight.owner_build_authorization) {
  failures.push('dirty preflight requires owner_build_authorization');
}

if (existsSync(metaPath)) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta.story_id !== storyId) failures.push('meta story_id mismatch');
}

if (failures.length) {
  console.error('[check-story-preflight-record] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[check-story-preflight-record] ok - preflight and owner authorization recorded');
