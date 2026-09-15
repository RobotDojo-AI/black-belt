#!/usr/bin/env node
import vm from 'node:vm';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = Number(limitArg?.split('=')[1] || 50);
const json = process.argv.includes('--json');

function loadViewerInternals() {
  const window = {
    location: { pathname: '/', origin: 'http://viewer.test', href: 'http://viewer.test/' },
    RobotDojoComponents: { markdownHtml: (text) => String(text || '') },
    esc: (value) => String(value ?? ''),
  };
  const context = {
    window,
    document: {
      addEventListener() {},
      body: { classList: { add() {} } },
      getElementById() { return null; },
      title: '',
    },
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    Date,
    console,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(join(repo, 'apps/viewer/app.js'), 'utf8'), context);
  return context.window.RobotDojoViewerInternals;
}

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.history' || entry.name === 'fixtures' || entry.name === 'legacy-duplicates') continue;
      walk(path, predicate, out);
    } else if (predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

function topFiles(paths, n) {
  return paths
    .map((path) => ({ path, size: statSync(path).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, n)
    .map((item) => item.path);
}

function kindForPath(path) {
  const rel = relative(repo, path).replace(/\\/g, '/');
  if (rel.includes('/people/')) return 'people';
  if (rel.includes('/companies/')) return 'companies';
  if (rel.includes('/places/')) return 'places';
  if (rel.includes('/workbenches/')) return 'workbench';
  if (rel.includes('/topics/')) return 'topic';
  return 'document';
}

function same(a, b) {
  return String(a || '').replace(/^#+\s+.+$/gm, '').replace(/\s+/g, ' ').trim().toLowerCase()
    === String(b || '').replace(/^#+\s+.+$/gm, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function timelineNoise(item) {
  const text = `${item.title} ${item.body}`.trim();
  return /chat\.message|memory_events|Invitation:/i.test(text)
    || /^\+?\d[\d\s().-]{8,}$/.test(text);
}

function pointerOrProcessCurrentRead(value) {
  const text = String(value || '').trim();
  return /(?:^|\n)\s*[-*]\s*Workbench:\s+user\/workbenches\//i.test(text)
    || (/^\s*[-*]\s+/.test(text) && ((text.match(/(?:^|\n|\s)\s*[-*]\s+/g) || []).length > 1 || text.length > 240))
    || /^##\s+(Current Question|Open Decisions|Next Action)\b/i.test(text)
    || (text.length < 260 && !/^You use\b/i.test(text) && /newsletters|mailing lists|media digests|market digests/i.test(text))
    || /\bNot relevant:/i.test(text)
    || /\b(resolve|inspect)\b.+\b(workbench|source materials|source roots|topic context)\b/i.test(text)
    || /\bdurable conclusions belong\b/i.test(text)
    || /\bSource of truth for\b/i.test(text)
    || /\bWhen updating:/i.test(text)
    || /pipeline rendering path for compatibility/i.test(text)
    || /(?:~\/robotdojo\/|user\/(?:contexts|workbenches)\/|(?:INDEX|SYNTHESIS|LOG|context)\.md)/i.test(text);
}

function templateSummaryLanguage(value) {
  return /\b(?:this|the) page should\b/i.test(value)
    || /\b(?:the )?4k layer should\b/i.test(value)
    || /\buseful 4k summary should\b/i.test(value)
    || /\bshould eventually\b/i.test(value)
    || /\bstill being distilled\b/i.test(value)
    || /\bshould read like\b/i.test(value)
    || /\bnext useful version should\b/i.test(value);
}

function workbenchMechanics(value) {
  return /Distillation Contract|Canonical target:|Compact context:|Long synthesis:|RAG substrate:|Review threshold:|Minimum Boot|Deep Links|Promote only durable|source notes, datasets, renderings|(?:registered as|remains|is not|not a).{0,80}topic workbench|boot contract|user\/workbenches\/|user\/contexts\//i.test(value);
}

function startsAsBioDespiteRelationship(kind, title, currentRead) {
  if (kind !== 'people') return false;
  const text = String(currentRead || '').replace(/\s+/g, ' ').trim();
  const first = text.slice(0, 220);
  const name = String(title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleFirstBio = new RegExp(`^(?:\\*[^*]{0,180}\\*\\s*)?${name}\\s+(?:is|appears|operates|serves|currently appears)\\b`, 'iu');
  return titleFirstBio.test(first)
    && /(you'?ve known|connected with|connection with|relationship|current active thread|most recent contact|recent contact|near-term|near term|intro|introduction|workshop|trip|call|meeting|follow-up|follow up|proactively shared|reached out|offboarded|last working day|departing|left .*company|moved into a new role)/i.test(text.slice(120));
}

function auditFile(viewer, path) {
  const rel = relative(repo, path).replace(/\\/g, '/');
  const body = readFileSync(path, 'utf8');
  const kind = kindForPath(path);
  const model = viewer.buildViewerPageModel({ kind: kind === 'workbench' || kind === 'topic' ? kind : 'entity', entityType: kind }, body);
  const text = `${model.currentRead}\n${model.workingBrief}`;
  const failures = [];
  if (model.currentRead.trim().length < 80) failures.push('short_current_read');
  if (model.workingBrief.trim().length < 100) failures.push('short_working_brief');
  if (/\*\*(Type|Company|Visits|Address|Industry|People):\*\*|structured data|database (?:row|card|readout)|Low-signal entity/i.test(text)) failures.push('database_card_language');
  if (/\b(?:description|website|funding_stage|total_raised|lead_investors|employee_range|linkedin_url|current_role|twitter):\s/i.test(text)) failures.push('raw_metadata_language');
  if (/\(the user\)/i.test(text)) failures.push('user_label_leak');
	  if (startsAsBioDespiteRelationship(kind, model.title, model.currentRead)) failures.push('bio_first_despite_relationship_signal');
	  if (/memory_projection|source_event_|source_set_hash|projection version|source records|Not relevant:|Continue from the newest source-backed synthesis/i.test(text)) failures.push('source_noise');
  if (/Known since .*Last contact|\|\s*\d+ visits/i.test(text)) failures.push('metadata_line');
  if (/\b(?:around|since|until|on) unknown\b/i.test(text)) failures.push('unknown_date_leak');
  if (/when you dine at restaurants worldwide|Terms apply|How likely are you|Passcode|zoom\.us/i.test(text)) failures.push('artifact_leakage');
  if (kind === 'people' && /currently appears in your network|is present in your network|provisional read|Treat this as/i.test(text)) failures.push('thin_person_database_language');
	  if (kind === 'companies' && /active in your company map|sits in your company map|provisional company read|Treat this as/i.test(text)) failures.push('thin_company_database_language');
  if (kind === 'places' && /is present in your (?:place memory|map)|\ban other\b|as a venue, but/i.test(text)) failures.push('thin_place_database_language');
  if ((kind === 'topic' || kind === 'workbench') && templateSummaryLanguage(text)) failures.push('template_summary_language');
  if ((kind === 'topic' || kind === 'workbench') && workbenchMechanics(text)) failures.push('workbench_mechanics_language');
  if ((kind === 'topic' || kind === 'workbench') && pointerOrProcessCurrentRead(model.currentRead)) failures.push('pointer_process_current_read');
  if (same(model.currentRead, model.workingBrief) && model.workingBrief.trim()) failures.push('duplicate_brief');
  if (model.timeline.some(timelineNoise)) failures.push('timeline_noise');
  return { rel, kind, failures, title: model.title };
}

const viewer = loadViewerInternals();
const candidates = [
  ...topFiles(walk(join(repo, 'user/contexts/people'), (path) => path.endsWith('/context.md')), limit),
  ...topFiles(walk(join(repo, 'user/contexts/companies'), (path) => path.endsWith('/context.md')), limit),
  ...topFiles(walk(join(repo, 'user/contexts/places'), (path) => path.endsWith('/context.md')), limit),
  ...topFiles(walk(join(repo, 'user/contexts/topics'), (path) => path.endsWith('/context.md')), limit),
  ...topFiles(walk(join(repo, 'user/workbenches'), (path) => /\/(?:INDEX|SYNTHESIS)\.md$/.test(path)), limit),
];

const results = candidates.map((path) => auditFile(viewer, path));
const failed = results.filter((result) => result.failures.length);

if (json) {
  console.log(JSON.stringify({ ok: failed.length === 0, checked: results.length, failed }, null, 2));
} else {
  console.log(`context humanity audit: checked ${results.length}, failed ${failed.length}`);
  for (const item of failed.slice(0, 40)) {
    console.log(`- ${item.rel}: ${item.failures.join(', ')}`);
  }
}

if (failed.length) process.exitCode = 1;
