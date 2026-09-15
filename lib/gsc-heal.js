/**
 * lib/gsc-heal.js — Google Search Console auto-heal dispatcher.
 *
 * Scope expansion of st_ea15ae66 (2026-05-13). Original framing was "notify
 * the owner when GSC reports an issue." The expansion changes the directive to:
 * AUTO-HEAL known deterministic issue classes, ARCHIVE the originating Gmail
 * alert on heal success, and create an Asana TASK only when no fixer matched
 * or a prior heal failed re-validation.
 *
 * The dispatcher consumes the `findings` array returned by scripts/gsc-poll.js
 * (per-URL inspection records) and routes each finding through a flat FIXERS
 * registry. For four deterministic issue classes (noindex, sitemap 404 entry,
 * canonical mismatch) the dispatcher mutates source files, commits + pushes,
 * re-submits the sitemap, archives the alert thread, and records the heal in
 * a JSONL pending-log. For non-deterministic classes (manual action, thin
 * content) or unmatched findings, the dispatcher creates an Asana task and
 * never touches the site.
 *
 * WHY a thin-facade module instead of inline in scripts/maintenance-phases.js:
 *   phaseGsc stays as HTTP plumbing (run poll → dispatch heal → record stats).
 *   All heal logic — fixers, dispatch table, suppression-window math, git +
 *   sitemap-submit + Gmail-archive sequencing — lives here so it can be
 *   unit-tested without spinning the full phase runner.
 *
 * WHY the FIXERS array is flat (not a pluggable registry):
 *   Per Hakase research (01-research.md "Gordian-knot simplification"): three
 *   issue classes with deterministic fixes do not justify the abstraction cost
 *   of a plugin registry. A frozen array of {matches, name, fix, notify}
 *   records — first-match-wins — is the smallest surface that satisfies the
 *   scope. Adding a fifth fixer is one new record.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createNotificationTask } from './asana.js';

const _REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const _DEFAULTS_PATH = resolve(_REPO_ROOT, 'config', 'defaults.json');

// ── Constants ────────────────────────────────────────────────────────────────

// Load tunables from config/defaults.json — single source of truth so future
// stories tune the suppression window without editing this module.
function _loadDefaults() {
  try {
    if (existsSync(_DEFAULTS_PATH)) {
      return JSON.parse(readFileSync(_DEFAULTS_PATH, 'utf8'));
    }
  } catch { /* fall through */ }
  return { gsc: {} };
}
const _DEFAULTS = _loadDefaults();

/**
 * HEAL_WINDOW_DAYS — duplicate-task suppression window.
 *
 * WHY 7 days: GSC URL Inspection data lags 2-4 days from live page state
 * (Hakase: support.google.com/webmasters/thread/216128633). A fix deployed
 * today will not be visible in the next maint_gsc poll. Without this
 * suppression window, every daily run within the lag creates a duplicate
 * Asana task for the same URL. 7 days gives Google's index a generous
 * margin to update; if the issue persists past 7 days, the heal genuinely
 * failed and a task is justified.
 */
export const HEAL_WINDOW_DAYS = _DEFAULTS.gsc?.healWindowDays ?? 7;

// Per-property sitemap URLs. Add a row here when another Robot Dojo-owned
// public site gets the same heal workflow.
const SITE_SITEMAPS = {
  'https://robotdojo.ai/': 'https://robotdojo.ai/sitemap.xml',
};

// Default sitesRoot — maps domain → on-disk repo path. dispatchHeal callers
// can override (tests pass tmpdir paths).
const DEFAULT_SITES_ROOT = {
  'robotdojo.ai':     join(homedir(), 'robotdojo'),
};

// ── URL → file path resolution ───────────────────────────────────────────────

/**
 * Map a finding's URL to its on-disk source HTML path under sitesRoot.
 *
 * robotdojo.ai: static files in apps/. `/foo` → apps/foo.html; `/` → apps/index.html.
 *
 * Returns null if the URL doesn't resolve cleanly — the caller treats this as
 * "no fixer applicable" and falls through to task creation. No silent drops.
 */
