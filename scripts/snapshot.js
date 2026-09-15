#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import db from '../lib/db.js';
import {
  createSnapshot,
  listMemoryConflicts,
  listSnapshots,
  promoteSnapshot,
  reconstructSnapshots,
} from '../lib/snapshots.js';

const [command = 'list', ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  const result = run(command, args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    print(command, result);
  }
} catch (err) {
  console.error(err.message);
  usage();
  process.exit(2);
}

function run(commandName, args) {
  if (commandName === 'create') {
    const scope = scopeFromArgs(args);
    const body = args.body || readBody(args);
    return createSnapshot(db, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      title: args.title,
      body,
      snapshotType: args.type || args.snapshotType || 'view',
      inferred: Boolean(args.inferred),
      confidence: args.confidence,
      sourceKind: args.sourceKind || (args.inferred ? 'retroactive_reconstruction' : 'user_countersigned'),
      validAt: args.asOf || args.validAt,
      supersedes: args.supersedes ? String(args.supersedes).split(',').map((s) => s.trim()).filter(Boolean) : [],
      citations: args.citation ? String(args.citation).split(',').map((source) => ({ source: source.trim() })).filter((c) => c.source) : [],
      actor: args.actor || 'agent',
      source: args.source || 'scripts:snapshot',
    });
  }
  if (commandName === 'list') {
    return { snapshots: listSnapshots(db, { ...scopeFromArgs(args, false), limit: args.limit || 20, asOf: args.asOf }) };
  }
  if (commandName === 'infer') {
    return reconstructSnapshots(db, { ...scopeFromArgs(args, false), limit: args.limit || 500, asOf: args.asOf });
  }
  if (commandName === 'promote') {
    const body = args.body || (args.file ? readBody(args) : undefined);
    return promoteSnapshot(db, {
      id: args.id && !String(args.id).startsWith('me_') ? args.id : undefined,
      snapshotId: args.snapshotId,
      eventId: args.eventId || (String(args.id || '').startsWith('me_') ? args.id : undefined),
      title: args.title,
      body,
      snapshotType: args.type || args.snapshotType,
      validAt: args.asOf || args.validAt,
      supersedes: args.supersedes ? String(args.supersedes).split(',').map((s) => s.trim()).filter(Boolean) : [],
      citations: args.citation ? String(args.citation).split(',').map((source) => ({ source: source.trim() })).filter((c) => c.source) : [],
      actor: args.actor || 'agent',
      source: args.source || 'scripts:snapshot',
    });
  }
  if (commandName === 'conflicts') {
    return { conflicts: listMemoryConflicts(db, { ...scopeFromArgs(args, false), limit: args.limit || 20, asOf: args.asOf }) };
  }
  throw new Error(`unknown command: ${commandName}`);
}

function scopeFromArgs(args, required = true) {
  if (args.topic) return { scopeType: 'topic', scopeId: String(args.topic) };
  if (args.workbench) return { scopeType: 'workbench', scopeId: String(args.workbench) };
  const scopeType = args.scopeType || args.scope_type || args.targetType || args.target_type;
  const scopeId = args.scopeId || args.scope_id || args.targetId || args.target_id;
  if (!scopeType && !scopeId && !required) return {};
  if (!scopeType || !scopeId) throw new Error('scope required: pass --topic, --workbench, or --scope-type plus --scope-id');
  return { scopeType: String(scopeType), scopeId: String(scopeId) };
}

function readBody(args) {
  if (args.file) {
    if (!existsSync(args.file)) throw new Error(`snapshot body file not found: ${args.file}`);
    return readFileSync(args.file, 'utf8');
  }
  if (!process.stdin.isTTY) {
    const stdin = readFileSync(0, 'utf8').trim();
    if (stdin) return stdin;
  }
  throw new Error('snapshot body required: pass --body, --file, or pipe stdin');
}

function print(commandName, result) {
  if (commandName === 'create' || commandName === 'promote') {
    const snapshot = result.snapshot;
    console.log(`${result.inserted ? 'Created' : 'Existing'} Snapshot ${snapshot.snapshot_id}`);
    console.log(`- ${snapshot.valid_at} ${snapshot.inferred ? 'inferred' : 'official'} ${snapshot.snapshot_type}: ${snapshot.title}`);
    console.log(`- Scope: ${snapshot.scope.type}/${snapshot.scope.id}`);
    if (snapshot.supersedes?.length) console.log(`- Supersedes: ${snapshot.supersedes.join(', ')}`);
    return;
  }
  if (commandName === 'infer') {
    console.log(`Snapshot inference scanned ${result.scanned}, inserted ${result.inserted}, existing ${result.existing}.`);
    for (const snapshot of result.snapshots || []) {
      console.log(`- ${snapshot.valid_at} ${snapshot.snapshot_id}: ${snapshot.title}`);
    }
    return;
  }
  if (commandName === 'conflicts') {
    for (const conflict of result.conflicts || []) {
      console.log(`- ${conflict.valid_at} ${conflict.status} ${conflict.conflict_type} ${conflict.event_id}: ${conflict.summary}`);
    }
    return;
  }
  for (const snapshot of result.snapshots || []) {
    console.log(`- ${snapshot.valid_at} ${snapshot.inferred ? 'inferred' : 'official'} ${snapshot.snapshot_type} ${snapshot.snapshot_id}: ${snapshot.title}`);
  }
}

function usage() {
  console.error('usage: node scripts/snapshot.js create --topic <slug> --title <title> --body <body> [--as-of <iso>] [--json]');
  console.error('   or: node scripts/snapshot.js list [--topic <slug>|--workbench <id>] [--json]');
  console.error('   or: node scripts/snapshot.js infer [--topic <slug>|--workbench <id>|--json]');
  console.error('   or: node scripts/snapshot.js promote --id <snapshot_id|event_id> [--title <title>] [--body <body>] [--json]');
  console.error('   or: node scripts/snapshot.js conflicts [--topic <slug>|--workbench <id>|--json]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
