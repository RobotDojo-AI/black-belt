#!/usr/bin/env node
/**
 * Entity QC Report — quality-control audit of the entity graph.
 *
 * Measures entity health across six dimensions:
 *   1. Coverage       — people with identifiers vs bare name-only records
 *   2. Source quality — distribution of primary_source across the graph
 *   3. Confidence     — score histogram (0–0.5, 0.5–0.85, 0.85–1.0)
 *   4. Company links  — people with vs without company_id
 *   5. Orphan risk    — people with source_count = 0 (never seen in data)
 *   6. Dedup risk     — potential duplicates (same display_name, different ids)
 *
 * Usage: ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/entity-qc-report.js
 *        ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/entity-qc-report.js --json
 */
import db from '../lib/db.js';

const jsonMode = process.argv.includes('--json');
const assertNoLeakage = process.argv.includes('--assert-no-leakage');

// ─── Zero-leakage invariant (st_2cd1af73 Phase 3) ───────────────────────────
// Resolution's hard guarantee: a normalized email or phone identifier belongs
// to at most ONE active person. If the same identifier resolves to two active
// people, two distinct humans have been split or a merge failed to collapse a
// shared-identifier component — the exact failure resolution is built to make
// impossible. This is the cheapest possible check that the strongest subsystem
// is not regressed: one indexed GROUP BY over person_identifiers joined to
// active people, returning any (type, value) owned by >1 active person_id.
//
// WHY DISTINCT person_id (not COUNT(*)): a person legitimately carries the same
// identifier twice only if duplicate rows exist for one person — that is not
// leakage. Leakage is the identifier spanning DIFFERENT people. Counting
// distinct owners isolates exactly that.
//
// WHY archived = 0: an archived merge-loser keeps its identifiers for history;
// the live identity graph is the active set. A winner+archived-loser sharing an
// identifier is correct (that is what a merge produces), not leakage.
//
// WHY optional `database` param: production passes nothing → closes over the
// module `db` (the live encrypted connection). Tests inject an in-memory fixture
// so the invariant is exercised against a seeded leak/clean graph without the
// live DB. Dependency injection, mirroring resolveCandidate in 02-resolve.js.
export function findIdentifierLeakage(limit = 50, database = db) {
  return database.prepare(`
    SELECT pi.type, pi.value, COUNT(DISTINCT pi.person_id) AS owners,
           GROUP_CONCAT(DISTINCT pi.person_id) AS person_ids
    FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id
    WHERE pi.type IN ('email', 'phone') AND COALESCE(p.archived, 0) = 0
    GROUP BY pi.type, pi.value
    HAVING COUNT(DISTINCT pi.person_id) > 1
    ORDER BY owners DESC
    LIMIT ?
  `).all(limit);
}

// ─── Queries ───────────────────────────────────────────────────────────────

function q(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : 0;
}

// ─── Sections ──────────────────────────────────────────────────────────────

function sectionCoverage() {
  const total = scalar('SELECT COUNT(*) FROM people WHERE archived = 0');
  const withEmail = scalar(`
    SELECT COUNT(DISTINCT pi.person_id) FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id
    WHERE pi.type = 'email' AND p.archived = 0
  `);
  const withPhone = scalar(`
    SELECT COUNT(DISTINCT pi.person_id) FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id
    WHERE pi.type = 'phone' AND p.archived = 0
  `);
  const withEither = scalar(`
    SELECT COUNT(DISTINCT pi.person_id) FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id
    WHERE pi.type IN ('email','phone') AND p.archived = 0
  `);
  const nameOnly = total - withEither;
  const emailPct = total > 0 ? ((withEmail / total) * 100).toFixed(1) : '0.0';
  const phonePct = total > 0 ? ((withPhone / total) * 100).toFixed(1) : '0.0';
  const coveragePct = total > 0 ? ((withEither / total) * 100).toFixed(1) : '0.0';

  return {
    total,
    withEmail,
    withPhone,
    withEither,
    nameOnly,
    emailPct,
    phonePct,
    coveragePct,
  };
}

function sectionSourceDist() {
  const rows = q(`
    SELECT COALESCE(primary_source, 'unknown') as source, COUNT(*) as n
    FROM people WHERE archived = 0
    GROUP BY primary_source ORDER BY n DESC
  `);
  const total = rows.reduce((s, r) => s + r.n, 0);
  return rows.map(r => ({
    source: r.source,
    count: r.n,
    pct: total > 0 ? ((r.n / total) * 100).toFixed(1) : '0.0',
  }));
}

function sectionConfidenceBuckets() {
  const total = scalar('SELECT COUNT(*) FROM people WHERE archived = 0');
  const low = scalar('SELECT COUNT(*) FROM people WHERE archived = 0 AND confidence < 0.5');
  const mid = scalar('SELECT COUNT(*) FROM people WHERE archived = 0 AND confidence >= 0.5 AND confidence < 0.85');
  const high = scalar('SELECT COUNT(*) FROM people WHERE archived = 0 AND confidence >= 0.85');
  const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
  return {
    low: { count: low, label: '< 0.50 (low)', pct: pct(low) },
    mid: { count: mid, label: '0.50–0.85 (mid)', pct: pct(mid) },
    high: { count: high, label: '≥ 0.85 (high)', pct: pct(high) },
  };
}

