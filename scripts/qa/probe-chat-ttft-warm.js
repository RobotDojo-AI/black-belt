#!/usr/bin/env node
/**
 * st_24c158ae — warm chat TTFT probe (VC1/VC3).
 *
 * Issues N consecutive authenticated POSTs through the live relay,
 * spaced `spacing` seconds apart. For each turn captures:
 *   - elapsed ms from request submission to first SSE delta frame
 *   - searching_memory.count from the phase event (if emitted)
 *   - whether the breaker was OPEN (no searching_memory phase fires)
 *
 * Asserts every turn meets the warm SLA via assertTTFT(elapsed, 'warm').
 * Optional --require-rag-count-gt-zero K: also asserts ≥K turns have
 * searching_memory.count > 0 (excluding breaker-OPEN turns).
 *
 * Why relay-only: browser/app QA must exercise the same path the user sees.
 *
 * Output: JSON line per turn on stderr (diagnostic) + final summary on
 * stdout. Exit 0 on full pass, 1 with diagnostic on first failure.
 *
 * Usage:
 *   node probe-chat-ttft-warm.js --turns 10 --spacing 30 --max-ms 3000
 *   node probe-chat-ttft-warm.js --turns 10 --spacing 30 --require-rag-count-gt-zero 8
 */

import { execSync } from 'node:child_process';
import { assertTTFT } from '../../config/sla.js';
import { assertRelayQaUrl } from './live-url-guard.js';

const BASE_URL = assertRelayQaUrl(process.env.QA_BASE_URL || 'https://robotdojo.ai', 'QA_BASE_URL');
const RELAY_SLUG = process.env.ROBOTDOJO_QA_RELAY_SLUG || 'dojo';
const CHAT_STREAM_URL = `${BASE_URL}/api/chat/stream`;
const CONVERSATION_ID = `qa-warm-ttft-${process.pid}-${Date.now()}`;

function parseArgs(argv) {
  const args = { turns: 10, spacing: 30, requireRag: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--turns') args.turns = Number(argv[++i]);
    else if (a === '--spacing') args.spacing = Number(argv[++i]);
    else if (a === '--max-ms') args.maxMs = Number(argv[++i]); // documented but assertTTFT enforces the canonical bound
    else if (a === '--require-rag-count-gt-zero') args.requireRag = Number(argv[++i]);
  }
  return args;
}

function readKeychainToken() {
  try {
    return execSync(
      'security find-generic-password -s "robotdojo-ROBOTDOJO_AUTH_TOKEN" -w',
      { encoding: 'utf8' },
    ).trim();
  } catch (err) {
    console.error(`FAIL: could not read ROBOTDOJO_AUTH_TOKEN from Keychain: ${err?.message || err}`);
    process.exit(1);
  }
}

/**
 * Issue one chat turn. Returns:
 *   { elapsed_ms, rag_count, breaker_open, error? }
 *
 * elapsed_ms = ms from POST submission to the first `data: {"type":"delta",...}`
 * SSE frame seen. rag_count = the count emitted in the searching_memory phase
 * event (null if not observed). breaker_open = true when no searching_memory
 * phase event fires before streaming starts.
 */
async function issueTurn(token, turnIndex) {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: `reply ok turn ${turnIndex}` }],
    conversationId: CONVERSATION_ID,
    qaTestChat: true,
  });
  const t0 = Date.now();
  let firstDeltaMs = null;
  let ragCount = null;
  let sawSearchingMemory = false;

  let resp;
  try {
    resp = await fetch(CHAT_STREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Cookie': `rd_server=${encodeURIComponent(RELAY_SLUG)}`,
        'X-RobotDojo-QA-Simulate': '1',
        'X-RobotDojo-Test-Chat': '1',
      },
      body,
    });
  } catch (err) {
    return { elapsed_ms: Date.now() - t0, rag_count: null, breaker_open: false, error: `fetch failed: ${err?.message}` };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    return { elapsed_ms: Date.now() - t0, rag_count: null, breaker_open: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  // Stream the SSE body, looking for first delta + searching_memory phase.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'phase' && evt.name === 'searching_memory') {
        sawSearchingMemory = true;
        if (typeof evt.count === 'number') ragCount = evt.count;
      }
      if (evt.type === 'delta') {
        firstDeltaMs = Date.now() - t0;
        // Got TTFT — cancel the reader so we don't pay for the rest of the stream.
        try { await reader.cancel(); } catch { /* ignore */ }
        break outer;
      }
    }
  }

  return {
    elapsed_ms: firstDeltaMs ?? (Date.now() - t0),
    rag_count: ragCount,
    breaker_open: !sawSearchingMemory,
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const token = readKeychainToken();
  if (!token) {
    console.error('FAIL: empty token');
    process.exit(1);
  }

  const results = [];
  let firstFailIndex = null;
  let firstFailReason = null;

  for (let i = 0; i < args.turns; i++) {
    const r = await issueTurn(token, i);
    results.push(r);
    process.stderr.write(`turn ${i}: ${JSON.stringify(r)}\n`);

    if (r.error) {
      if (firstFailIndex === null) {
        firstFailIndex = i;
        firstFailReason = `turn errored: ${r.error}`;
      }
    } else {
      try {
        assertTTFT(r.elapsed_ms, 'warm');
      } catch (slaErr) {
        if (firstFailIndex === null) {
          firstFailIndex = i;
          firstFailReason = `SLA breach: ${slaErr.message}`;
        }
      }
    }

    if (i < args.turns - 1) {
      await sleep(args.spacing * 1000);
    }
  }

  // Aggregate stats.
  const ragHits = results.filter(r => !r.breaker_open && typeof r.rag_count === 'number' && r.rag_count > 0).length;
  const breakerOpenCount = results.filter(r => r.breaker_open).length;
  const summary = {
    turns: results.length,
    rag_hits: ragHits,
    breaker_open: breakerOpenCount,
    first_fail_index: firstFailIndex,
    first_fail_reason: firstFailReason,
    per_turn: results,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');

  if (firstFailIndex !== null) {
    process.stderr.write(`FAIL at turn ${firstFailIndex}: ${firstFailReason}\n`);
    process.exit(1);
  }

  if (args.requireRag !== null && ragHits < args.requireRag) {
    process.stderr.write(`FAIL: rag_hits=${ragHits} < required=${args.requireRag} (breaker_open=${breakerOpenCount})\n`);
    process.exit(1);
  }

  process.stderr.write(`PASS: ${args.turns} turns under warm SLA, rag_hits=${ragHits}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error(`FATAL: ${err?.stack || err}`);
  process.exit(1);
});