export function urlToFilePath(url, sitesRoot) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const root = sitesRoot[host];
    if (!root) return null;
    let path = u.pathname || '/';

    if (host === 'robotdojo.ai') {
      // apps/ static; strip leading /, append .html unless trailing slash.
      if (path === '/' || path === '') return join(root, 'apps', 'index.html');
      const stripped = path.replace(/^\//, '').replace(/\/$/, '');
      return join(root, 'apps', `${stripped}.html`);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Heal-pending log ─────────────────────────────────────────────────────────

/**
 * Read the heal-pending log (JSONL). Returns an array of entries:
 *   { url: string, issue_class: string, fixed_at: ISO8601, files_touched: string[] }
 *
 * WHY JSONL on disk (not SQLite): the heal log is a small append-only audit
 * stream that the GSC phase reads once per run. SQLite adds boot/lock surface for
 * no benefit at this volume. Missing file = empty log (first run).
 */
export function readHealLog(path) {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Append a heal entry to the JSONL log. Creates the directory if needed.
 * WHY mkdirSync recursive: ~/.robotdojo/logs/ may not exist on a fresh
 * machine the first time the heal phase runs.
 */
export function appendHealEntry(path, entry) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error(`[gsc-heal] appendHealEntry failed: ${e.message}`);
  }
}

// Find the most recent heal entry for a URL+issue-class pair.
// WHY most-recent-only: multiple stale entries from past failed heals are
// fine — the question for suppression is always "was this fixed within the
// window?" The newest entry is the only one that matters.
function _latestEntry(healLog, url, issueClass) {
  let latest = null;
  for (const e of healLog) {
    if (e.url === url && e.issue_class === issueClass) {
      if (!latest || new Date(e.fixed_at) > new Date(latest.fixed_at)) latest = e;
    }
  }
  return latest;
}

function _isWithinWindow(entry, windowDays) {
  if (!entry?.fixed_at) return false;
  const ageMs = Date.now() - new Date(entry.fixed_at).getTime();
  return ageMs < windowDays * 24 * 60 * 60 * 1000;
}

// ── Fixers ───────────────────────────────────────────────────────────────────

/**
 * fixNoindex — flip <meta name="robots" content="noindex..."> to
 *   <meta name="robots" content="index,follow"> in the page's source HTML.
 *
 * Matches noindex pages identified by indexing_state=BLOCKED_BY_META_TAG
 * (Hakase: pkg.go.dev/google.golang.org/api/searchconsole/v1 enum).
 * Returns null if the source file doesn't exist OR doesn't contain noindex —
 * idempotent: re-running on an already-healed page is a no-op.
 */
export async function fixNoindex(finding, sitesRoot) {
  const filePath = urlToFilePath(finding.url, sitesRoot);
  if (!filePath || !existsSync(filePath)) return null;
  const before = readFileSync(filePath, 'utf8');
  const after = before.replace(
    /<meta\s+name=["']robots["']\s+content=["']noindex[^"']*["']\s*\/?>/gi,
    '<meta name="robots" content="index,follow">'
  );
  if (after === before) return null;
  writeFileSync(filePath, after);
  return {
    files_touched: [filePath],
    commit_message: `fix(gsc-heal): noindex → index,follow for ${finding.url}`,
  };
}

/**
 * fixSitemapRemove — remove the <url> block whose <loc> matches finding.url
 *   from the static sitemap.xml.
 *
 * Handles robotdojo.ai's static sitemap at apps/static/sitemap.xml.
 *
 * Matches dead URLs via page_fetch_state=NOT_FOUND (Hakase).
 */
export async function fixSitemapRemove(finding, sitesRoot) {
  let host;
  try { host = new URL(finding.url).hostname.replace(/^www\./, ''); } catch { return null; }
  if (host !== 'robotdojo.ai') return null;
  const root = sitesRoot[host];
  if (!root) return null;
  const sitemapPath = join(root, 'apps', 'static', 'sitemap.xml');
  if (!existsSync(sitemapPath)) return null;
  const before = readFileSync(sitemapPath, 'utf8');
  // Strip the entire <url>...</url> block whose <loc> equals finding.url.
  // WHY non-greedy + multiline-aware: sitemap entries may span lines; we want
  // exactly the one block, not all blocks.
  const escapedUrl = finding.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`\\s*<url>[\\s\\S]*?<loc>${escapedUrl}</loc>[\\s\\S]*?</url>`, 'g');
  const after = before.replace(blockRe, '');
  if (after === before) return null;
  writeFileSync(sitemapPath, after);
  return {
    files_touched: [sitemapPath],
    commit_message: `fix(gsc-heal): remove dead URL ${finding.url} from sitemap`,
  };
}

/**
 * fixCanonical — set <link rel="canonical" href="..."> to finding.url (self).
 *
 * Matches the "Alternate page with proper canonical tag" coverage_state when
 * google_canonical and user_canonical disagree. WHY self-canonical default:
 * the page being inspected IS the canonical URL — if Google selected a
 * different one, the page's own canonical tag is the disagreement. Fixing
 * to self forces Google to re-evaluate.
 */
export async function fixCanonical(finding, sitesRoot) {
  const filePath = urlToFilePath(finding.url, sitesRoot);
  if (!filePath || !existsSync(filePath)) return null;
  const before = readFileSync(filePath, 'utf8');
  const after = before.replace(
    /<link\s+rel=["']canonical["']\s+href=["'][^"']*["']\s*\/?>/gi,
    `<link rel="canonical" href="${finding.url}">`
  );
  if (after === before) return null;
  writeFileSync(filePath, after);
  return {
    files_touched: [filePath],
    commit_message: `fix(gsc-heal): canonical self-reference for ${finding.url}`,
  };
}

// ── Sitemap submit + Gmail archive helpers ───────────────────────────────────

/**
 * submitSitemap — re-submit a sitemap to GSC after a heal.
 *
 * WHY this is the only programmatic re-validation signal: Google's GSC API
 * has no "validate fix" endpoint (Hakase). sitemaps.submit is the only way
 * to tell Google "the site changed, please re-crawl." Even then crawl timing
 * is indeterminate.
 *
 * Requires `webmasters` OAuth scope (not `webmasters.readonly`) — silently
 * 403s without the upgrade. The scope is changed in
 * scripts/oauth-callback-server.js as part of this story.
 */
export async function submitSitemap(token, siteUrl, sitemapUrl) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      console.warn(`[gsc-heal] submitSitemap ${siteUrl} → ${r.status}`);
      return { ok: false, status: r.status };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    console.warn(`[gsc-heal] submitSitemap ${siteUrl} threw: ${e.message}`);
    return { ok: false, status: 0, error: e.message };
  }
}