function sectionCompanyLinks() {
  const total = scalar('SELECT COUNT(*) FROM people WHERE archived = 0');
  const linked = scalar('SELECT COUNT(*) FROM people WHERE archived = 0 AND company_id IS NOT NULL');
  const unlinked = total - linked;
  const pct = total > 0 ? ((linked / total) * 100).toFixed(1) : '0.0';
  const companyCount = scalar('SELECT COUNT(*) FROM companies');
  return { total, linked, unlinked, pct, companyCount };
}

function sectionOrphans() {
  const orphans = q(`
    SELECT p.id, p.display_name, p.primary_source, p.created_at
    FROM people p
    WHERE p.archived = 0 AND (p.source_count = 0 OR p.source_count IS NULL)
    ORDER BY p.created_at DESC
    LIMIT 20
  `);
  const total = scalar(`
    SELECT COUNT(*) FROM people WHERE archived = 0 AND (source_count = 0 OR source_count IS NULL)
  `);
  return { total, sample: orphans };
}

function sectionDedupRisk() {
  // People with the same display_name but different ids (case-insensitive)
  const dupes = q(`
    SELECT LOWER(display_name) as name_key, COUNT(*) as n, GROUP_CONCAT(id) as ids
    FROM people WHERE archived = 0
    GROUP BY LOWER(display_name)
    HAVING n > 1
    ORDER BY n DESC
    LIMIT 20
  `);
  const totalGroups = scalar(`
    SELECT COUNT(*) FROM (
      SELECT LOWER(display_name)
      FROM people WHERE archived = 0
      GROUP BY LOWER(display_name)
      HAVING COUNT(*) > 1
    )
  `);
  const totalAffected = scalar(`
    SELECT COUNT(*) FROM people WHERE archived = 0
    AND LOWER(display_name) IN (
      SELECT LOWER(display_name) FROM people WHERE archived = 0
      GROUP BY LOWER(display_name) HAVING COUNT(*) > 1
    )
  `);
  return { totalGroups, totalAffected, sample: dupes };
}

// ─── Health score ──────────────────────────────────────────────────────────

function computeHealthScore(coverage, confidence, orphans, dedup) {
  const total = coverage.total;
  if (total === 0) return { score: 0, grade: 'N/A', issues: ['No people in graph'] };

  const issues = [];
  let score = 100;

  // Coverage penalty: -20 if < 50% have identifiers
  if (parseFloat(coverage.coveragePct) < 50) {
    score -= 20;
    issues.push(`Only ${coverage.coveragePct}% of people have email/phone identifiers`);
  } else if (parseFloat(coverage.coveragePct) < 75) {
    score -= 10;
    issues.push(`${coverage.coveragePct}% identifier coverage — target is 75%+`);
  }

  // Low-confidence penalty
  const lowPct = parseFloat(confidence.low.pct);
  if (lowPct > 30) { score -= 20; issues.push(`${lowPct}% of people have low confidence (< 0.50)`); }
  else if (lowPct > 15) { score -= 10; issues.push(`${lowPct}% of people have low confidence`); }

  // Orphan penalty
  const orphanPct = total > 0 ? (orphans.total / total) * 100 : 0;
  if (orphanPct > 20) { score -= 20; issues.push(`${orphanPct.toFixed(1)}% orphaned (source_count=0)`); }
  else if (orphanPct > 10) { score -= 10; issues.push(`${orphanPct.toFixed(1)}% orphaned — consider clean-entities`); }

  // Dedup risk penalty
  const dedupPct = total > 0 ? (dedup.totalAffected / total) * 100 : 0;
  if (dedupPct > 10) { score -= 20; issues.push(`${dedupPct.toFixed(1)}% of people in duplicate groups`); }
  else if (dedupPct > 5) { score -= 10; issues.push(`${dedupPct.toFixed(1)}% dedup risk — review recommended`); }

  score = Math.max(0, score);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade, issues };
}

// ─── Render ────────────────────────────────────────────────────────────────

