// lib/memory-recall-eval.js - deterministic probes for contextual memory.
//
// This is not an LLM judge. It verifies that the memory read model carries the
// factual substrate a model would need for latest, chronological, historical,
// entity-scoped, and app-scoped recall.

import { buildMemoryContextPacket } from './memory-context.js';
import { PIPELINE_STORIES_DIR, REPO_ROOT } from './robotdojo-paths.js';

function toRegex(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (pattern && typeof pattern === 'object' && pattern.pattern) {
    return new RegExp(pattern.pattern, pattern.flags || '');
  }
  return null;
}

function patternLabel(pattern) {
  if (pattern instanceof RegExp) return pattern.toString();
  if (pattern && typeof pattern === 'object' && pattern.pattern) return `/${pattern.pattern}/${pattern.flags || ''}`;
  return JSON.stringify(String(pattern));
}

function patternIndex(text, pattern) {
  const regex = toRegex(pattern);
  if (regex) {
    const match = String(text || '').match(regex);
    return match?.index ?? -1;
  }
  return String(text || '').indexOf(String(pattern));
}

function matches(text, pattern) {
  return patternIndex(text, pattern) >= 0;
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function checkProbe(packet, probe) {
  const failures = [];
  for (const pattern of asList(probe.requires || probe.require)) {
    if (!matches(packet, pattern)) failures.push(`missing ${patternLabel(pattern)}`);
  }
  for (const pattern of asList(probe.forbids || probe.forbid)) {
    if (matches(packet, pattern)) failures.push(`forbidden ${patternLabel(pattern)}`);
  }
  for (const sequence of asList(probe.ordered)) {
    const patterns = asList(sequence);
    const labels = patterns.map(patternLabel);
    const indexes = patterns.map((pattern) => patternIndex(packet, pattern));
    const missing = indexes.findIndex((idx) => idx < 0);
    if (missing >= 0) {
      failures.push(`ordered pattern missing ${labels[missing]}`);
      continue;
    }
    for (let i = 1; i < indexes.length; i++) {
      if (indexes[i] <= indexes[i - 1]) {
        failures.push(`order failed: ${labels.join(' before ')}`);
        break;
      }
    }
  }
  const maxChars = Number(probe.maxChars || probe.max_chars || 0);
  if (maxChars > 0 && packet.length > maxChars) {
    failures.push(`budget exceeded: ${packet.length} > ${maxChars}`);
  }
  return failures;
}

export async function runMemoryRecallEval({
  db,
  probes = [],
  repoRoot = REPO_ROOT,
  storiesDir = PIPELINE_STORIES_DIR,
  buildPacket = null,
} = {}) {
  const results = [];
  const makePacket = buildPacket || ((probe) => buildMemoryContextPacket({
    db,
    query: probe.query || '',
    topic: probe.topic || null,
    entities: probe.entities || [],
    tier: probe.tier || '',
    maxChars: probe.maxChars || probe.max_chars || null,
    asOf: probe.asOf || probe.as_of || '',
    literal: probe.literal ?? null,
    includeSynthesis: Boolean(probe.includeSynthesis || probe.include_synthesis),
    repoRoot,
    storiesDir,
  }));

  for (const probe of probes) {
    const packet = await makePacket(probe);
    const failures = checkProbe(packet, probe);
    results.push({
      name: probe.name || probe.query || 'unnamed probe',
      ok: failures.length === 0,
      failures,
      chars: packet.length,
      packet,
    });
  }

  return {
    ok: results.every((result) => result.ok),
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

export function assertMemoryRecallEval(result) {
  if (result?.ok) return result;
  const failures = (result?.results || [])
    .filter((probe) => !probe.ok)
    .flatMap((probe) => probe.failures.map((failure) => `${probe.name}: ${failure}`));
  throw new Error(`memory recall eval failed\n${failures.join('\n')}`);
}