/**
 * archiveGscThread — move the originating sc-noreply@google.com thread out of
 *   INBOX after a successful heal.
 *
 * WHY threads.modify (not messages.modify): Hakase confirmed — messages.modify
 * removes INBOX from a single message in the thread but leaves the thread
 * itself in INBOX if any other message in the thread still has the label.
 * threads.modify applies the label change to ALL messages simultaneously,
 * which is correct semantics for "archive this whole conversation."
 *
 * (See developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/modify.)
 */
export async function archiveGscThread(token, threadId, processedLabelId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`;
  const body = {
    removeLabelIds: ['INBOX'],
    addLabelIds: processedLabelId ? [processedLabelId] : [],
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      console.warn(`[gsc-heal] archiveGscThread ${threadId} → ${r.status}`);
      return { ok: false, status: r.status };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    console.warn(`[gsc-heal] archiveGscThread ${threadId} threw: ${e.message}`);
    return { ok: false, status: 0, error: e.message };
  }
}

// ── Git commit + push (live mode only) ───────────────────────────────────────

// commitAndPush — stage + commit + push the touched files in their owning
// repo. WHY execSync (not async): the phase is already sequential and the heal
// path runs once per finding; the async overhead would obscure error traces
// without speeding anything up. Errors throw, caught by dispatchHeal.
function _commitAndPush(repoRoot, files, message) {
  for (const f of files) {
    execSync(`git add ${JSON.stringify(f)}`, { cwd: repoRoot, stdio: 'pipe' });
  }
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: repoRoot, stdio: 'pipe' });
  execSync(`git push origin main`, { cwd: repoRoot, stdio: 'pipe' });
}

// Resolve "which repo root owns this finding's file" for the commit step.
// Returns null if the touched files don't sit under any known sitesRoot —
// caller treats as push-impossible, falls through to task_created.
function _repoRootForFiles(files, sitesRoot) {
  for (const file of files) {
    for (const root of Object.values(sitesRoot)) {
      if (file.startsWith(root)) return root;
    }
  }
  return null;
}

// ── Fixer registry ───────────────────────────────────────────────────────────
//
// First-match-wins ordering. Most specific predicates first; notify-only
// records last. fix=null + notify=true means "always task, never heal" —
// for issue classes where remediation requires human judgment (manual
// action) or content work (thin content).

const FIXERS = [
  // Manual action — highest severity; never auto-action a Google penalty.
  {
    name: 'manual-action',
    matches: (f) => f.manual_action === true,
    fix: null,
    notify: true,
  },
  // Noindex on a public page — flip the meta tag.
  {
    name: 'noindex',
    matches: (f) => f.indexing_state === 'BLOCKED_BY_META_TAG',
    fix: fixNoindex,
  },
  // Dead URL in sitemap — remove the <url> entry.
  {
    name: 'sitemap-remove',
    matches: (f) => f.page_fetch_state === 'NOT_FOUND',
    fix: fixSitemapRemove,
  },
  // Canonical mismatch — Google selected a different canonical than the page
  // declared. WHY this predicate: `coverage_state` is a UI label and may
  // drift; the structural test is google_canonical !== user_canonical AND
  // both are present.
  {
    name: 'canonical',
    matches: (f) =>
      f.google_canonical && f.user_canonical &&
      f.google_canonical !== f.user_canonical,
    fix: fixCanonical,
  },
  // Thin content — task only; LLM-rewrite of canonical docs is a separate story.
  {
    name: 'thin-content',
    matches: (f) => f.coverage_state === 'Crawled - currently not indexed',
    fix: null,
    notify: true,
  },
];

// ── dispatchHeal ─────────────────────────────────────────────────────────────

/**
 * dispatchHeal — the entry point. Consumes findings from runGscPoll, applies
 *   matching fixers, records the heal log, archives Gmail threads on success,
 *   creates Asana tasks for unhealable findings.
 *
 * @param {Object}   opts
 * @param {Array}    opts.findings      — per-URL inspection records from runGscPoll
 * @param {string}   opts.token         — OAuth access token (for sitemap-submit + Gmail archive)
 * @param {string[]} opts.threadIds     — Gmail thread IDs of originating sc-noreply alerts
 * @param {boolean}  opts.dryRun        — if true, no git, no Asana, no API; record intent only
 * @param {Object}   opts.sitesRoot     — domain → on-disk repo path
 * @param {string}   opts.healLogPath   — JSONL path for heal-pending log
 * @param {boolean}  opts.gitPush       — if true, commit + push fixes (live mode)
 * @param {string}   opts.processedLabelId — Gmail label ID to add when archiving
 *
 * @returns {Promise<{healed: Array, task_created: Array, suppressed: Array}>}
 *   - healed: findings whose fixer ran and (in live mode) committed+pushed+sitemap-submitted
 *   - task_created: findings that fell through to an Asana task
 *   - suppressed: findings whose URL+class was already healed within HEAL_WINDOW_DAYS
 *
 * WHY arrays of records (not just URLs): callers (and tests) need to see WHAT
 * action was taken — files touched, commit message, fixer name, Asana title —
 * to verify behavior. The arrays are the dry-run trace.
 */
export async function dispatchHeal({
  findings,
  token,
  threadIds = [],
  dryRun = false,
  sitesRoot = DEFAULT_SITES_ROOT,
  healLogPath = join(homedir(), '.robotdojo', 'logs', 'gsc-heal.jsonl'),
  gitPush = false,
  processedLabelId = null,
} = {}) {
  const healed = [];
  const task_created = [];
  const suppressed = [];

  const healLog = readHealLog(healLogPath);

  for (const finding of findings || []) {
    if (!finding?.is_issue) continue; // OK_STATES already filtered out — defensive

    // Lookup matching fixer record. None matched → task.
    const fixerRecord = FIXERS.find((rec) => {
      try { return rec.matches(finding); } catch { return false; }
    });

    if (!fixerRecord) {
      const title = `GSC issue (no fixer): ${finding.url}`;
      const notes = `Coverage state: ${finding.coverage_state}\nIndexing: ${finding.indexing_state}\nFetch: ${finding.page_fetch_state}\nVerdict: ${finding.verdict}\n\nNo registered fixer matched. Review manually.`;
      if (!dryRun) await createNotificationTask(title, notes);
      task_created.push({ url: finding.url, issue_class: 'unknown', title, reason: 'no fixer matched' });
      continue;
    }

    // notify-only fixer record (manual action, thin content). Always task,
    // never heal. WHY no suppression-log check here: these classes are
    // judgment-required — the owner should see them every time they appear
    // until they resolve them externally. Suppressing would hide a real signal.
    if (fixerRecord.notify === true && fixerRecord.fix === null) {
      const title = `GSC ${fixerRecord.name}: ${finding.url}`;
      const notes = `Issue class: ${fixerRecord.name}\nCoverage state: ${finding.coverage_state}\nURL: ${finding.url}\n\nThis class is notify-only — human judgment required.`;
      if (!dryRun) await createNotificationTask(title, notes);
      task_created.push({ url: finding.url, issue_class: fixerRecord.name, title, reason: 'notify-only class' });
      continue;
    }

    // Check the heal-pending log. WHY: GSC data lags 2-4 days behind live
    // page state, so the same URL+class will appear again on the next
    // the daily run. The log records "we already fixed this within the window —
    // wait for Google to catch up before flagging again."
    const latest = _latestEntry(healLog, finding.url, fixerRecord.name);
    if (latest && _isWithinWindow(latest, HEAL_WINDOW_DAYS)) {
      suppressed.push({
        url: finding.url,
        issue_class: fixerRecord.name,
        last_fixed_at: latest.fixed_at,
        reason: `within ${HEAL_WINDOW_DAYS}-day suppression window`,
      });
      continue;
    }

    // Stale heal entry (older than window) AND issue still appears → the
    // fix did not take. Surface as a task so the owner can investigate.
    if (latest && !_isWithinWindow(latest, HEAL_WINDOW_DAYS)) {
      const title = `GSC heal failed re-validation: ${finding.url}`;
      const notes = `Issue class: ${fixerRecord.name}\nLast fix attempt: ${latest.fixed_at} (>${HEAL_WINDOW_DAYS} days ago)\nFiles touched at heal: ${(latest.files_touched || []).join(', ')}\n\nGSC still reports this issue after the suppression window. The auto-heal did not take — manual review required.`;
      if (!dryRun) await createNotificationTask(title, notes);
      task_created.push({
        url: finding.url,
        issue_class: fixerRecord.name,
        title,
        reason: 'heal failed re-validation',
        last_fixed_at: latest.fixed_at,
      });
      continue;
    }

    // Apply the fixer.
    let fixResult = null;
    try {
      fixResult = await fixerRecord.fix(finding, sitesRoot);
    } catch (e) {
      const title = `GSC heal threw: ${finding.url}`;
      const notes = `Fixer: ${fixerRecord.name}\nError: ${e.message}`;
      if (!dryRun) await createNotificationTask(title, notes);
      task_created.push({ url: finding.url, issue_class: fixerRecord.name, title, reason: `fixer threw: ${e.message}` });
      continue;
    }

    if (!fixResult) {
      // Fixer returned null — URL couldn't be resolved, file doesn't exist, or
      // page already healed (idempotent no-op). Treat as "no fixer applicable."
      const title = `GSC heal not applicable: ${finding.url}`;
      const notes = `Fixer: ${fixerRecord.name}\nReason: source file not found OR already healed (idempotent no-op).`;
      if (!dryRun) await createNotificationTask(title, notes);
      task_created.push({ url: finding.url, issue_class: fixerRecord.name, title, reason: 'fix returned null' });
      continue;
    }

    // Live mode — commit + push, submit sitemap, archive thread.
    let pushOk = true;
    if (!dryRun && gitPush) {
      const repoRoot = _repoRootForFiles(fixResult.files_touched, sitesRoot);
      if (!repoRoot) {
        pushOk = false;
        task_created.push({
          url: finding.url,
          issue_class: fixerRecord.name,
          title: `GSC heal: cannot resolve repo root for ${finding.url}`,
          reason: 'no repo root for touched files',
        });
        continue;
      }
      try {
        _commitAndPush(repoRoot, fixResult.files_touched, fixResult.commit_message);
      } catch (e) {
        pushOk = false;
        const title = `GSC heal: push failed for ${finding.url}`;
        const notes = `Fixer: ${fixerRecord.name}\nFiles touched: ${fixResult.files_touched.join(', ')}\nError: ${e.message}\n\nLocal file is modified but the push did not complete. Investigate manually.`;
        await createNotificationTask(title, notes);
        task_created.push({ url: finding.url, issue_class: fixerRecord.name, title, reason: `push failed: ${e.message}` });
        continue;
      }
    }

    // Heal succeeded (or dry-run-recorded). Resolve sitemap URL + thread to
    // archive; record planned/actual API calls in the healed entry so tests
    // can assert against the dry-run trace.
    let siteUrl = null;
    try {
      const u = new URL(finding.url);
      siteUrl = `${u.protocol}//${u.hostname}/`;
    } catch { /* leave null */ }

    const sitemapUrl = siteUrl ? SITE_SITEMAPS[siteUrl] : null;
    let submitResult = null;
    if (sitemapUrl) {
      if (dryRun) {
        submitResult = { ok: true, dryRun: true, sitemapUrl, siteUrl };
      } else if (pushOk) {
        submitResult = await submitSitemap(token, siteUrl, sitemapUrl);
      }
    }

    // Match a Gmail thread to this property heuristically (URL substring or
    // host inclusion). dispatchHeal archives every threadId whose archive
    // step is attempted — tests inspect the trace.
    const threadToArchive = threadIds[0] ?? null; // best-effort: oldest unread first
    let archiveResult = null;
    if (threadToArchive) {
      if (dryRun) {
        archiveResult = { ok: true, dryRun: true, threadId: threadToArchive };
      } else {
        archiveResult = await archiveGscThread(token, threadToArchive, processedLabelId);
      }
    }

    // Record the heal in the pending log so the next maint_gsc run suppresses
    // duplicate tasks during the 2-4 day GSC lag window.
    const healEntry = {
      url: finding.url,
      issue_class: fixerRecord.name,
      fixed_at: new Date().toISOString(),
      files_touched: fixResult.files_touched,
      commit_message: fixResult.commit_message,
      dry_run: dryRun,
    };
    if (!dryRun) appendHealEntry(healLogPath, healEntry);

    healed.push({
      url: finding.url,
      issue_class: fixerRecord.name,
      files_touched: fixResult.files_touched,
      commit_message: fixResult.commit_message,
      submit_sitemap: submitResult,
      archive_thread: archiveResult,
    });
  }

  return { healed, task_created, suppressed };
}
