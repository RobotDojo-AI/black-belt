#!/usr/bin/env node
/**
 * story-gate.js — multisig hash-chain gate for the story pipeline.
 *
 * --seal <stage> --file <p>  Agent seals the stage: hashes file, records agent_sealed timestamp.
 *                             Head does NOT advance until the owner countersigns with --approve.
 *                             For BUNSHIN_REQUIRED stages (research, scope, plan, build, qa) the seal
 *                             BLOCKS unless a matching Bunshin PASS verdict is on disk at
 *                             {story_dir}/bunshin/<stage>.json with artifact_sha256 ===
 *                             sha256(<file> bytes), plus a verified spawn→return
 *                             stage-event trail (st_862d73d1 AC2 — no escape hatch).
 * --approve <stage>          the owner countersigns: validates agent seal, advances head. Prints
 *                             the approve command for the owner to run in the terminal.
 * --approve-pending          countersigns the one pending sealed stage for the specified story, or
 *                             the only pending sealed stage across active story/defect records.
 * --require <stage>          Exit 0 if stage has BOTH agent_sealed AND owner_approved.
 *                             Exit 1 (BLOCKED) if either signature is missing.
 * --amend <stage>            Re-open a sealed stage for revision. Clears both signatures,
 *                             preserves prior hash as amended_from. Re-seal + re-approve required.
 * --record-bunshin <stage>   Record a Bunshin QC verdict for <stage>. Computes sha256 of <file>,
 *   --verdict <PASS|FAIL>    writes {story_dir}/bunshin/<stage>.json. Run by the producer
 *   --file <artifact>        agent AFTER Bunshin returns PASS and BEFORE --seal. Stale verdicts
 *                             (artifact_sha256 mismatch on seal) block the seal.
 * --story <id>               Specify the story ID explicitly (bypasses active-story inference).
 *
 * Stage order: framing → research → scope → plan → build → qa → close
 * 2-of-2 multisig: agent computes the hash, the owner approves, both required to advance.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ARTIFACTS } from './pipeline-schema.js';
import { notify } from './notify.js';
import { parseCriteria, extractCriteriaSection, countCriteriaBullets } from '../lib/criteria-parser.js';
import { lintCriteriaCommands } from '../lib/criteria-lint.js';
import {
  canonicalSurfaceFiles,
  effectiveBlobSha256,
  loadRootLock,
  protectedFiles,
  rootLockApprovalPath,
} from './root-lock-lib.js';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';
import { emitStageEvent } from '../lib/stage-events.js';
import { isLandedOnMain } from '../lib/merge-verify.js';

function asanaSync(storyId) {
  spawnSync('node', [join(homedir(), 'robotdojo/scripts/asana-upsert-story.js'), '--story', storyId], {
    stdio: 'ignore', timeout: 10000,
  });
}

const STORIES_DIR = PIPELINE_STORIES_DIR;

// Resolve sibling gate scripts relative to THIS file, not homedir() — so a
// hermetic test that overrides HOME (e.g. root-lock-approval.test.js) still
// finds the real check scripts (st_862d73d1).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
function siblingScript(name) {
  return join(SCRIPT_DIR, name);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--require') args.require = argv[++i];
    else if (a === '--seal') args.seal = argv[++i];
    else if (a === '--approve') args.approve = argv[++i];
    else if (a === '--approve-pending') args.approvePending = true;
    else if (a === '--amend') args.amend = argv[++i];
    else if (a === '--record-bunshin') args.recordBunshin = argv[++i];
    else if (a === '--verdict') args.verdict = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--story') args.story = argv[++i];
  }
  return args;
}

// Stages that require a recorded Bunshin PASS verdict before --seal. AC19b
// (st_6f81e248): converts "Bunshin is mandatory" from prose in six docs into
// a single enforced gate. Framing and close are intentionally excluded —
// framing is the owner's intent capture (no Bunshin), close is formal wrapper.
const BUNSHIN_REQUIRED_STAGES = new Set(['research', 'scope', 'plan', 'build', 'qa']);

// st_862d73d1 AC5 — stages that carry a `## 10/10 self-audit` section the
// default-quality contract mandates before every seal. check-self-audit-section.js
// is WIRED into the seal path for these (was orphaned/built-but-dead).
const SELF_AUDIT_REQUIRED_STAGES = new Set(['scope', 'plan', 'build', 'qa']);

// st_862d73d1 AC5 — stages whose on-disk artifact carries an owner-facing
// render-summary block that must conform to the presentation contract
// (1)/a) numbering, ≤18 lines, no technical lead). check-stage-presentation-
// contract.js is WIRED into the seal path for these. Honest limit: it gates the
// on-disk artifact + the SKILL.md templates, not the live conversational render.
const RENDER_SUMMARY_STAGES = new Set(['research', 'scope', 'plan', 'build', 'qa']);

// st_5e810098 AC1/AC3 — the two doc-budget/root-lock checks that used to only
// fire reactively at the git pre-commit hook now run unskippably at the build
// seal. check-doc-budget.js is repo-wide and unchanged (OOS-1); a non-zero
// exit blocks the seal outright. check-preseal-protected-touches.js always
// exits 0 for the normal "protected file awaiting the owner's build
// countersign" case (see below) — it only fails the seal on a genuine
// structural error, and prints the per-file table so the owner sees which
// files are protected before countersigning.
const DOC_BUDGET_REQUIRED_STAGES = new Set(['build']);
const PROTECTED_TOUCH_CHECK_STAGES = new Set(['build']);

function bunshinVerdictPath(storyDir, stage) {
  return join(storyDir, 'bunshin', `${stage}.json`);
}

function loadBunshinVerdict(storyDir, stage) {
  const p = bunshinVerdictPath(storyDir, stage);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Pre-seal Bunshin check. Returns null on pass, error string on fail.
// Returns null when the stage is not in BUNSHIN_REQUIRED_STAGES. The
// artifact_sha256 bound to the verdict must match sha256 of the bytes about to
// be sealed — a stale verdict (Bunshin judged a different version) is the
// failure mode this gate catches. (st_862d73d1: no env escape hatch — the
// spawn→return stage-event trail is the additional binding, checked at seal.)
function bunshinGateError(stage, fileBytes, storyDir) {
  // st_862d73d1 AC2 — the env escape hatch is removed. Tests now exercise the
  // LIVE seal path with a real recorded verdict + a minimal valid stage-event
  // trail (tests/helpers/bunshin-trail.js), not a bypass.
  if (!BUNSHIN_REQUIRED_STAGES.has(stage)) return null;
  const verdict = loadBunshinVerdict(storyDir, stage);
  if (!verdict) {
    return `BLOCKED — Bunshin QC not recorded for "${stage}". Run Bunshin, then:\n` +
      `  node scripts/story-gate.js --record-bunshin ${stage} --verdict PASS --file <artifact>`;
  }
  if (verdict.verdict !== 'PASS') {
    return `BLOCKED — Bunshin verdict for "${stage}" is "${verdict.verdict}", not PASS. ` +
      `Revise the artifact, re-run Bunshin, and --record-bunshin again.`;
  }
  const expectedHash = sha256(fileBytes);
  if (verdict.artifact_sha256 !== expectedHash) {
    return `BLOCKED — Bunshin verdict for "${stage}" is stale: verdict was for a different artifact version — re-run Bunshin and --record-bunshin.\n` +
      `  expected (current file): ${expectedHash.slice(0, 16)}...\n` +
      `  recorded (verdict file): ${(verdict.artifact_sha256 || '').slice(0, 16)}...`;
  }
  return null;
}

// AC6 (st_862d73d1) — bind the build seal to the currently-sealed plan. The
// criteria evidence records `PLAN_SHA256: <sha>` of the plan it ran against;
// recompute sha256 of the sealed 02-plan.md and BLOCK on mismatch (or on a
// missing header, which means the evidence predates this binding and is stale).
function criteriaPlanBindingError(storyDir, evidence) {
  const planPath = join(storyDir, ARTIFACTS.plan);
  if (!existsSync(planPath)) {
    // No sealed plan on disk to bind against — let the predecessor gate handle
    // ordering; do not invent a binding error here.
    return null;
  }
  const m = evidence.match(/^PLAN_SHA256:\s*([a-f0-9]{64})\s*$/m);
  if (!m) {
    return `BLOCKED — ${ARTIFACTS.criteria} has no PLAN_SHA256 line: it predates the plan-binding contract and may be stale. Re-run criteria-runner.js against the sealed plan.`;
  }
  const recorded = m[1];
  const actual = sha256(readFileSync(planPath));
  if (recorded !== actual) {
    return `BLOCKED — ${ARTIFACTS.criteria} was generated from a different plan version (PLAN_SHA256 ${recorded.slice(0, 16)}… ≠ sealed plan ${actual.slice(0, 16)}…). Re-run criteria-runner.js against the currently-sealed ${ARTIFACTS.plan}.`;
  }
  return null;
}

// AC6 (st_862d73d1) — a `**Manual QA:**` line must name a verifiable observable:
// an evidence path, a URL, or a quoted expected result. A bare assertion
// ("looks good") names nothing checkable and is BLOCKED at the QA seal.
function manualQaObservableError(lines) {
  const offenders = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l.startsWith('**Manual QA:**')) continue;
    const rest = l.slice('**Manual QA:**'.length).trim();
    const hasObservable =
      /["“][^"”]{3,}["”]/.test(rest) ||                       // quoted expected result
      /https?:\/\/\S+/.test(rest) ||                          // a URL
      /(`[^`]+`)/.test(rest) ||                               // an inline-code token (path/command/value)
      /\b[\w./-]+\.(md|js|json|png|jpg|txt|log|sh|html|csv)\b/.test(rest) || // an evidence path
      /\bevidence:\s*\S/i.test(rest);                         // an explicit evidence: pointer
    if (!hasObservable) offenders.push(l.slice(0, 80));
  }
  if (offenders.length) {
    return `BLOCKED — ${offenders.length} Manual QA line(s) name no verifiable observable (need an evidence path, a URL, or a quoted expected result):\n` +
      offenders.map(o => `  - ${o}`).join('\n');
  }
  return null;
}

function resolveStoryDir(storyId) {
  const dir = join(STORIES_DIR, storyId);
  if (!existsSync(dir)) {
    console.error(`BLOCKED — story directory not found: ${dir}`);
    process.exit(1);
  }
  return dir;
}

function loadStageHashes(storyDir) {
  const p = join(storyDir, 'stage-hashes.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function saveStageHashes(storyDir, data) {
  writeFileSync(join(storyDir, 'stage-hashes.json'), JSON.stringify(data, null, 2));
}

function writeSealSnapshot(storyDir, stage, fileBytes) {
  const snapshotDir = join(storyDir, '.stage-snapshots');
  mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = join(snapshotDir, `${stage}.md`);
  writeFileSync(snapshotPath, fileBytes);
  return snapshotPath;
}

const SEALED_STAGE = {
  framing: 'framing-sealed',
  research: 'research-sealed',
  scope: 'scope-sealed',
  plan: 'plan-sealed',
  build: 'build-sealed',
  qa: 'qa-sealed',
  close: 'close-sealed',
};

const APPROVED_STAGE = {
  framing: 'framing-complete',
  research: 'research-complete',
  scope: 'scope-complete',
  plan: 'plan-approved',
  build: 'build-complete',
  qa: 'qa-complete',
  close: 'close-complete',
};

const STAGE_PREDECESSOR = {
  research: 'framing',
  scope: 'research',
  plan: 'scope',
  build: 'plan',
  qa: 'build',
  close: 'qa',
};

// Forward map — inverse of STAGE_PREDECESSOR. Used by stage-skill preambles
// to detect "exact correct next stage" for the implicit-approval-on-next-invocation
// exception narrowed in CLAUDE.md (st_6f81e248). `close` has no next stage.
const STAGE_NEXT = {
  framing:  'research',
  research: 'scope',
  scope:    'plan',
  plan:     'build',
  build:    'qa',
  qa:       'close',
};

function updateMeta(storyDir, patch) {
  const metaPath = join(storyDir, 'meta.json');
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  Object.assign(meta, patch);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function readMeta(storyDir) {
  const metaPath = join(storyDir, 'meta.json');
  if (!existsSync(metaPath)) return {};
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}

function activeStoryId(override) {
  if (override) return override;
  // Infer from meta.json state
  const storiesDir = join(STORIES_DIR);
  let dirs;
  try { dirs = readdirSync(storiesDir).filter(d => /^(st|df|wk)_/.test(d)); } catch { dirs = []; }
  const active = dirs
    .map(d => { try { return JSON.parse(readFileSync(join(storiesDir, d, 'meta.json'), 'utf8')); } catch { return null; } })
    .filter(m => m && m.kanban === 'in-progress' && m.type !== 'work')
    .sort((a, b) => new Date(b.started) - new Date(a.started));
  if (active.length === 0) {
    console.error('BLOCKED — no active story. Run /story or /defect to start one, or pass --story <id>.');
    process.exit(1);
  }
  if (active.length > 1) {
    console.error('AMBIGUOUS — multiple active stories:\n' +
      active.map(m => `  ${m.story_id}  ${m.slug}  (${m.stage})`).join('\n') +
      '\nPass --story <id> to specify which one.');
    process.exit(1);
  }
  return active[0].story_id;
}

function pendingApprovalForStory(storyDir) {
  const sh = loadStageHashes(storyDir);
  if (!sh?.stages || !sh?.chain) return null;
  for (let i = sh.stages.length - 1; i >= 0; i--) {
    const stage = sh.stages[i];
    const entry = sh.chain[stage];
    if (entry?.agent_sealed && !entry.owner_approved) return { stage, entry };
  }
  return null;
}

function resolvePendingApprovalTarget(storyIdOverride) {
  if (storyIdOverride) {
    const storyDir = resolveStoryDir(storyIdOverride);
    const pending = pendingApprovalForStory(storyDir);
    if (!pending) {
      console.error(`BLOCKED — no pending owner countersign for story ${storyIdOverride}.`);
      process.exit(1);
    }
    return { storyId: storyIdOverride, stage: pending.stage };
  }

  let dirs;
  try { dirs = readdirSync(STORIES_DIR).filter(d => /^(st|df)_/.test(d)); } catch { dirs = []; }
  const pending = [];
  for (const d of dirs) {
    const dir = join(STORIES_DIR, d);
    const meta = readMeta(dir);
    if (meta.kanban !== 'in-progress' || meta.type === 'work') continue;
    const target = pendingApprovalForStory(dir);
    if (target) pending.push({ storyId: d, stage: target.stage, meta });
  }

  if (pending.length === 0) {
    console.error('BLOCKED — no active story/defect has a pending owner countersign.');
    process.exit(1);
  }
  if (pending.length > 1) {
    console.error(
      'AMBIGUOUS — multiple active stories/defects have pending owner countersigns:\n' +
      pending.map(p => `  ${p.storyId}  ${p.meta.slug || p.storyId}  (${p.stage})`).join('\n') +
      '\nPass --story <id> to approve the intended record.'
    );
    process.exit(2);
  }
  return pending[0];
}

// Stage-specific content validation before hashing.
// Returns null on pass, or an error string on fail.
// Legacy seals (using 'ts' field instead of 'agent_sealed') skip validation.
function validateStageSeal(stage, filePath, storyDir) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  const hasSection = (heading) => lines.some(l => l.trim() === heading);
  const countTableDataRows = (afterHeading) => {
    let found = false, count = 0;
    for (const l of lines) {
      if (l.trim() === afterHeading) { found = true; continue; }
      if (found && l.startsWith('## ')) break;
      if (found && l.startsWith('|') && !l.includes('---') && !l.match(/^\|\s*Source\s*\|/i)) count++;
    }
    return count;
  };
  const countListItemsInSection = (heading) => {
    let found = false, count = 0;
    for (const l of lines) {
      if (l.trim() === heading) { found = true; continue; }
      if (found && l.startsWith('## ')) break;
      if (found && (l.startsWith('- ') || /^\d+[.)]\s+/.test(l.trim()))) count++;
    }
    return count;
  };

  if (stage === 'framing') {
    // Framing seals on the framing section in 00-scope.md. The file may not yet contain
    // ## Acceptance criteria — that section is written later by /scope. Validate only what
    // /framing is responsible for, with a first-class defect heading so defects do not
    // silently pass through the story-shaped artifact contract.
    const meta = readMeta(storyDir);
    if (meta?.type === 'defect') {
      if (!hasSection('## Defect framing')) return 'BLOCKED — Missing ## Defect framing section. /framing must use the defect framing contract before seal.';
      return null;
    }
    if (!hasSection('## Framing')) return 'BLOCKED — Missing ## Framing section. /framing must write it before seal.';
    return null;
  }

  if (stage === 'scope') {
    // New living-document format (post st_0561ceaa): Original request + Framing + Acceptance criteria
    // Defect format uses ## Original report + ## Defect framing — both count as new format
    const isNewFormat = hasSection('## Original request') || hasSection('## Framing')
      || hasSection('## Original report') || hasSection('## Defect framing');
    if (isNewFormat) {
      const required = ['## Acceptance criteria'];
      const missing = required.filter(s => !hasSection(s) && !hasSection(s.replace('c', 'C')));
      if (missing.length) return `Missing required sections: ${missing.join(', ')}`;
    } else {
      // Legacy format
      const required = ['## Business outcome', '## Why now', '## Success in plain language', '## Acceptance Criteria', '## Research summary', '## Constraints'];
      const missing = required.filter(s => !hasSection(s));
      if (missing.length) return `Missing required sections: ${missing.join(', ')}`;
    }
    const acSection = hasSection('## Acceptance criteria') ? '## Acceptance criteria' : '## Acceptance Criteria';
    if (countListItemsInSection(acSection) < 1)
      return 'BLOCKED — Acceptance criteria must have at least 1 numbered criterion';
    return null;
  }

  if (stage === 'research') {
    const required = ['## Internal', '## External', '## Recommendation'];
    const missing = required.filter(s => !hasSection(s));
    if (missing.length) return `Missing required sections: ${missing.join(', ')}`;

    // df_aa0f667f — sub-process trail enforcement.
    // Both Tantei and Hakase must either (a) have a spawned+returned run trail,
    // or (b) have a skipped event with non-empty owner_approval. Only the owner
    // can approve skipping a required research sub-process.
    const trailStoryId = basename(storyDir);
    const evPath = join(storyDir, 'stage-events.jsonl');
    const trail = existsSync(evPath)
      ? readFileSync(evPath, 'utf8').split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return {}; } })
          .filter(e => e.stage === 'research')
      : [];

    for (const proc of ['tantei', 'hakase']) {
      const hasRun =
        trail.some(e => e.event === `${proc}_spawned` && e.subagent_return_id && e.subagent_return_id.trim().length > 0) &&
        trail.some(e => e.event === `${proc}_returned` && e.subagent_return_id && e.subagent_return_id.trim().length > 0);
      const hasSkip =
        proc !== 'hakase' &&
        trail.some(e => e.event === `${proc}_skipped` && e.owner_approval && e.owner_approval.trim().length > 0);
      if (!hasRun && !hasSkip) {
        const skipNote = proc !== 'hakase'
          ? ` and no owner-approved skip (${proc}_skipped with non-empty owner_approval)`
          : '';
        return (
          `BLOCKED — ${proc} sub-process has no run trail (${proc}_spawned+${proc}_returned)${skipNote}. ` +
          (proc === 'hakase'
            ? `External research is required on every story; no skip path exists.`
            : `Only the owner can approve skipping a required research sub-process.`)
        );
      }
    }

    return null;
  }

  if (stage === 'plan') {
    const required = ['## Outcome', '## Approach', '## How ACs are satisfied', '## Test strategy', '## Failure manifest'];
    const missing = required.filter(s => !hasSection(s));
    if (missing.length) return `Missing required sections: ${missing.join(', ')}`;
    // Single-source parse via lib/criteria-parser.js. criteria-runner.js uses
    // the same module — a plan that seals here always parses there
    // (st_6f81e248 AC16). Count bullets to distinguish "no criteria at all"
    // from "bullets present but none parse as runnable criteria".
    const section = extractCriteriaSection(content);
    const parsed = parseCriteria(section);
    const bullets = countCriteriaBullets(section);
    if (bullets === 0) {
      return 'BLOCKED — How ACs are satisfied section has no criteria. A plan without verifiable criteria is a wish list.';
    }
    if (parsed.length < bullets) {
      return `BLOCKED — ${bullets - parsed.length} criteria missing runnable commands (→ \`command\`). Criteria without a command cannot be verified.`;
    }
    // Criteria-probe linter (st_a5baa72c AC4): catch non-portable / silently-
    // false-passing probes at plan-seal, not after they ship and fail at QA.
    // lib/criteria-lint.js bans the broken-probe classes from
    // build-conventions.md (readlink -e, `-c | grep '^0$'`, hardcoded shas,
    // bare marker greps, stale-DB / banned-api-key paths, /health-grep-ok). It
    // is high-precision — portable forms (node --test, real curls, `! rg -q
    // ... || true`) produce zero violations.
    const lintViolations = lintCriteriaCommands(parsed);
    if (lintViolations.length) {
      const lines = lintViolations.map(
        (v) => `  - "${v.description}" → \`${v.command}\`\n      ${v.violation}`,
      );
      return `BLOCKED — ${lintViolations.length} criteria use a banned/non-portable probe shape (caught at plan-seal, not QA):\n${lines.join('\n')}`;
    }
    // AC coverage gate (st_0c491456 AC-36): every numbered scope AC must
    // have a matching `### AC-N:` plan criterion. Plans that seal without
    // coverage ship incomplete builds — catch at plan-seal not at QA.
    const scopePath = join(storyDir, '00-scope.md');
    if (existsSync(scopePath)) {
      const checkResult = spawnSync(
        process.execPath,
        [siblingScript('check-ac-coverage.js'), '--scope', scopePath, '--plan', filePath],
        { encoding: 'utf8' },
      );
      if (checkResult.status !== 0) {
        return (checkResult.stderr || checkResult.stdout || '').trim()
          || 'BLOCKED — check-ac-coverage.js failed without output.';
      }
    }
    return null;
  }

  if (stage === 'build') {
    // Check 03b-criteria.md exists in story dir and has VERDICT: PASS
    const evidencePath = join(storyDir, ARTIFACTS.criteria);
    if (!existsSync(evidencePath)) {
      return `BLOCKED — ${ARTIFACTS.criteria} missing. Run criteria-runner.js first. Build cannot be sealed without machine-verified evidence.`;
    }
    const evidence = readFileSync(evidencePath, 'utf8');
    if (!evidence.includes('VERDICT: PASS')) {
      return `BLOCKED — ${ARTIFACTS.criteria} does not contain VERDICT: PASS. Fix failing criteria before sealing build.`;
    }
    // AC6 (st_862d73d1) — criteria-to-plan binding. The evidence must have been
    // generated from the CURRENTLY-sealed 02-plan.md, not a stale prior version.
    // criteria-runner.js writes `PLAN_SHA256: <sha>` of the plan it ran against;
    // recompute sha256 of the sealed plan here and BLOCK on mismatch. (A pre-AC6
    // evidence file lacks the header — block with a clear "re-run criteria"
    // message so a stale file cannot slip through.)
    const planBindingError = criteriaPlanBindingError(storyDir, evidence);
    if (planBindingError) return planBindingError;
    return null;
  }

  if (stage === 'qa') {
    // AC3 (st_862d73d1) — QA must seal at PASS, parity with build. Previously
    // ANY `VERDICT:` line passed, so a `VERDICT: FAIL` QA could seal and be
    // approved, shipping broken work. Require specifically `VERDICT: PASS`.
    if (!lines.some(l => l.trim() === 'VERDICT: PASS')) {
      if (lines.some(l => l.startsWith('VERDICT:'))) {
        return 'BLOCKED — QA VERDICT is not PASS. A FAIL (or any non-PASS) QA cannot be sealed. Fix the failures and re-run QA.';
      }
      return 'BLOCKED — QA report missing VERDICT: line. Report must include VERDICT: PASS to seal.';
    }
    // AC6 (st_862d73d1) — every `**Manual QA:**` line must name a verifiable
    // observable (an evidence path, a URL, or a quoted expected result). A bare
    // `**Manual QA:** looks good` names nothing checkable and is BLOCKED.
    const manualQaError = manualQaObservableError(lines);
    if (manualQaError) return manualQaError;
    return null;
  }

  if (stage === 'close') {
    if (!hasSection('## Shipped')) return 'BLOCKED — Close report missing ## Shipped section.';
    if (!lines.some(l => l.startsWith('VERDICT:'))) return 'BLOCKED — Close report missing VERDICT: line.';
    return null;
  }

  // Unknown stage — pass through (forward-compatible)
  return null;
}

function predecessorApprovalError(stage, sh, meta) {
  if (meta?.type === 'work') return null;
  const prevStage = STAGE_PREDECESSOR[stage];
  if (!prevStage) return null;
  const entry = sh?.chain?.[prevStage];
  if (!entry) {
    return `BLOCKED — cannot seal "${stage}" before "${prevStage}" is sealed and owner-countersigned.`;
  }
  if (!entry.owner_approved) {
    return `BLOCKED — cannot seal "${stage}" while "${prevStage}" is agent-sealed but awaiting the owner's countersign.`;
  }
  return null;
}

function planTouchClaimError(storyDir) {
  const meta = readMeta(storyDir);
  if (meta?.type === 'work') return null;
  if (meta?.touches_exception) return null;
  const files = Array.isArray(meta?.touches) ? meta.touches.filter(Boolean) : [];
  if (files.length > 0) return null;
  return 'BLOCKED — plan approval requires meta.touches[] or meta.touches_exception so active-build protection has a real conflict set.';
}

// st_a5baa72c AC3 — fold the root-lock approval write into the BUILD countersign
// so a protected file in meta.touches never surfaces a separate commit-time
// block. Keyed to effectiveBlobSha256 (the STAGED blob — what the commit will
// actually contain and what check-root-lock compares — falling back to the
// committed blob only when nothing is staged; st_5e810098 AC4: this is the fix
// for the stale-HEAD no-op that silently skipped writing an approval, and for
// keying to the OLD committed bytes of a modified protected file). The
// owner's countersign IS the approval the lock captures, so the
// truth-statement becomes the owner_quote. Writes to
// ~/.robotdojo/root-lock-approvals.json (a registered dot_robotdojo_entry, so
// lock-safe). Prints and continues on any failure — the countersign is
// independent of this convenience write. Returns the count written.
function writeRootLockApprovalForBuild(storyId, storyDir, ownerQuote) {
  let written = 0;
  try {
    const repoRoot = join(process.env.HOME, 'robotdojo');
    const meta = readMeta(storyDir);
    const touches = Array.isArray(meta?.touches) ? meta.touches.filter(Boolean) : [];
    if (touches.length === 0) return 0;

    const lock = loadRootLock(repoRoot);
    const protectedSet = new Set([...protectedFiles(lock), ...canonicalSurfaceFiles(repoRoot)]);
    const targets = touches.filter((f) => protectedSet.has(f));
    if (targets.length === 0) return 0;

    const files = {};
    for (const f of targets) {
      const sha = effectiveBlobSha256(repoRoot, f);
      if (sha) files[f] = sha; // skip files not committed AND not staged
    }
    if (Object.keys(files).length === 0) return 0;

    const approvalPath = rootLockApprovalPath();
    mkdirSync(join(homedir(), '.robotdojo'), { recursive: true });
    let doc = { approvals: [] };
    if (existsSync(approvalPath)) {
      const parsed = JSON.parse(readFileSync(approvalPath, 'utf8'));
      doc = Array.isArray(parsed) ? { approvals: parsed } : (parsed.approvals ? parsed : { approvals: [] });
    }
    let entry = doc.approvals.find((a) => a && a.story_id === storyId);
    if (!entry) {
      entry = { story_id: storyId, owner_quote: ownerQuote, files: {} };
      doc.approvals.push(entry);
    }
    entry.owner_quote = ownerQuote;
    entry.files = { ...(entry.files || {}), ...files };
    writeFileSync(approvalPath, JSON.stringify(doc, null, 2) + '\n');
    written = Object.keys(files).length;
  } catch (e) {
    process.stderr.write(`[story-gate] root-lock approval write failed (non-fatal): ${e.message}\n`);
  }
  return written;
}

const args = parseArgs(process.argv);

if (!args.require && !args.seal && !args.approve && !args.approvePending && !args.amend && !args.recordBunshin) {
  console.error('Usage: story-gate.js (--require <stage> | --seal <stage> --file <path> | --approve <stage> | --approve-pending | --amend <stage> | --record-bunshin <stage> --verdict <PASS|FAIL> --file <path>) [--story <id>]');
  process.exit(1);
}

let storyId;
if (args.approvePending) {
  const target = resolvePendingApprovalTarget(args.story);
  storyId = target.storyId;
  args.approve = target.stage;
} else {
  storyId = activeStoryId(args.story);
}
const storyDir = resolveStoryDir(storyId);

// ── REQUIRE ──────────────────────────────────────────────────────────────────
if (args.require) {
  const stage = args.require;
  // Work sessions have advisory gates — any skill can run in any order.
  // Story/defect sessions enforce strict gate ordering.
  try {
    const meta = JSON.parse(readFileSync(join(storyDir, 'meta.json'), 'utf8'));
    if (meta.type === 'work') {
      console.log(`OK (advisory) — work session: stage "${stage}" gate skipped by design.`);
      process.exit(0);
    }
  } catch {}
  const sh = loadStageHashes(storyDir);
  const entry = sh?.chain[stage];
  if (!entry) {
    console.error(`BLOCKED — stage "${stage}" not sealed for story ${storyId}. Run the preceding pipeline skill first.`);
    process.exit(1);
  }
  if (!entry.owner_approved) {
    // Exit 2: sealed but not yet owner-approved. Stage-skill preambles use this
    // distinct code to detect "safe to auto-approve via exact-next-stage invocation"
    // (st_6f81e248). Exit 1 still means "not sealed at all" — a wrong/skipped stage.
    // The BLOCKED message text is unchanged for backward-compatible agent reading.
    console.error(`BLOCKED — stage "${stage}" agent-sealed but awaiting the owner's countersign.`);
    console.error(`Run: ! node ~/robotdojo/scripts/story-gate.js --approve ${stage}`);
    process.exit(2);
  }
  console.log(`OK — stage "${stage}" fully signed (agent + owner) hash: ${entry.hash.slice(0, 12)}...`);
  process.exit(0);
}

// ── SEAL (agent signature) ────────────────────────────────────────────────────
if (args.seal) {
  const stage = args.seal;
  if (!args.file) {
    console.error('--seal requires --file <path>');
    process.exit(1);
  }
  if (!existsSync(args.file)) {
    console.error(`BLOCKED — file not found: ${args.file}`);
    process.exit(1);
  }

  let sh = loadStageHashes(storyDir);
  if (!sh) {
    console.error('BLOCKED — stage-hashes.json missing. Was story-init.js run?');
    process.exit(1);
  }

  const existing = sh.chain[stage];
  if (existing && !existing.amended_from) {
    console.error(`BLOCKED — stage "${stage}" is already sealed. The chain is append-only.`);
    process.exit(1);
  }
  if (existing && existing.agent_sealed) {
    console.error(`BLOCKED — stage "${stage}" is already sealed (post-amend). The chain is append-only.`);
    process.exit(1);
  }

  const predecessorError = predecessorApprovalError(stage, sh, readMeta(storyDir));
  if (predecessorError) {
    console.error(predecessorError);
    process.exit(1);
  }

  const validationError = validateStageSeal(stage, args.file, storyDir);
  if (validationError) {
    console.error(validationError);
    process.exit(1);
  }

  const fileBytes = readFileSync(args.file);
  // AC19b — Bunshin-ran gate. Verdict must be PASS and bound to THIS artifact
  // version (sha256 match). Stale or missing verdict blocks the seal.
  const bunshinError = bunshinGateError(stage, fileBytes, storyDir);
  if (bunshinError) {
    console.error(bunshinError);
    process.exit(1);
  }

  // st_862d73d1 AC5 — self-audit gate (wired). A BUNSHIN_REQUIRED artifact must
  // carry a `## 10/10 self-audit` section with answered Q1/Q2/Q3 + the owner's
  // waiver, exactly as the default-quality contract mandates before every seal.
  if (SELF_AUDIT_REQUIRED_STAGES.has(stage)) {
    const sa = spawnSync(process.execPath,
      [siblingScript('check-self-audit-section.js'), '--file', args.file],
      { encoding: 'utf8' });
    if (sa.status !== 0) {
      console.error((sa.stderr || sa.stdout || '').trim() || 'BLOCKED — self-audit section gate failed.');
      process.exit(1);
    }
  }

  // st_862d73d1 AC5 — stage-presentation gate (wired). The artifact's
  // owner-facing block must conform to the presentation contract (1)/a)
  // numbering, ≤18 lines, no technical lead). The contract's repo-level checks
  // (formatting fragment + SKILL templates) run on every invocation; passing
  // --file would additionally gate a standalone owner-facing prompt file.
  if (RENDER_SUMMARY_STAGES.has(stage)) {
    const pc = spawnSync(process.execPath,
      [siblingScript('check-stage-presentation-contract.js')],
      { encoding: 'utf8' });
    if (pc.status !== 0) {
      console.error((pc.stderr || pc.stdout || '').trim() || 'BLOCKED — stage-presentation contract gate failed.');
      process.exit(1);
    }
  }

  // st_5e810098 AC1 — doc-budget, repo-wide, unconditional. Any registered
  // surface over its char budget blocks the seal, whether or not this story
  // touched it (OOS-1: an over-budget doc is a real problem regardless of
  // attribution).
  if (DOC_BUDGET_REQUIRED_STAGES.has(stage)) {
    const db = spawnSync(process.execPath,
      [siblingScript('check-doc-budget.js')],
      { encoding: 'utf8' });
    if (db.status !== 0) {
      console.error((db.stderr || db.stdout || '').trim() || 'BLOCKED — doc-budget gate failed.');
      process.exit(1);
    }
  }

  // st_5e810098 AC2/AC3 — protected-surface pre-seal notice. No
  // --fail-if-unapproved here: the normal state (a first-time protected touch
  // awaiting the owner's build countersign) is expected to exit 0. Only a
  // structural error (bad lock file, unreadable meta.json) blocks the seal.
  // stdout (the per-file table) is surfaced as part of the seal output so the
  // owner sees which files need approval before countersigning.
  if (PROTECTED_TOUCH_CHECK_STAGES.has(stage)) {
    const pt = spawnSync(process.execPath,
      [siblingScript('check-preseal-protected-touches.js'), '--story', storyId],
      { encoding: 'utf8' });
    if (pt.status !== 0) {
      console.error((pt.stderr || pt.stdout || '').trim() || 'BLOCKED — protected-touch check failed.');
      process.exit(1);
    }
    if (pt.stdout) console.log(pt.stdout.trim());
  }

  // st_862d73d1 AC2 — Bunshin evidence trail (wired). For a BUNSHIN_REQUIRED
  // stage the seal requires a tamper-evident stage-event chain proving a Bunshin
  // context was spawned and returned a verdict bound to these exact bytes:
  //   bunshin_spawned → bunshin_returned → seal_requested
  // each Bunshin event carrying a non-empty subagent_return_id. We emit
  // seal_requested HERE (story-gate is the seal authority), then run the ordering
  // check. Honest limit: this proves a separate context ran + returned, NOT that
  // it reasoned well (scope OOS-2). The hand-typed verdict alone no longer seals.
  if (BUNSHIN_REQUIRED_STAGES.has(stage)) {
    // Precondition (st_862d73d1 retry-hygiene): do NOT emit seal_requested until
    // the Bunshin spawn→return trail already exists. Emitting it first means a
    // premature/blocked seal leaves a stray seal_requested that pollutes the
    // trail; this guard fails early with a clear message and keeps the trail clean.
    const evPath = join(storyDir, 'stage-events.jsonl');
    const trail = existsSync(evPath)
      ? readFileSync(evPath, 'utf8').split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return {}; } })
          .filter(e => e.stage === stage)
      : [];
    const hasSpawn = trail.some(e => e.event === 'bunshin_spawned' && e.subagent_return_id);
    const hasReturn = trail.some(e => e.event === 'bunshin_returned' && e.subagent_return_id);
    if (!hasSpawn || !hasReturn) {
      console.error('BLOCKED — emit the Bunshin spawn→return trail (with subagent_return_id) before sealing this stage; no seal_requested recorded.');
      process.exit(1);
    }
    try {
      await emitStageEvent({ storyId, stage, agent: 'miyagi', event: 'seal_requested' });
    } catch (e) {
      console.error(`BLOCKED — could not record seal_requested stage event: ${e.message}`);
      process.exit(1);
    }
    const order = spawnSync(process.execPath,
      [siblingScript('check-stage-event-order.js'), '--story', storyId, '--stage', stage],
      { encoding: 'utf8', env: { ...process.env } });
    if (order.status !== 0) {
      console.error((order.stderr || order.stdout || '').trim() ||
        'BLOCKED — stage-event order gate failed: no verified Bunshin spawn→return trail bound to this seal.');
      process.exit(1);
    }
  }

  const prev = sh.head;
  // Chain: hash(prev_hash_hex_string + file_bytes) — binds this artifact to the prior stage
  const combined = Buffer.concat([Buffer.from(prev, 'utf8'), fileBytes]);
  const hash = sha256(combined);
  const snapshotFile = writeSealSnapshot(storyDir, stage, fileBytes);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Agent seals: hash is computed and recorded, but head does NOT advance until the owner approves
  // Preserve amended_from/amended_at if this is a re-seal after amend
  const amendedMeta = existing?.amended_from
    ? { amended_from: existing.amended_from, amended_at: existing.amended_at }
    : {};
  sh.chain[stage] = { hash, prev, agent_sealed: now, file: args.file, snapshot_file: snapshotFile, ...amendedMeta };
  // stages array populated, head stays at prev until countersign (avoid duplicate on re-seal)
  if (!sh.stages.includes(stage)) sh.stages.push(stage);

  saveStageHashes(storyDir, sh);

  // Write stage + updated_at to meta.json so pipeline queries can trust the
  // story state without re-reading the hash chain.
  try {
    updateMeta(storyDir, { stage: SEALED_STAGE[stage] || `${stage}-sealed`, updated_at: now });
  } catch (e) {
    process.stderr.write(`Warning: could not write updated_at to meta.json: ${e.message}\n`);
  }

  console.log(`Agent sealed stage "${stage}" for story ${storyId}`);
  console.log(`Hash: ${hash.slice(0, 16)}...`);
  console.log('');
  console.log(`Awaiting the owner's countersign to advance. Say "yes" to approve.`);
  // Fire-and-forget Telegram ping so the operator gets a push instead of polling.
  // notify() never throws and never blocks — see scripts/notify.js for rationale.
  notify(
    `📋 Seal pending countersign\n` +
    `Story: ${storyId}\n` +
    `Stage: ${stage}\n` +
    `Hash: ${hash.slice(0, 16)}\n` +
    `To approve: type "yes" in the active conversation, or run:\n` +
    `  node ~/robotdojo/scripts/story-gate.js --approve ${stage} --story ${storyId}`
  ).catch(() => {});
  process.exit(0);
}

const TRUTH_STATEMENTS = {
  framing:  'This framing captures the user intent.\n           The next stage is built against this framing.',
  scope:    'These acceptance criteria are correct, complete, and testable.\n           No build begins without satisfying all of them.',
  research: 'Every research question has a 1:1 answer in this document.',
  plan:     'This plan satisfies every AC with a verifiable execution path.',
  build:    'I have reviewed the machine evidence. Criteria passed. Tests clean.',
  qa:       'QA evidence is real. VERDICT is machine-verified, not prose.',
  close:    'The story is closed. QA passed or the close report names why it did not.',
};

// ── APPROVE (the owner's countersign) ─────────────────────────────────────────────
if (args.approve) {
  const stage = args.approve;
  let sh = loadStageHashes(storyDir);
  if (!sh) {
    console.error('BLOCKED — stage-hashes.json missing.');
    process.exit(1);
  }
  const entry = sh.chain[stage];
  if (!entry) {
    console.error(`BLOCKED — stage "${stage}" not yet agent-sealed. Agent must run --seal first.`);
    process.exit(1);
  }
  if (entry.owner_approved) {
    console.log(`Stage "${stage}" already countersigned by the owner at ${entry.owner_approved}.`);
    process.exit(0);
  }

  if (stage === 'plan') {
    const touchError = planTouchClaimError(storyDir);
    if (touchError) {
      console.error(touchError);
      process.exit(1);
    }
  }

  const truth = TRUTH_STATEMENTS[stage];
  if (truth) {
    console.log(`\nAttesting for stage "${stage}":`);
    console.log(`  "${truth}"\n`);
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  entry.owner_approved = now;
  // Now that both signatures exist, advance the chain head
  sh.head = entry.hash;

  saveStageHashes(storyDir, sh);
  try {
    const patch = { stage: APPROVED_STAGE[stage] || `${stage}-complete`, updated_at: now };
    if (stage === 'close') {
      const meta = readMeta(storyDir);
      if (meta.type === 'work') {
        // Work records are exploratory workbench closes: no story branch, no
        // code to land on origin/main. They stay unconditionally done — the
        // merge-verify done-gate is a story/defect concern (df_0bd64903 scope).
        patch.kanban = 'done';
      } else {
        // df_0bd64903 AC2/AC3 — the gate is the SOLE done-authority for
        // story/defect. "done" is a READ of ground truth (this story's code on
        // origin/main), never an independent write that races the push. Derive
        // kanban from merge-verify: done only if the recorded head_sha (the
        // story-branch tip) is on origin/main; otherwise the loud, distinct
        // `close-unmerged` state. Legacy records without head_sha fall back to
        // the commit-message grep inside isLandedOnMain. fetch:false — close's
        // own push already advanced the local origin/main tracking ref.
        const repoRoot = join(process.env.HOME, 'robotdojo');
        const { landed, method } = isLandedOnMain({
          repoRoot,
          sha: meta.head_sha,
          storyId,
          fetch: false,
        });
        patch.kanban = landed ? 'done' : 'close-unmerged';
        if (landed) {
          console.log(`Merge verified on origin/main (via ${method}) — marking done.`);
        } else {
          process.stderr.write(
            `\n[story-gate] CLOSE-UNMERGED — ${storyId} is sealed but its code is NOT on origin/main ` +
            `(checked via ${method}). Marked "close-unmerged", NOT "done". Land the merge, then re-run ` +
            `--approve close (or run scripts/check-done-merged.js) to promote it once it lands.\n`,
          );
        }
      }
    }
    updateMeta(storyDir, patch);
  } catch (e) {
    process.stderr.write(`Warning: could not write stage to meta.json: ${e.message}\n`);
  }
  asanaSync(storyId);

  if (stage === 'plan') {
    try {
      const meta = JSON.parse(readFileSync(join(storyDir, 'meta.json'), 'utf8'));
      const files = Array.isArray(meta.touches) ? meta.touches : [];
      if (files.length > 0) {
        const repoRoot = join(process.env.HOME, 'robotdojo');
        const { claimBuild } = await import(join(repoRoot, 'lib/active-builds.js'));
        claimBuild({ story_id: storyId, files });
      }
    } catch (e) {
      process.stderr.write(`[story-gate] active-build claim failed (non-fatal): ${e.message}\n`);
    }
  }

  if (stage === 'build') {
    // st_a5baa72c AC3 — record the root-lock approval for any protected file in
    // meta.touches at the BUILD countersign so the commit never stops for a
    // separate root-lock block. Keyed to effectiveBlobSha256 (staged, falling
    // back to committed — st_5e810098 AC4). owner_quote is the build truth-statement
    // the owner just attested to.
    const n = writeRootLockApprovalForBuild(storyId, storyDir, TRUTH_STATEMENTS.build);
    if (n > 0) {
      console.log(`Root-lock approval recorded for ${n} protected file(s) in this story's touch set.`);
    }

    // st_5e810098 AC4/AC5 — auto-retry the deferred commit. Build step 6 defers
    // the commit (instead of attempting-and-failing) when a protected touch is
    // NEEDS APPROVAL; the approval just written above is exactly what unblocks
    // it. If anything is still staged, retry once. Non-fatal: other pre-commit
    // gates (structure, marketing metadata, etc.) can still fail this and leave
    // it deferred — that is an accepted, unrelated residual (Failure manifest).
    if (n > 0) {
      const repoRoot = join(process.env.HOME, 'robotdojo');
      const stillStaged = spawnSync('git', ['-C', repoRoot, 'diff', '--cached', '--quiet']);
      if (stillStaged.status !== 0) {
        // df_0bd64903 AC1 — the gate's OWN commit must not land on the wrong
        // branch either. Assert HEAD is this story's branch before retrying, via
        // the same shared guard build step 6 uses (one definition of "on branch").
        const onBranch = spawnSync('node',
          [siblingScript('story-branch.js'), '--assert', '--story', storyId, '--repo', repoRoot],
          { encoding: 'utf8' });
        if (onBranch.status !== 0) {
          process.stderr.write(`[story-gate] auto-retry commit REFUSED — HEAD is not story ${storyId}'s branch (non-fatal):\n${(onBranch.stderr || '').trim()}\n`);
        } else {
          const commit = spawnSync('git',
            ['-C', repoRoot, 'commit', '-m', `build(${storyId}): seal build stage`],
            { encoding: 'utf8' });
          if (commit.status === 0) {
            console.log('Auto-retry commit landed after the build approval.');
          } else {
            process.stderr.write(`[story-gate] auto-retry commit failed (non-fatal): ${(commit.stderr || commit.stdout || '').trim()}\n`);
          }
        }
      }
    }
  }

  if (stage === 'close') {
    try {
      const repoRoot = join(process.env.HOME, 'robotdojo');
      const { releaseBuild } = await import(join(repoRoot, 'lib/active-builds.js'));
      releaseBuild({ story_id: storyId });
    } catch (e) {
      process.stderr.write(`[story-gate] active-build release failed (non-fatal): ${e.message}\n`);
    }
  }

  console.log(`Countersigned: stage "${stage}" for story ${storyId}`);
  console.log(`Chain head: ${sh.head.slice(0, 16)}...`);
  console.log(`Both signatures recorded — next stage unlocked.`);
  process.exit(0);
}

// ── RECORD-BUNSHIN (persist a stage's Bunshin QC verdict) ────────────────────
// AC19b: the seal of a BUNSHIN_REQUIRED stage requires a matching verdict on
// disk. The producer agent calls this AFTER Bunshin returns PASS and BEFORE
// --seal. The verdict file binds verdict + sha256(artifact bytes Bunshin saw)
// so a later edit to the artifact invalidates the verdict (stale check).
if (args.recordBunshin) {
  const stage = args.recordBunshin;
  if (!args.verdict || !args.file) {
    console.error('--record-bunshin requires --verdict <PASS|FAIL> and --file <artifactPath>');
    process.exit(1);
  }
  if (args.verdict !== 'PASS' && args.verdict !== 'FAIL') {
    console.error(`BLOCKED — --verdict must be PASS or FAIL, got "${args.verdict}".`);
    process.exit(1);
  }
  if (!existsSync(args.file)) {
    console.error(`BLOCKED — artifact file not found: ${args.file}`);
    process.exit(1);
  }
  if (!BUNSHIN_REQUIRED_STAGES.has(stage)) {
    console.error(`BLOCKED — stage "${stage}" is not BUNSHIN_REQUIRED. Allowed: ${[...BUNSHIN_REQUIRED_STAGES].join(', ')}.`);
    process.exit(1);
  }
  const bytes = readFileSync(args.file);
  const artifactSha = sha256(bytes);
  const bunshinDir = join(storyDir, 'bunshin');
  mkdirSync(bunshinDir, { recursive: true });
  const payload = {
    stage,
    verdict: args.verdict,
    artifact_sha256: artifactSha,
    recorded_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  writeFileSync(bunshinVerdictPath(storyDir, stage), JSON.stringify(payload, null, 2) + '\n');
  console.log(`Recorded Bunshin verdict for "${stage}": ${args.verdict}`);
  console.log(`Artifact sha256: ${artifactSha.slice(0, 16)}...`);
  process.exit(0);
}

// ── AMEND (re-open a sealed stage for revision) ──────────────────────────────
if (args.amend) {
  const stage = args.amend;
  let sh = loadStageHashes(storyDir);
  if (!sh) {
    console.error('BLOCKED — stage-hashes.json missing.');
    process.exit(1);
  }
  const entry = sh.chain[stage];
  if (!entry) {
    console.error(`BLOCKED — stage "${stage}" has not been sealed. Nothing to amend.`);
    process.exit(1);
  }
  if (!entry.agent_sealed) {
    console.error(`BLOCKED — stage "${stage}" is a legacy seal (no agent_sealed field). Cannot amend legacy entries.`);
    process.exit(1);
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Record the amendment: preserve prior hash as amended_from, clear both signatures
  entry.amended_from = entry.hash;
  entry.amended_at = now;
  delete entry.agent_sealed;
  delete entry.owner_approved;
  // Roll back chain head to prev so a fresh seal re-advances it
  sh.head = entry.prev;

  saveStageHashes(storyDir, sh);

  console.log(`amendment recorded: stage "${stage}" for story ${storyId}`);
  console.log(`Prior hash preserved as amended_from: ${entry.amended_from.slice(0, 16)}...`);
  console.log(`Both signatures cleared — re-seal and re-approve required.`);
  process.exit(0);
}
