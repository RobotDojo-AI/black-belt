#!/usr/bin/env node
// scripts/robotdojo-next-label.js — st_8745309c follow-on (auto-assign label).
//
// Prints the session label a new `claude` launch should take. Behavior:
//   - No single-letter session live  → 'A'  (fresh start resets the sequence)
//   - Some live (e.g. B, C)          → one past the HIGHEST taken → 'D'
//
// Monotonic while building: we never reuse a freed letter mid-run (taking 'A'
// back while B and C are open is confusing), and the sequence resets to A only
// when no lettered session remains (everything closed — e.g. a fresh morning).
// Non-letter labels (the session-id-suffix fallback) are ignored. Caps at Z.
// Always exits 0; falls back to 'A' on any error — the wrapper must not break.

import { activeSessions } from '../lib/session-registry.js';

const codes = [];
try {
  for (const s of activeSessions()) {
    const l = String(s && s.label ? s.label : '').toUpperCase();
    if (/^[A-Z]$/.test(l)) codes.push(l.charCodeAt(0));
  }
} catch { /* registry unreadable — fall through to 'A' */ }

if (codes.length === 0) {
  process.stdout.write('A'); // nothing live → reset the sequence
} else {
  const next = Math.max(...codes) + 1;
  process.stdout.write(next <= 90 ? String.fromCharCode(next) : 'Z'); // cap at Z
}
