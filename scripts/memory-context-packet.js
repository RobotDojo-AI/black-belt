#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMemoryContextPacket, MEMORY_CONTEXT_DEFAULT_CHAR_BUDGET } from '../lib/memory-context.js';
import { PIPELINE_STORIES_DIR, REPO_ROOT } from '../lib/robotdojo-paths.js';

const args = parseArgs(process.argv.slice(2));
const topic = args.topic || topicFromStory(args.story, args.storyDir) || null;
const query = args.query || args._.join(' ') || 'latest decisions next steps chronology evolution memory workbench build';
const budgetArg = args.maxChars || args.max || args.budget || null;
const maxChars = budgetArg ? positiveInt(budgetArg, MEMORY_CONTEXT_DEFAULT_CHAR_BUDGET) : null;
const entities = entityArgs(args);

const { default: db } = await import('../lib/db.js');
const packet = await buildMemoryContextPacket({
  db,
  query,
  topic,
  entities,
  tier: args.tier || '',
  repoRoot: args.repoRoot || REPO_ROOT,
  storiesDir: args.storiesDir || PIPELINE_STORIES_DIR,
  maxChars,
  asOf: args.asOf || '',
  literal: args.literal === true ? true : null,
  includeSynthesis: Boolean(args.includeSynthesis),
});

if (args.json) {
  console.log(JSON.stringify({
    ok: true,
    topic,
    entities,
    tier: args.tier || '',
    asOf: args.asOf || '',
    literal: args.includeSynthesis ? false : args.literal === true ? true : undefined,
    includeSynthesis: Boolean(args.includeSynthesis),
    chars: packet.length,
    packet,
  }, null, 2));
} else {
  process.stdout.write(packet);
  if (packet) process.stdout.write('\n');
}

function entityArgs(args) {
  const values = []
    .concat(args.entity || [])
    .concat(args.person ? `person:${args.person}` : [])
    .concat(args.company ? `company:${args.company}` : [])
    .concat(args.place ? `place:${args.place}` : []);
  return values
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => {
      const raw = value.trim();
      if (!raw) return null;
      const [type, ...rest] = raw.split(':');
      if (!rest.length) return { type: 'entity', id: type };
      return { type, id: rest.join(':') };
    })
    .filter(Boolean);
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function topicFromStory(storyId, storyDir) {
  const metaPath = storyDir
    ? join(storyDir, 'meta.json')
    : storyId
      ? join(PIPELINE_STORIES_DIR, storyId, 'meta.json')
      : '';
  if (!metaPath || !existsSync(metaPath)) return '';
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.topic_slug) return String(meta.topic_slug);
    if (meta.topic) return String(meta.topic);
    if (meta.domain === 'robotdojo') return 'robot-dojo';
    return meta.domain ? String(meta.domain) : '';
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    const rawKey = eq >= 0 ? raw.slice(0, eq) : raw;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq >= 0) {
      out[key] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
