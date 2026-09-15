/**
 * phase-12-report.js — Final rebuild summary report
 *
 * Called as the last phase by scripts/rebuild/index.js.
 * Accepts the aggregated results from all prior phases and writes a
 * human-readable markdown report to ~/robotdojo/user/databases/.
 *
 * Contract: returns { reportPath } so the orchestrator can log it.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * @param {object} opts
 * @param {Function} opts.log - log function from orchestrator
 * @param {object} opts.before - counts before hard-delete (from phase-01)
 * @param {object} opts.snap - snapshot row counts (from phase-00)
 * @param {object} opts.restored - rows restored from curated tables (from phase-06)
 * @param {object} opts.tierInfo - entity tier distribution (from phase-08)
 * @param {object} opts.classDist - classification distribution (from phase-09)
 * @param {object} opts.placeCounts - place classification counts (from phase-10)
 * @param {object} opts.addrResult - address timeline result (from phase-11)
 * @param {number} opts.t0 - start timestamp ms
 * @returns {{ reportPath: string }}
 */
export function writeReport({ log, before, snap, restored, tierInfo, classDist, placeCounts, addrResult, t0 }) {
  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  const timestamp = new Date().toISOString();

  const lines = [
    '# Tantei Rebuild Report',
    '',
    `Date: ${timestamp}`,
    `Elapsed: ${elapsed} min`,
    '',
    '## Before (pre-delete snapshot)',
    '',
    snap ? Object.entries(snap).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- (no snapshot data)',
    '',
    '## Deleted',
    '',
    before ? Object.entries(before).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- (no delete data)',
    '',
    '## Restored (curated data)',
    '',
    restored ? Object.entries(restored).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- (no restore data)',
    '',
    '## Entity Tier Distribution',
    '',
    tierInfo ? Object.entries(tierInfo).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- (no tier data)',
    '',
    '## Classification Distribution',
    '',
    classDist ? Object.entries(classDist).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- (no class data)',
    '',
    '## Place Counts',
    '',
    placeCounts ? Object.entries(placeCounts).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- (no place data)',
    '',
    '## Address Timeline',
    '',
    addrResult ? `- addresses built: ${addrResult.count ?? JSON.stringify(addrResult)}` : '- (no address data)',
    '',
  ];

  const outDir = join(homedir(), 'robotdojo', 'databases');
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `rebuild-report-${Date.now()}.md`);
  writeFileSync(reportPath, lines.join('\n'));

  if (log) log(`[report] written: ${reportPath}`);
  return { reportPath };
}