function renderText(data) {
  const { coverage, sourceDist, confidence, companyLinks, orphans, dedup, health, generatedAt } = data;

  const line = (s = '') => process.stdout.write(s + '\n');
  const pad = (s, w) => String(s).padStart(w);
  const padL = (s, w) => String(s).padEnd(w);

  line('╔════════════════════════════════════════════════════════════╗');
  line('║           Robot Dojo — Entity QC Report                   ║');
  line(`║           Generated: ${generatedAt.slice(0, 19).replace('T', ' ')} UTC            ║`);
  line('╚════════════════════════════════════════════════════════════╝');
  line();

  line(`  Overall Health: ${health.grade} (${health.score}/100)`);
  if (health.issues.length > 0) {
    for (const issue of health.issues) line(`  ⚠  ${issue}`);
  } else {
    line('  ✓  No major issues detected');
  }
  line();

  // 1. Coverage
  line('── 1. IDENTIFIER COVERAGE ──────────────────────────────────────');
  line(`  Total active people : ${coverage.total.toLocaleString()}`);
  line(`  With email          : ${coverage.withEmail.toLocaleString()} (${coverage.emailPct}%)`);
  line(`  With phone          : ${coverage.withPhone.toLocaleString()} (${coverage.phonePct}%)`);
  line(`  With email or phone : ${coverage.withEither.toLocaleString()} (${coverage.coveragePct}%)`);
  line(`  Name-only (no id)   : ${coverage.nameOnly.toLocaleString()}`);
  line();

  // 2. Source distribution
  line('── 2. SOURCE DISTRIBUTION ──────────────────────────────────────');
  for (const s of sourceDist) {
    const bar = '█'.repeat(Math.round(parseFloat(s.pct) / 2));
    line(`  ${padL(s.source, 12)} ${pad(s.count, 7).toLocaleString()}  ${pad(s.pct, 5)}%  ${bar}`);
  }
  line();

  // 3. Confidence
  line('── 3. CONFIDENCE DISTRIBUTION ──────────────────────────────────');
  for (const [, b] of Object.entries(confidence)) {
    const bar = '█'.repeat(Math.round(parseFloat(b.pct) / 2));
    line(`  ${padL(b.label, 20)} ${pad(b.count, 7)}  ${pad(b.pct, 5)}%  ${bar}`);
  }
  line();

  // 4. Company links
  line('── 4. COMPANY LINKS ────────────────────────────────────────────');
  line(`  Total companies     : ${companyLinks.companyCount.toLocaleString()}`);
  line(`  People linked       : ${companyLinks.linked.toLocaleString()} (${companyLinks.pct}%)`);
  line(`  People unlinked     : ${companyLinks.unlinked.toLocaleString()}`);
  line();

  // 5. Orphans
  line('── 5. ORPHAN RISK ──────────────────────────────────────────────');
  line(`  Orphaned (source_count=0) : ${orphans.total.toLocaleString()}`);
  if (orphans.sample.length > 0) {
    line('  Sample (top 5):');
    for (const p of orphans.sample.slice(0, 5)) {
      line(`    • ${p.display_name.slice(0, 40)} [${p.primary_source || 'unknown'}] ${p.created_at?.slice(0, 10) || ''}`);
    }
    if (orphans.total > 5) line(`    … and ${orphans.total - 5} more`);
  }
  line();

  // 6. Dedup risk
  line('── 6. DEDUP RISK ───────────────────────────────────────────────');
  line(`  Duplicate name groups   : ${dedup.totalGroups.toLocaleString()}`);
  line(`  Total affected people   : ${dedup.totalAffected.toLocaleString()}`);
  if (dedup.sample.length > 0) {
    line('  Top duplicates:');
    for (const d of dedup.sample.slice(0, 5)) {
      line(`    • "${d.name_key}" — ${d.n} records`);
    }
    if (dedup.totalGroups > 5) line(`    … and ${dedup.totalGroups - 5} more groups`);
  } else {
    line('  ✓  No duplicate name groups detected');
  }
  line();

  line('─────────────────────────────────────────────────────────────────');
  line('  Run node scripts/clean-entities.js --dry-run to preview fixes.');
  line();
}

// ─── Main ──────────────────────────────────────────────────────────────────

function main() {
  // st_2cd1af73 Phase 3: zero-leakage assertion mode. Short-circuits the full
  // report — this is the CI/criteria guard for "resolution stays exact". Exit 1
  // (loud) if ANY active email/phone identifier maps to >1 active person.
  if (assertNoLeakage) {
    const leaks = findIdentifierLeakage();
    if (leaks.length === 0) {
      process.stdout.write('PASS zero identifier leakage — no active email/phone maps to >1 active person\n');
      process.exit(0);
    }
    process.stdout.write(`FAIL identifier leakage — ${leaks.length} identifier(s) map to >1 active person:\n`);
    for (const l of leaks.slice(0, 20)) {
      process.stdout.write(`  ${l.type} "${l.value}" → ${l.owners} people [${l.person_ids}]\n`);
    }
    process.exit(1);
  }

  const coverage = sectionCoverage();
  const sourceDist = sectionSourceDist();
  const confidence = sectionConfidenceBuckets();
  const companyLinks = sectionCompanyLinks();
  const orphans = sectionOrphans();
  const dedup = sectionDedupRisk();
  const health = computeHealthScore(coverage, confidence, orphans, dedup);
  const generatedAt = new Date().toISOString();

  const data = { coverage, sourceDist, confidence, companyLinks, orphans, dedup, health, generatedAt };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    renderText(data);
  }

  // Exit 1 if health grade is D or F so CI can catch severe degradation
  if (health.score < 40) {
    process.exit(1);
  }
}

// Run the CLI only when invoked directly, not when imported (e.g. by tests that
// exercise findIdentifierLeakage against a fixture DB). Without this guard,
// `import`ing the module would run main() against the live DB and call
// process.exit, killing the test runner.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
