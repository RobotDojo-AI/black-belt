#!/usr/bin/env node
/**
 * scripts/check-skill-adapters.js — thin stub (st_0c491456 Phase 3a).
 *
 * This script's logic was absorbed into scripts/check-agent-os.js, which now
 * verifies skill adapters, Claude agent adapters, Codex, Cursor, dist headers,
 * and source→dist freshness in one pass. Kept as a stub so any external caller
 * (docs, muscle memory, third-party scripts) gets the unified gate.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const result = spawnSync(
  process.execPath,
  [join(homedir(), 'robotdojo', 'scripts', 'check-agent-os.js')],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
