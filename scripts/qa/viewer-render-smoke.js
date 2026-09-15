#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { viewerTopicLensForInjection } from '../../lib/viewer-topic-lens.js';
import { loadProofFixtures } from './proof-fixtures.js';

const repo = resolve(import.meta.dirname, '../..');
const headless = process.argv.includes('--headless') || !process.argv.includes('--headed');
const outDir = resolve(tmpdir(), 'robotdojo-qa', 'viewer-render-smoke');
const baseUrl = 'http://viewer.test';
const indexHtmlPath = resolve(repo, 'apps/viewer/index.html');
// Injected into the served index.html so the viewer renders the owner's per-topic
// lens exactly as lib/server.js serveViewerHtml does in production. Empty on a
// fresh clone → the tracked generic fallbacks render.
const topicLensScript = `<script>window.RobotDojoTopicLens=${JSON.stringify(viewerTopicLensForInjection()).replace(/</g, '\\u003c')};</script>`;

const MIME = {
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

// Synthetic placeholder cases — fully self-contained, no owner entities. Real
// owner-entity proof cases (which read live user/contexts files and assert the
// owner's institutional prose) come from the gitignored
// config/qa-proof-fixtures.user.json override and render via the injected lens.
const SYNTHETIC_CASES = [
  {
    name: 'person-jordan',
    path: '/people/jordan-zeplain--a1b2c3d4e5f60718',
    apiPath: '/api/content/docs/entities/people/jordan-zeplain--a1b2c3d4e5f60718',
    payload: {
      kind: 'entity',
      entityType: 'people',
      title: 'Jordan Zeplain',
      body: '# Jordan Zeplain\n\n## Summary\n\nYou know Jordan through a curated intro list and an Austin trip thread. The current active thread is whether Jordan can route a workshop introduction.\n\n## Working Brief\n\nThe deeper relationship read is that Jordan is useful because the next action is specific: decide whether the intro is worth asking for now.\n',
    },
    must: [/curated intro list|Austin trip/i, /deeper relationship read|current active thread|relationship/i],
  },
  {
    name: 'company-synthetic',
    path: '/companies/acme-robotics--c0ffee00c0ffee01',
    apiPath: '/api/content/docs/entities/companies/acme-robotics--c0ffee00c0ffee01',
    payload: {
      kind: 'entity',
      entityType: 'companies',
      title: 'Acme Robotics',
      body: '# Acme Robotics\n\n## Summary\n\n**Vertical:** Robotics\n\n**Owner fit:** VP of Commercial Operations for pilot-to-contract warehouse deployments.\n\n**Technical bet:** Modular warehouse robots paired with operations software.\n',
    },
    must: [/Acme Robotics|Commercial Operations|robotics/i],
  },
  {
    name: 'place-synthetic',
    path: '/places/harbor-cafe--c0ffee00c0ffee02',
    apiPath: '/api/content/docs/entities/places/harbor-cafe--c0ffee00c0ffee02',
    payload: {
      kind: 'entity',
      entityType: 'places',
      title: 'Harbor Cafe',
      body: '# Harbor Cafe\n\n## Summary\n\nYou have a place trace for Harbor Cafe.\n\nYou have one known place trace, most recently around Jun 5, 2026.\n\nThe source tags it as a restaurant, but the page does not yet have enough surrounding context to say what it meant.\n',
    },
    must: [/Harbor Cafe|place trace|surrounding/i],
  },
  {
    name: 'topic-robot-dojo',
    path: '/topics/work/robot-dojo',
    apiPath: '/api/content/docs/topics/work/robot-dojo',
    payload: {
      kind: 'topic',
      title: 'Robot Dojo',
      body: '# Robot Dojo\n\n## Latest State\n\n- registered as a topic workbench.\n',
    },
    must: [/product workbench|first-class intelligence surface/i, /1k summary/i],
  },
  {
    name: 'workbench-project-alpha',
    path: '/workbenches/topics/work/project-alpha/wk_project_alpha',
    apiPath: '/api/content/docs/workbenches/topics/work/project-alpha/wk_project_alpha',
    payload: {
      kind: 'workbench',
      title: 'Project Alpha',
      body: '# Project Alpha\n\n## Current Read\n\nProject Alpha is the active workbench for a synthetic launch project. It separates useful launch decisions from folder mechanics.\n\n## Working Brief\n\nThe deeper read is that Project Alpha needs stable rendering, readable summaries, and a timeline that helps the owner act.\n\n## Timeline\n\n- 2026-06-23: Synthetic launch milestone captured.\n',
    },
    must: [/Project Alpha|synthetic launch project|stable rendering/i, /Timeline/i],
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
  ...SYNTHETIC_CASES,
  ...((loadProofFixtures().renderCases || []).map(compileProofCase)),
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 960 },
  { name: 'mobile', width: 390, height: 844 },
];

const FORBIDDEN = [
  /Robot Dojo Viewer did not finish loading/i,
  /RDJ_VIEWER_/i,
  /contenteditable|viewer-editor/i,
  /\*\*(?:Type|Company|Industry|People|Address):\*\*/i,
  /structured data only|database readout|Low-signal entity/i,
  /Key Contacts/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+\d{10,}|\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/,
  /user\/contexts|user\/workbenches|memory_projection|source_event_/i,
];

function assetPath(pathname) {
  if (pathname === '/' || !extname(pathname)) return resolve(repo, 'apps/viewer/index.html');
  if (pathname.startsWith('/viewer/')) return resolve(repo, 'apps/viewer', pathname.slice('/viewer/'.length));
  if (pathname.startsWith('/static/')) return resolve(repo, 'apps/static', pathname.slice('/static/'.length));
  if (pathname === '/favicon.svg') return resolve(repo, 'apps/static/favicon.svg');
  return null;
}

function payloadFor(apiPath) {
  const item = CASES.find((testCase) => testCase.apiPath === apiPath);
  if (!item) return null;
  return {
    ...item.payload,
    body: item.payload.body || readFileSync(resolve(repo, item.payload.bodyPath), 'utf8'),
  };
}

function contentType(pathname) {
  return MIME[extname(pathname).toLowerCase()] || 'text/plain';
}

async function installRoutes(page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/whoami') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ belt: 'black' }) });
      return;
    }
    if (url.pathname === '/api/warm' || url.pathname === '/api/apps') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname === '/api/apps' ? [] : { ok: true }) });
      return;
    }
    if (url.pathname.startsWith('/api/content/docs/')) {
      const payload = payloadFor(url.pathname);
      await route.fulfill({
        status: payload ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(payload || { error: 'not_found' }),
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    const filePath = assetPath(url.pathname);
    if (filePath && existsSync(filePath)) {
      if (filePath === indexHtmlPath) {
        const html = readFileSync(filePath, 'utf8').replace('</head>', `${topicLensScript}\n</head>`);
        await route.fulfill({ contentType: 'text/html', body: html });
        return;
      }
      await route.fulfill({ path: filePath, contentType: contentType(filePath) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: `missing ${url.pathname}` });
  });
}

async function renderedMetrics(page) {
  return page.evaluate(() => {
    const selectors = [
      '.viewer-shell',
      '.viewer-hero',
      '.viewer-left-nav',
      '.viewer-document',
      '#current-read',
      '#working-brief',
      '#timeline',
    ];
    const boxes = Object.fromEntries(selectors.map((selector) => {
      const el = document.querySelector(selector);
      const rect = el?.getBoundingClientRect();
      return [selector, rect ? {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
      } : null];
    }));
    const links = [...document.querySelectorAll('.viewer-nav a')].map((a) => a.textContent.trim());
    const sections = [...document.querySelectorAll('.viewer-section')].map((section) => {
      const rect = section.getBoundingClientRect();
      return { id: section.id, width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    const appScrollRoot = document.querySelector('#mainArea') || document.querySelector('.main');
    const title = document.querySelector('.viewer-title-group h1');
    const read = document.querySelector('#current-read .viewer-prose, #current-read .rd-prose');
    const rootScrollHeight = document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight;
    const rootClientHeight = document.scrollingElement?.clientHeight || window.innerHeight;
    const appScrollHeight = appScrollRoot?.scrollHeight || 0;
    const appClientHeight = appScrollRoot?.clientHeight || 0;
    if (appScrollRoot) {
      appScrollRoot.scrollTop = 160;
    }
    const appScrolled = appScrollRoot ? appScrollRoot.scrollTop > 0 : false;
    return {
      appReady: document.body.classList.contains('app-ready'),
      bodyOpacity: Number.parseFloat(getComputedStyle(document.body).opacity || '1'),
      titleColor: title ? getComputedStyle(title).color : '',
      readColor: read ? getComputedStyle(read).color : '',
      errorCount: document.querySelectorAll('.viewer-error,[data-error-code]').length,
      text: document.body.innerText,
      scrollHeight: Math.max(rootScrollHeight, appScrollHeight),
      viewportHeight: Math.max(rootClientHeight, appClientHeight || window.innerHeight),
      appScrolled,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      boxes,
      links,
      sections,
    };
  });
}

function assertRendered(caseName, viewportName, metrics, must) {
  const failures = [];
  const label = `${caseName}/${viewportName}`;
  if (!metrics.appReady) failures.push(`${label} body not app-ready`);
  if (metrics.bodyOpacity < 0.99) failures.push(`${label} body opacity not settled ${metrics.bodyOpacity}`);
  if (metrics.errorCount) failures.push(`${label} rendered viewer error`);
  if (metrics.scrollWidth > metrics.viewportWidth + 2) failures.push(`${label} horizontal overflow ${metrics.scrollWidth} > ${metrics.viewportWidth}`);
  if (metrics.scrollHeight <= metrics.viewportHeight + 120 || !metrics.appScrolled) failures.push(`${label} no meaningful vertical scroll`);
  for (const selector of ['.viewer-shell', '.viewer-hero', '.viewer-document', '#current-read', '#working-brief', '#timeline']) {
    const box = metrics.boxes[selector];
    if (!box || box.width < 120 || box.height < 20) failures.push(`${label} missing/collapsed ${selector}`);
  }
  if (!metrics.links.includes('1k summary') || !metrics.links.includes('4k summary') || !metrics.links.includes('Timeline')) {
    failures.push(`${label} missing left/nav section links`);
  }
  for (const section of metrics.sections) {
    if (section.width < 120 || section.height < 80) failures.push(`${label} collapsed section ${section.id}`);
  }
  for (const re of must) {
    if (!re.test(metrics.text)) failures.push(`${label} missing ${re}`);
  }
  for (const re of FORBIDDEN) {
    if (re.test(metrics.text)) failures.push(`${label} forbidden ${re}`);
  }
  return failures;
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
await installRoutes(page);

const failures = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') failures.push(`console ${msg.text()}`);
});
page.on('pageerror', (error) => failures.push(`pageerror ${error.message}`));

for (const viewport of VIEWPORTS) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  for (const testCase of CASES) {
    await page.goto(`${baseUrl}${testCase.path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('app-ready'), null, { timeout: 8000 });
    await page.waitForSelector('#timeline', { timeout: 8000 });
    await page.waitForTimeout(140);
    const metrics = await renderedMetrics(page);
    failures.push(...assertRendered(testCase.name, viewport.name, metrics, testCase.must));
    await page.screenshot({ path: resolve(outDir, `${testCase.name}-${viewport.name}.png`), fullPage: true });
  }
}

await browser.close();

if (failures.length) {
  console.error(`viewer render smoke FAIL screenshots=${outDir}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`viewer render smoke PASS pages=${CASES.length} viewports=${VIEWPORTS.length} screenshots=${outDir}`);
