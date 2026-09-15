#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { chromium } from 'playwright';
import { readKeychainSecret } from '../../lib/keychain.js';
import config from '../../lib/config.js';
import { loadProofFixtures } from './proof-fixtures.js';

function arg(name, fallback = '') {
  const eq = process.argv.find((item) => item.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] || fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const baseUrl = (arg('--base', process.env.QA_BASE_URL || `https://localhost:${config.ports.app}`)).replace(/\/+$/, '');
const base = new URL(baseUrl);
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(base.hostname) || base.hostname.endsWith('.localhost');
const budgetMs = Number(arg('--budget-ms', isLocal ? '1000' : '2000'));
const headless = hasFlag('--headless') || !hasFlag('--headed');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(arg('--out', resolve(tmpdir(), 'robotdojo-qa', 'viewer-stable-url-proof', `${base.hostname}-${stamp}`)));
const token = process.env.QA_DOJO_TOKEN
  || process.env.ROBOTDOJO_AUTH_TOKEN
  || readKeychainSecret('ROBOTDOJO_AUTH_TOKEN')
  || '';
const serverName = process.env.QA_SERVER_NAME
  || process.env.ROBOTDOJO_DEVICE_SLUG
  || readKeychainSecret('ROBOTDOJO_DEVICE_SLUG')
  || 'dojo';

// Product-safe cases — real product surfaces present on every deployment, no
// owner entities. The owner-entity proof cases (real person/place/company URLs +
// the owner's institutional prose assertions) live ONLY in the gitignored
// config/qa-proof-fixtures.user.json override; a fresh clone proves product
// surfaces, this box additionally proves the live owner entities.
const PRODUCT_CASES = [
  {
    type: 'agent',
    name: 'agent-miyagi',
    path: '/agents/miyagi',
    must: [/Miyagi/i, /orchestrator|thinking partner|pipeline/i],
  },
  {
    type: 'topic',
    name: 'topic-robot-dojo',
    path: '/topics/robot-dojo',
    must: [/Robot Dojo/i, /product workbench|first-class intelligence surface|local-first personal AI|agent behavior/i],
  },
  {
    type: 'workbench',
    name: 'workbench-robot-dojo',
    path: '/workbenches/topics/work/robot-dojo/wk_robot_dojo',
    must: [/Robot Dojo/i, /Pipeline remains|product work|local-first|agent behavior|Evolution Timeline/i],
  },
];

// Compile an override case's `must` regex-source strings into RegExp.
function compileProofCase(testCase) {
  return {
    ...testCase,
    must: (testCase.must || []).map((m) => (m instanceof RegExp ? m : new RegExp(m, 'i'))),
  };
}

const CASES = [
  ...PRODUCT_CASES,
  ...((loadProofFixtures().stableUrlCases || []).map(compileProofCase)),
];

const FORBIDDEN_GLOBAL = [
  /RDJ_VIEWER_/i,
  /Robot Dojo Viewer did not finish loading/i,
];

const FORBIDDEN_MAIN = [
  /structured data only/i,
  /database readout/i,
  /Low-signal entity/i,
  /Key Contacts/i,
  /\*\*(?:Type|Company|Industry|People|Address):\*\*/i,
  /user\/contexts|memory_projection|source_event_|Source Watermark/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+\d{10,}|\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/,
];

mkdirSync(outDir, { recursive: true });

async function authenticate(context) {
  if (isLocal) return { ok: true, mode: 'bearer' };
  if (!token) return { ok: false, mode: 'relay-token', error: 'missing QA_DOJO_TOKEN/ROBOTDOJO_AUTH_TOKEN' };
  const response = await context.request.post(`${baseUrl}/api/auth/token`, {
    data: { server: serverName, token },
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok()) return { ok: false, mode: 'relay-token', status: response.status(), body: await response.text().catch(() => '') };
  return { ok: true, mode: 'relay-token' };
}

async function waitForHealthyBase(context) {
  const deadline = Date.now() + Number(arg('--ready-timeout-ms', '30000'));
  const readyBudget = Number(arg('--ready-budget-ms', isLocal ? '750' : '1500'));
  let last = null;
  while (Date.now() < deadline) {
    const started = Date.now();
    try {
      const response = await context.request.get(`${baseUrl}/api/server-health`, {
        headers: isLocal && token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const elapsedMs = Date.now() - started;
      last = { status: response.status(), elapsedMs };
      if (response.status() < 500 && elapsedMs <= readyBudget) {
        return { ok: true, status: response.status(), elapsedMs, budgetMs: readyBudget };
      }
    } catch (error) {
      last = { error: error?.message || String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, budgetMs: readyBudget, last };
}

async function waitForViewer(page) {
  await page.waitForFunction(() => {
    const sections = ['current-read', 'working-brief', 'timeline', 'metadata'];
    if (!document.body.classList.contains('app-ready')) return false;
    if (document.querySelector('.viewer-error,[data-error-code]')) return true;
    return sections.every((id) => {
      const el = document.getElementById(id);
      const rect = el?.getBoundingClientRect();
      return rect && rect.width > 120 && rect.height > 40;
    });
  }, null, { timeout: 15_000 });
}

async function collectMetrics(page) {
  return page.evaluate(() => {
    const sectionText = (id) => document.getElementById(id)?.innerText?.trim() || '';
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      url: location.href,
      path: location.pathname,
      title: document.querySelector('.viewer-title-group h1')?.innerText?.trim() || document.title,
      appReady: document.body.classList.contains('app-ready'),
      errorText: [...document.querySelectorAll('.viewer-error,[data-error-code]')].map((el) => el.innerText).join('\n'),
      navLabels: [...document.querySelectorAll('.viewer-nav a')].map((a) => a.textContent.trim()),
      sections: {
        currentRead: sectionText('current-read'),
        workingBrief: sectionText('working-brief'),
        timeline: sectionText('timeline'),
        metadata: sectionText('metadata'),
      },
      bodyText: document.body.innerText,
      navigationMs: nav ? Math.round(nav.duration) : null,
      apiEntries: performance.getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/api/content/docs/'))
        .map((entry) => ({ name: entry.name, duration: Math.round(entry.duration) })),
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

function assertCase(testCase, phase, elapsedMs, metrics) {
  const failures = [];
  const label = `${testCase.name}/${phase}`;
  if (metrics.path.startsWith('/login') || metrics.path.startsWith('/connect')) failures.push(`${label} redirected to login/connect while authenticated`);
  if (!metrics.appReady) failures.push(`${label} body not app-ready`);
  if (elapsedMs > budgetMs) failures.push(`${label} usable render ${elapsedMs}ms > ${budgetMs}ms`);
  if (metrics.scrollWidth > metrics.viewportWidth + 2) failures.push(`${label} horizontal overflow ${metrics.scrollWidth} > ${metrics.viewportWidth}`);
  for (const required of ['1k summary', '4k summary', 'Timeline', 'Metadata']) {
    if (!metrics.navLabels.includes(required)) failures.push(`${label} missing nav ${required}`);
  }
  for (const [key, value] of Object.entries(metrics.sections)) {
    if (!value || value.length < (key === 'metadata' ? 10 : 40)) failures.push(`${label} thin section ${key}`);
  }
  if (!/\d{4}|\bunknown time\b/i.test(metrics.sections.timeline)) failures.push(`${label} timeline missing dated or explicit audit history`);
  for (const re of testCase.must) {
    if (!re.test(metrics.bodyText)) failures.push(`${label} missing known content ${re}`);
  }
  for (const re of FORBIDDEN_GLOBAL) {
    if (re.test(metrics.bodyText) || re.test(metrics.errorText)) failures.push(`${label} forbidden global ${re}`);
  }
  const mainText = [
    metrics.sections.currentRead,
    metrics.sections.workingBrief,
    metrics.sections.timeline,
  ].join('\n');
  for (const re of FORBIDDEN_MAIN) {
    if (re.test(mainText)) failures.push(`${label} forbidden main content ${re}`);
  }
  return failures;
}

async function loadOnce(page, testCase, phase) {
  const started = Date.now();
  let waitFailure = null;
  let metrics = null;
  try {
    await page.goto(`${baseUrl}${testCase.path}`, { waitUntil: 'domcontentloaded' });
    await waitForViewer(page);
    await page.waitForTimeout(80);
    metrics = await collectMetrics(page);
  } catch (error) {
    waitFailure = error?.message || String(error);
    metrics = await collectMetrics(page).catch(() => ({
      url: page.url(),
      path: new URL(page.url(), baseUrl).pathname,
      title: '',
      appReady: false,
      errorText: waitFailure,
      navLabels: [],
      sections: { currentRead: '', workingBrief: '', timeline: '', metadata: '' },
      bodyText: '',
      navigationMs: null,
      apiEntries: [],
      scrollWidth: 0,
      viewportWidth: 0,
    }));
  }
  const elapsedMs = Date.now() - started;
  const screenshot = resolve(outDir, `${testCase.name}-${phase}.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  const failures = assertCase(testCase, phase, elapsedMs, metrics);
  if (waitFailure) failures.unshift(`${testCase.name}/${phase} viewer wait failed: ${waitFailure}`);
  return {
    ...metrics,
    type: testCase.type,
    name: testCase.name,
    phase,
    path: testCase.path,
    elapsedMs,
    screenshot,
    failures,
  };
}

const browser = await chromium.launch({ headless });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: isLocal && token ? { Authorization: `Bearer ${token}` } : undefined,
  viewport: { width: 1440, height: 960 },
});

const auth = await authenticate(context);
const readiness = auth.ok ? await waitForHealthyBase(context) : { ok: false, skipped: true };
const page = await context.newPage();
const consoleFailures = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleFailures.push(msg.text());
});
page.on('pageerror', (error) => consoleFailures.push(error.message));

const rows = [];
const failures = [];
if (!auth.ok) {
  failures.push(`auth failed: ${JSON.stringify(auth)}`);
} else if (!readiness.ok) {
  failures.push(`base readiness failed: ${JSON.stringify(readiness)}`);
} else {
  for (const testCase of CASES) {
    const cold = await loadOnce(page, testCase, 'cold');
    rows.push(cold);
    failures.push(...cold.failures);
    const warm = await loadOnce(page, testCase, 'warm');
    rows.push(warm);
    failures.push(...warm.failures);
  }
}
for (const failure of consoleFailures) {
  if (/RDJ_VIEWER_|SyntaxError|ReferenceError|TypeError/i.test(failure)) failures.push(`console/page error: ${failure}`);
}

await browser.close();

const sampleLinks = CASES.map((item) => `[${item.type}: ${item.name}](${baseUrl}${item.path})`).join('\n');
const timingTable = [
  '| Type | Name | Cold ms | Warm ms | Screenshot |',
  '|---|---:|---:|---:|---|',
  ...CASES.map((item) => {
    const cold = rows.find((row) => row.name === item.name && row.phase === 'cold');
    const warm = rows.find((row) => row.name === item.name && row.phase === 'warm');
    const shot = cold?.screenshot ? basename(cold.screenshot) : '';
    return `| ${item.type} | ${item.name} | ${cold?.elapsedMs ?? ''} | ${warm?.elapsedMs ?? ''} | ${shot} |`;
  }),
].join('\n');
const report = [
  `# Viewer Stable URL Proof`,
  ``,
  `Base: ${baseUrl}`,
  `Auth: ${auth.mode || 'unknown'}`,
  `Readiness: ${readiness.ok ? `${readiness.elapsedMs}ms` : JSON.stringify(readiness)}`,
  `Budget: ${budgetMs}ms usable render`,
  `Screenshots: ${outDir}`,
  ``,
  `## Sample URLs`,
  sampleLinks,
  ``,
  `## Timings`,
  timingTable,
  ``,
  `## Result`,
  failures.length ? failures.map((failure) => `- ${failure}`).join('\n') : 'PASS',
  ``,
].join('\n');

const reportPath = resolve(outDir, 'report.md');
const jsonPath = resolve(outDir, 'results.json');
writeFileSync(reportPath, report, 'utf8');
writeFileSync(jsonPath, JSON.stringify({ baseUrl, auth, readiness, budgetMs, rows, failures, outDir, reportPath }, null, 2), 'utf8');

console.log(report);
console.log(`JSON: ${jsonPath}`);

if (failures.length) process.exit(1);
