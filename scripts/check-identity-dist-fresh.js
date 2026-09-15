#!/usr/bin/env node
/**
 * scripts/check-identity-dist-fresh.js — thin stub (st_0c491456 Phase 3a).
 *
 * This script's logic was absorbed into scripts/check-agent-os.js, which calls
 * `generate-identity.js --check` as one of its checks. Kept as a stub so any
 * external caller (docs, story criteria, third-party scripts) reaches the
 * unified gate.
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
