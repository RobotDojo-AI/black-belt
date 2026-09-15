#!/usr/bin/env node
/**
 * check-middleware-matcher.js — CI gate that verifies every URL pattern written
 * by replaceState/pushState in apps/ is covered by a config.matcher entry in
 * middleware.js.
 *
 * WHY this exists: Vercel middleware only intercepts paths listed in
 * config.matcher. A replaceState that writes a path not in the matcher causes
 * Vercel to bypass middleware entirely — the user gets the marketing homepage
 * instead of their app on refresh. This gate catches the gap pre-commit.
 *
 * Exit 0 — all URL patterns covered.
 * Exit 1 — one or more gaps found (prints each with "GAP:" prefix).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';

const REPO_ROOT = join(homedir(), 'robotdojo');
const MIDDLEWARE_PATH = join(REPO_ROOT, 'middleware.js');
const APPS_DIR = join(REPO_ROOT, 'apps');

// --- Parse config.matcher from middleware.js ---
const middlewareSource = readFileSync(MIDDLEWARE_PATH, 'utf8');
const matcherMatch = middlewareSource.match(/config\s*=\s*\{[\s\S]*?matcher\s*:\s*\[([\s\S]*?)\]/);
if (!matcherMatch) {
  process.stderr.write('check-middleware-matcher: could not parse config.matcher\n');
  process.exit(1);
}
const matcherEntries = [...matcherMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

// Convert a matcher entry to a regex:
// :path* → .* (zero or more path segments)
// :param → [^/]+ (single segment)
function matcherToRegex(entry) {
  // Step 1: replace named params with placeholders before escaping
  const stepped = entry
    .replace(/:([a-zA-Z][a-zA-Z0-9_]*)\*/g, '\x00STAR\x00')  // :path* → placeholder
    .replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g,   '\x00PARAM\x00'); // :param → placeholder
  // Step 2: escape remaining regex special chars
  const escaped = stepped.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Step 3: restore placeholders as regex patterns
  const pattern = escaped
    .replace(/\x00STAR\x00/g,  '.*')
    .replace(/\x00PARAM\x00/g, '[^/]+');
  return new RegExp('^' + pattern + '(/.*)?$');
}

const matcherRegexes = matcherEntries.map(e => ({ entry: e, re: matcherToRegex(e) }));

function isCovered(urlPattern) {
  return matcherRegexes.some(({ re }) => re.test(urlPattern));
}

// --- Scan apps/**/*.js for replaceState/pushState URL patterns ---
function collectJsFiles(dir) {
  const results = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...collectJsFiles(full));
    else if (extname(name) === '.js') results.push(full);
  }
  return results;
}

const jsFiles = collectJsFiles(APPS_DIR);

// Extract the leading path segment from a URL string found in source.
// Handles: chatBasePath(), template literals, string literals.
function extractPathPrefix(raw) {
  // chatBasePath() calls → /chat
  if (raw.includes('chatBasePath()')) return '/chat';
  // Template literal: `/network/people/${id}` → /network
  // String concat: '/accounts/' + tab → /accounts
  // Simple: '/accounts' → /accounts
  const m = raw.match(/['"`](\/[a-zA-Z][a-zA-Z0-9_-]*)/);
  if (m) {
    // Return just the leading segment (up to second slash)
    const parts = m[1].split('/').filter(Boolean);
    return '/' + parts[0];
  }
  return null;
}

const urlPatterns = new Set();

for (const file of jsFiles) {
  const src = readFileSync(file, 'utf8');
  // Match replaceState/pushState second argument (the URL)
  const calls = [...src.matchAll(/history\.(replaceState|pushState)\s*\([^,]+,\s*[^,]+,\s*([^)]+)\)/g)];
  for (const call of calls) {
    const urlArg = call[2].trim();
    const prefix = extractPathPrefix(urlArg);
    if (prefix) urlPatterns.add(prefix);
  }
}

// --- Check coverage ---
const gaps = [];
for (const pattern of urlPatterns) {
  if (!isCovered(pattern)) gaps.push(pattern);
}

if (gaps.length > 0) {
  for (const gap of gaps) {
    process.stdout.write(`GAP: ${gap} not covered by config.matcher\n`);
  }
  process.exit(1);
}

process.stdout.write(`ok — ${urlPatterns.size} URL pattern${urlPatterns.size === 1 ? '' : 's'}, 0 gaps\n`);
process.exit(0);
