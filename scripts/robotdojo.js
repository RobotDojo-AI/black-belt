#!/usr/bin/env node
/**
 * robotdojo — start a flat-fee coding agent under Robot Dojo, or send
 * a labeled metered call through llmCreate.
 */

// INTELLIGENCE_TIER: orchestration — launches a host or one metered call.
export const INTELLIGENCE_TIER = 'orchestration';

import { createInterface } from 'node:readline/promises';
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchSpec,
  confirmExtraSpend,
  ensureShim,
  installCli,
  launchAgent,
  readSeat,
  resolveHost,
  shouldWarnSeat,
} from '../lib/agent-wrap.js';
import { LANES, modelFor } from '../lib/model-lane.js';

const HOSTS = new Set(['claude', 'grok', 'codex', 'cursor']);

export function usage(code = 1) {
  process.stderr.write(
    'robotdojo claude|grok|codex|cursor [args...]\n' +
    'robotdojo llm --lane fast|balanced [--allow-best] --label <why> <prompt>\n' +
    'robotdojo --install\n',
  );
  process.exit(code);
}

export function parseLlm(argv) {
  let lane = LANES.FAST;
  let label = '';
  let allowBest = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lane') lane = argv[++i];
    else if (a === '--label') label = argv[++i];
    else if (a === '--allow-best') allowBest = true;
    else if (a === '-h' || a === '--help') usage(0);
    else rest.push(a);
  }
  return { lane, label, allowBest, prompt: rest.join(' ').trim() };
}

export function prepareLlmCall({ lane, label, allowBest }) {
  if (!label) {
    const err = new Error('robotdojo llm: --label is required so the ledger can name the spend');
    err.code = 'LABEL_REQUIRED';
    throw err;
  }
  if (lane === LANES.BEST && !allowBest) {
    const err = new Error('robotdojo llm: lane "best" is reserved. Pass --allow-best for one directed call.');
    err.code = 'BEST_RESERVED';
    throw err;
  }
  if (!Object.values(LANES).includes(lane)) {
    const err = new Error(`robotdojo llm: unknown lane "${lane}"`);
    err.code = 'LANE_UNKNOWN';
    throw err;
  }
  return { model: modelFor(lane), interactive: true, label, lane };
}

export function gateMeteredSpend({ line, seat, warnAtPct = 50 } = {}) {
  const messages = [];
  if (!seat || !seat.readable) {
    messages.push(seat?.reason || 'cannot read remaining seat for this host');
    return { allowLaunch: true, allowMetered: false, messages };
  }
  if (shouldWarnSeat(seat, warnAtPct) && !confirmExtraSpend({ line })) {
    messages.push('extra spend needs a typed yes this turn');
    return { allowLaunch: false, allowMetered: false, messages };
  }
  if (!confirmExtraSpend({ line })) {
    messages.push('extra spend needs a typed yes this turn');
    return { allowLaunch: true, allowMetered: false, messages };
  }
  return { allowLaunch: true, allowMetered: true, messages };
}

async function readConfirmLine() {
  if (process.env.ROBOTDOJO_CONFIRM != null) return process.env.ROBOTDOJO_CONFIRM;
  if (!stdinStream.isTTY) return '';
  const rl = createInterface({ input: stdinStream, output: stdoutStream });
  try {
    return await rl.question('Extra spend? Type yes: ');
  } finally {
    rl.close();
  }
}

export async function runLlm(argv, { seatReader, confirmLine } = {}) {
  const parsed = parseLlm(argv);
  if (!parsed.prompt) {
    usage(1);
    return;
  }
  let prepared;
  try {
    prepared = prepareLlmCall(parsed);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const seat = readSeat('llm', { reader: seatReader });
  const line = confirmLine !== undefined ? confirmLine : await readConfirmLine();
  const gate = gateMeteredSpend({ line, seat });
  for (const m of gate.messages) process.stderr.write(`${m}\n`);
  if (!gate.allowMetered) process.exit(1);

  const { llmCreate } = await import('../lib/llm-gateway.js');
  const resp = await llmCreate({
    model: prepared.model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: parsed.prompt }],
    interactive: prepared.interactive,
  }, prepared.label);
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function runHost(name, argv, opts = {}) {
  if (!resolveHost(name, { pathEnv: opts.pathEnv })) {
    process.stderr.write(`robotdojo: ${name} is not on PATH. Install the flat-fee app, then retry.\n`);
    process.exit(1);
  }
  let spec;
  try {
    spec = buildLaunchSpec(name, argv, opts);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const seat = readSeat(name, { reader: opts.seatReader });
  const gate = gateMeteredSpend({
    line: opts.confirmLine,
    seat,
    warnAtPct: opts.warnAtPct,
  });
  for (const m of gate.messages) process.stderr.write(`${m}\n`);
  if (seat?.readable && shouldWarnSeat(seat, opts.warnAtPct) && !gate.allowLaunch) {
    process.exit(1);
  }
  ensureShim(opts.configDir);
  if (opts.drySpec) return spec;
  const child = launchAgent(name, argv, opts);
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  child.on('error', (err) => {
    process.stderr.write(`robotdojo: failed to launch ${name}: ${err.message}\n`);
    process.exit(1);
  });
  return spec;
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') usage(cmd ? 0 : 1);
  if (cmd === '--install') {
    const dest = installCli({ home: process.env.HOME });
    process.stdout.write(`${dest}\n`);
    return;
  }
  if (cmd === 'llm') {
    return runLlm(rest);
  }
  if (HOSTS.has(cmd)) {
    return runHost(cmd, rest);
  }
  usage(1);
}

const launchedAsCli = process.argv[1] && /(?:^|\/)robotdojo(?:\.js)?$/.test(process.argv[1]);
if (launchedAsCli) {
  Promise.resolve(main()).catch((err) => {
    process.stderr.write(`robotdojo: ${err.message}\n`);
    process.exit(1);
  });
}
