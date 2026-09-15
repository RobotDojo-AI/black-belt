#!/usr/bin/env node
// scripts/work-open-payload-root.js — df_974525f2: deterministic reader for a
// /work session's open-payload.json. Prints the resolved workbench root
// (payload.root) — or, with --topic, the primary topic attachment's target_id,
// or with --id, payload.workbench_id —
// to stdout, and exits 1 with a one-line stderr reason on anything unreadable,
// so the /work close template hard-stops instead of appending to the repo root.
//
// WHY the tolerant parse (slice from the first '{'): legacy payloads were
// captured before lib/db.js routed its init banners to stderr, so a line like
// `[db] workbenches registered: wk_robot_dojo` can precede the JSON. Those
// historical files must still resolve; slicing to the first '{' recovers them.
//
// No db.js import, no LLM — pure fs + JSON. Usage:
//   node scripts/work-open-payload-root.js [--topic|--id] <path/to/open-payload.json>

import { readFileSync } from 'node:fs';

function fail(reason) {
  process.stderr.write(`work-open-payload-root: ${reason}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const topicMode = argv.includes('--topic');
const idMode = argv.includes('--id');
const payloadPath = argv.find((a) => a !== '--topic' && a !== '--id');

if (topicMode && idMode) fail('choose only one of --topic or --id');
if (!payloadPath) fail('usage: work-open-payload-root.js [--topic|--id] <open-payload.json>');

let raw;
try {
  raw = readFileSync(payloadPath, 'utf8');
} catch (err) {
  fail(`cannot read ${payloadPath}: ${err.message}`);
}

if (!raw.trim()) fail(`empty payload file: ${payloadPath}`);

// Tolerant parse: ignore any pre-JSON noise (legacy stdout banners).
const start = raw.indexOf('{');
if (start === -1) fail(`no JSON object found in ${payloadPath}`);

let parsed;
try {
  parsed = JSON.parse(raw.slice(start));
} catch (err) {
  fail(`unparseable JSON in ${payloadPath}: ${err.message}`);
}

if (parsed.ok !== true) fail(`payload ok!==true in ${payloadPath} — the open failed`);

const root = parsed.payload?.root;
if (typeof root !== 'string' || root.length === 0) fail(`missing payload.root in ${payloadPath}`);

if (topicMode) {
  const attachments = parsed.payload.attachments || [];
  const topic = attachments.find((a) => a.role === 'primary' && a.target_type === 'topic')
    || attachments.find((a) => a.target_type === 'topic');
  // No topic attachment (entity workbench) is not an error: print nothing,
  // exit 0 — the caller's empty-string check skips the topic-context upsert.
  process.stdout.write(topic ? topic.target_id : '');
} else if (idMode) {
  const id = parsed.payload?.workbench_id;
  if (typeof id !== 'string' || id.length === 0) fail(`missing payload.workbench_id in ${payloadPath}`);
  process.stdout.write(id);
} else {
  process.stdout.write(root);
}
