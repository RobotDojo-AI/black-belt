/**
 * One-time migration: load historical health context files into the DB.
 *
 * Run once after DB lock clears:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/health-context-migrate.js
 *
 * What it does:
 *   1. Writes timeline events for the two generations of context files
 *      (2026-03-14 and 2026-04-23), treating each as an import/update
 *      event in the narrative of how the clinical framework evolved.
 *   2. Writes the canonical Medical Engineer context to user_topics.context_md
 *      for slug='health', merging:
 *        - Medical Engineer Protocol framework (from Slab)
 *        - Clinical state as of 2026-05-04 (VDR/VDBP model, Olumiant liver,
 *          D3/K2 experiment, chlorthalidone hold)
 *        - Active medications and genetic profile from the 2026-04-23 workbench
 *
 * Source files are now archived at:
 *   gs://robotdojo-files/user/databases/health/context-archive-2026-05-04/
 * Local copies deleted after GCS archive confirmed 2026-05-04.
 */

import crypto from 'crypto';
import db from '../lib/db.js';

function sha256(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// --- 1. Timeline events for context evolution ---

const events = [
  {
    date: '2026-03-14',
    summary: 'Health context established: Medical Engineering Protocol v1 initialized. ' +
      'Health Context v1 recorded including preliminary medication stack, genetic markers, ' +
      'and clinical history. Defines the systems-engineering framework for health analysis.',
    metadata: { source_files: ['Medical Engineer Protocol - 2026-03-14.txt', 'Health Context - 2026-03-14.txt', 'Health Historical Data - 2026-03-14.txt'], archived: 'gs://robotdojo-files/user/databases/health/context-archive-2026-05-04/' },
  },
  {
    date: '2026-04-23',
    summary: 'Health context updated: Medical Engineering Protocol v2 (Medical Workbench v8). ' +
      'Active context restructured as JSON workbench. Surgical planning (XLIF L4-L5 2026-02-05 scheduled). ' +
      'Hypotheses: Systemic Barrier Failure (Vascular/Gut/Immune) driven by APOE4 and Behçet\'s. ' +
      'Full genetic profile and medication titration history recorded.',
    metadata: { source_files: ['Medical Engineering Protocol - 2026-04-23.md', 'Health Active Context - Slab.md', 'Health Historical Data - Slab.md'], archived: 'gs://robotdojo-files/user/databases/health/context-archive-2026-05-04/' },
  },
  {
    date: '2026-05-04',
    summary: 'Clinical framework updated: VDR/VDBP root cause synthesis. ' +
      'Primary hypothesis revised — hypercalciuria driven by VDR/VDBP dysregulation, not pure CLDN14 leak. ' +
      'D3/K2 90-day experiment started. Olumiant liver monitoring initiated (ALT/AST trend: pause→improve→resume→climb→recovering). ' +
      'Chlorthalidone hold pending urine calcium recheck. All context files migrated to DB (user_topics.context_md).',
    metadata: { decisions: ['VDR/VDBP root cause model', 'D3/K2 90-day experiment', 'Olumiant liver monitoring', 'chlorthalidone hold'] },
  },
];

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO timeline_events
    (id, source_type, source_id, event_date, event_type, summary, content_hash, metadata)
  VALUES (?, 'health', ?, ?, 'context_update', ?, ?, ?)
`);

for (const ev of events) {
  const id = sha256('health', 'context_update', ev.date);
  const content_hash = sha256(ev.summary, ev.date);
  insertEvent.run(id, `health-context-${ev.date}`, ev.date, ev.summary, content_hash, JSON.stringify(ev.metadata));
  console.log(`[timeline] wrote context_update for ${ev.date}`);
}

// --- 2. Write consolidated user_topics.context_md for slug='health' ---

const CONTEXT_MD = `# Medical Engineer Protocol

You are operating as a Medical Systems Engineer — Miyagi variant with clinical depth. You are dispassionate, skeptical, and prioritize biological truth. The body is a closed-loop system. Root cause before intervention. Bayesian individualism: N=1 data overrides population likelihood.

## Core Framework

**Root Cause Hierarchy** — Find the minimum independent root causes. Parsimony Rule: the most elegant explanation accounting for the most data wins, but maintain independent buckets for unrelated failures.

**Biological Stress Axiom** — Any deviation from optimal has a cause. Never dismiss a marker as "normal range" without checking whether the body is raiding subordinate systems to maintain it.

**Stock & Flow Analysis** — Reconcile inputs, levels, and outputs. Check the denominator (urine/stool) to see if a system is failing to retain or failing to clear.

**Systems Hierarchy** — The body prioritizes immediate survival (pH, electrolytes) over long-term assets (bone density, hair). Analyze stable markers by checking what the body is sacrificing to maintain them.

## Active Clinical State — 2026-05-04

### Primary Thesis
VDR/VDBP dysregulation is the upstream driver of hypercalciuria, not the CLDN14 kidney leak alone. VDBP (DBP) sequesters 25-OH-D, leaving insufficient substrate for renal 1α-hydroxylase → elevated 1,25-D → absorptive hypercalciuria. The CLDN14 variant amplifies but does not cause the primary defect.

### Confirmed Diagnoses
- Idiopathic Hypercalciuria (CLDN14 rs219780 AC — genetically confirmed)
- Behçet's Disease (HLA-B rs1063355 GT — genetically supported)
- APOE e3/e4 (lipid volatility, reduced amyloid clearance)
- Spondylolisthesis L4-L5 (XLIF surgery completed 2026-02-05)
- Alopecia Areata (secondary to metabolic stress, onset 2023-06)
- Kidney Stone Disease — Calcium Oxalate (2011, 2020)

### Genetic Flags
- SLCO1B1 rs4149056 C;T — reduced statin clearance (myopathy risk)
- MTHFR C677T heterozygous — methylation impairment
- COMT Val158Met Met/Met — slow dopamine breakdown
- CYP2C19 — intermediate metabolizer

### Active Decisions (all from 2026-05-04 session)

**D3/K2 Experiment** — 90-day protocol started 2026-05-04. Goal: normalize 25-OH-D to 50-60 ng/mL without raising urine calcium. K2 (MK-7) directs calcium to bone, away from renal tubule. Recheck: 24hr urine calcium + serum 25-OH-D at 90 days.

**Olumiant (Baricitinib) Liver Monitoring** — ALT/AST trend: baseline normal → Olumiant pause → improved → resumed → climbing → currently recovering. Monthly LFTs until two consecutive normal readings. Do not adjust dose without liver data.

**Chlorthalidone Hold** — On hold pending 24hr urine calcium recheck. If urine calcium elevated → resume. If D3/K2 protocol normalizes urine calcium → may be able to discontinue permanently.

**VDR Testing** — Order: 1,25-dihydroxyvitamin D (calcitriol), VDBP (DBP), and repeat 25-OH-D simultaneously to confirm VDR/VDBP hypothesis.

### Current Medications
- Baricitinib (Olumiant) 4mg — waking, 16oz water, 30m before food
- Chlorthalidone 12.5mg — breakfast (on hold, see above)
- Adalimumab (Humira) 40mg — every other week
- Rosuvastatin 20mg — bedtime (down from 40mg, SLCO1B1 myopathy risk)
- Ezetimibe 10mg — bedtime
- 5-MTHF — breakfast (MTHFR support)
- Fish Oil 3.3g — breakfast
- D3+K2 4000IU — breakfast (active experiment)
- CoQ10 200mg — breakfast
- Magnesium Glycinate 480mg — bedtime

### Monitoring Targets
- ApoB < 60, LDL < 55, hs-CRP < 0.5, Fasting Glucose < 90
- 24hr Urine Calcium: watch for normalization under D3/K2 protocol
- ALT/AST: monthly until two consecutive clean readings
- 25-OH-D: target 50-60 ng/mL (not above 60 — raises urine calcium risk)

## Data Sources
- Lab data: health_data_points table (FHIR-imported, SHA256 deduplicated)
- Timeline: timeline_events WHERE source_type='health'
- Medications: curated_medications table
- Intelligence: /api/health/intel (regenerated after each import)
`;

const row = db.prepare("SELECT slug FROM user_topics WHERE slug='health'").get();
if (!row) {
  console.error('[health-context] user_topics row for slug=health not found — seed health topic first');
  process.exit(1);
}

db.prepare("UPDATE user_topics SET context_md = ? WHERE slug = 'health'").run(CONTEXT_MD);
console.log('[health-context] user_topics.context_md written for slug=health, chars=', CONTEXT_MD.length);

console.log('\nMigration complete. Run /api/health/intel to regenerate intelligence files.');
