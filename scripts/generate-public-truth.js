#!/usr/bin/env node
/**
 * Generate the public Robot Dojo truth projection.
 *
 * This is a projection, not a product-truth layer. Product facts stay in the
 * canonical docs registered in config/public-truth-sources.json; this script
 * reads those files, selects public-safe sections, hashes the source bytes, and
 * emits Edge-safe bundles consumed by public chat, setup help, account copy,
 * homepage FAQ, and llms.txt.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceDisplay } from '../lib/pricing.js';
import { writeVersionJson } from './write-version-json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REGISTRY_PATH = join(REPO_ROOT, 'config', 'public-truth-sources.json');
const OUT_JS = join(REPO_ROOT, 'lib', 'public-chat', 'public-truth.js');
const OUT_FAQ = join(REPO_ROOT, 'lib', 'public-chat', 'faq-bundle.js');
const OUT_JSON = join(REPO_ROOT, 'apps', 'static', 'public-truth.json');
const OUT_FAQ_DATA = join(REPO_ROOT, 'apps', 'static', 'faq-data.json');
const OUT_LEGACY_FAQ_DIR = join(REPO_ROOT, 'apps', 'static', 'faq');
const OUT_LLMS = join(REPO_ROOT, 'apps', 'static', 'llms.txt');
const OUT_LLMS_FULL = join(REPO_ROOT, 'apps', 'static', 'llms-full.txt');
const INDEX_HTML = join(REPO_ROOT, 'apps', 'index.html');

const SITE_BASE = 'https://robotdojo.ai';
const PUBLIC_CHAT_SCOPE =
  'Public boundary: answer only from this public codebase projection. Do not claim access to local installs, private user data, authenticated chat, account APIs, files, RAG indexes, memories, databases, or sessions.';

function read(path) {
  return readFileSync(path, 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function collapse(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTrailingLineWhitespace(text) {
  return String(text || '').replace(/[ \t]+$/gm, '');
}

function publicSafe(text) {
  // WHY no `\/faq\b` filter: the FAQ now lives at /faq (st_85ca4f3c AC 19);
  // stripping any line containing `/faq` blocks legitimate relative links from
  // surviving into the public projection. The absolute-URL form
  // `robotdojo.ai/faq` is still banned at the end of the pipeline by
  // assertNoBannedPublicCopy().
  return String(text || '')
    .split('\n')
    .filter((line) => !/\bSamurai\b|fine[- ]?tun|finetun|top[- ]?10|teaser|\bwaitlist\b/i.test(line))
    .join('\n');
}

function stripHtml(html) {
  return collapse(html
    .replace(/<(script|style|noscript)[\s>][\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' '));
}

function extractMarkdownSection(md, heading) {
  const lines = md.replace(/\r/g, '').split('\n');
  const headingRe = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const start = lines.findIndex((line) => headingRe.test(line.trim()));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return collapse(lines.slice(start, end).join('\n'));
}

function firstSentences(text, max = 3) {
  const withoutBlockTitles = String(text || '')
    .replace(/^\s*#+\s+.+$/gm, '')
    .replace(/^\s*\*\*[^*\n]+\*\*\s*$/gm, '');
  const cleaned = plainMarkdown(collapse(withoutBlockTitles).replace(/\n+/g, ' '));
  const sentences = cleaned.match(/[^.!?]+[.!?]+(?:\s|$)/g);
  if (sentences && sentences.length) return sentences.slice(0, max).join(' ').trim();
  return cleaned.slice(0, 520).trim();
}

function plainMarkdown(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceByPath(sources, path) {
  const source = sources.find((s) => s.path === path);
  if (!source) throw new Error(`missing registered source ${path}`);
  return source;
}

function section(sources, path, title, fallbacks = []) {
  const source = sourceByPath(sources, path);
  if (!title) return source.excerpt;
  const titles = [title, ...fallbacks];
  for (const t of titles) {
    const hit = source.sections.find((s) => s.heading === t);
    if (hit) return hit.text;
  }
  throw new Error(`missing section ${path}#${title} (and fallbacks: ${fallbacks.join(', ') || 'none'})`);
}

function makeQa({ q, a, category, source }) {
  return { q, a: collapse(a), category, source };
}

function buildSources() {
  const registry = JSON.parse(read(REGISTRY_PATH));
  return registry.sources.map((entry) => {
    const abs = join(REPO_ROOT, entry.path);
    const raw = read(abs);
    const isHtml = entry.path.endsWith('.html');
    const baseText = isHtml ? stripHtml(raw) : collapse(raw);
    const selectedSections = (entry.sections || [])
      .map((heading) => ({ heading, text: extractMarkdownSection(raw, heading) }))
      .filter((s) => s.text);
    const excerpt = selectedSections.length
      ? selectedSections.map((s) => s.text).join('\n\n')
      : baseText.slice(0, entry.path.endsWith('.sh') ? 2500 : 7000);
    return {
      path: entry.path,
      title: entry.title,
      sha256: sha256(raw),
      sections: selectedSections,
      excerpt: collapse(publicSafe(excerpt)),
    };
  });
}

function buildFaq(sources) {
  const productIntro = read(join(REPO_ROOT, 'architecture/product.md')).split('\n\n').slice(1, 3).join('\n\n');
  // st_0c491456 Phase 2c renamed several product/architecture sections. Each
  // call passes a fallback list so the generator keeps working across the
  // schema rewrite without losing public-truth content.
  const launchPromise = section(sources, 'architecture/product.md', 'Launch Promise', ['Promise', 'Launch scope']);
  const coreFlow = section(sources, 'architecture/product.md', 'Core Flow', ['Launch scope', 'What you can do']);
  const productBelts = section(sources, 'architecture/product.md', 'Belts', ['Tiers']);
  const expiry = productBelts.match(/\*\*When Black Belt expires\*\*[\s\S]+$/)?.[0] || productBelts;
  const publicSurface = section(sources, 'architecture/product.md', 'Public Surface', ['What you can do']);
  const firstUser = section(sources, 'architecture/product.md', 'First User To Product', ['First user to product']);
  const archLayers = section(sources, 'architecture/architecture.md', 'Product Layers', ['System shape']);
  const archBelts = section(sources, 'architecture/architecture.md', 'Belts', ['Tier enforcement']);
  const invariants = section(sources, 'architecture/architecture.md', 'Core Invariants', ['Core invariants']);
  const canonical = section(sources, 'architecture/architecture.md', 'Canonical Docs', ['Doc-class homes', 'Data flow']);
  const structure = section(sources, 'architecture/structure.md', 'Directory Contract', ['Top-level directories']);
  const rootFiles = section(sources, 'architecture/structure.md', 'Root Files', ['Root files']);
  const ontology = sourceByPath(sources, 'architecture/ontology.md').excerpt;
  const install = sourceByPath(sources, 'apps/static/install.sh').excerpt;

  // SB7 order (st_85ca4f3c marketing-polish batch):
  // 0  What is Robot Dojo?            (name the thing)
  // 1  Who is Robot Dojo for?         (name the customer)
  // 2  Is this like Garry Tan's GBrain? (key competitive differentiator)
  // 3  What should I connect and import? (the plan, step one)
  // 4  Where does my data live?       (the obvious objection)
  // 5  Do I need a dedicated computer? (the next objection)
  // 6  Is it open source?             (trust signal)
  // 7  How do I install Robot Dojo?   (CTA — last, after objections cleared)
  // 8+ Black Belt + repo/identity/public-chat entries — kept in the corpus
  //    (public-truth.json, faq-bundle, /faq chat) but never rendered in the
  //    homepage top-8 slice and never above the 10-item faq-data.json cut.
  //
  // Every answer is polished SB7 style: lead with the customer's reality,
  // position Robot Dojo as the guide, simple plan, concrete and confident,
  // 2–5 sentences, no jargon, no fluff. Grounded in architecture/product.md
  // + the launch model (White Belt MIT/open, Black Belt source-available/
  // subscription, encrypted zero-knowledge relay, data always the user's,
  // private beta).
  return [
    makeQa({
      q: 'What is Robot Dojo?',
      category: 'product',
      source: 'architecture/product.md',
      a: "Robot Dojo is a personal AI system that actually knows you. Chat with your email, calendar, contacts, and messages unified into one living memory; work in it with research, analyses, and apps on your own data; and build the bigger ideas you’ve always had. All local, on your Mac.",
    }),
    makeQa({
      q: 'Who is Robot Dojo for?',
      category: 'product',
      source: 'architecture/product.md',
      a: "Founders, builders, and entrepreneurs tired of repeating themselves to AI. You already have the context (inbox, calendar, messages, notes), and Robot Dojo turns it into an assistant that remembers you across every session. The private beta is a small, smart cohort installing on a Mac and getting more out of AI than a stock foundation model, with no founder hand-holding.",
    }),
    makeQa({
      q: "Is this like Garry Tan's GBrain?",
      category: 'product',
      source: 'architecture/product.md',
      a: "Similar arc, different audience. GBrain (https://github.com/garrytan/gbrain) is a developer tool: a knowledge graph you or an agent fills by writing markdown pages. Robot Dojo is for non-technical people: more productized, less configuration. It extracts signal from data you already have (email, iMessage, calendar, transcripts, contacts), so you don't write pages; Robot Dojo reads what you already did.",
    }),
    makeQa({
      q: 'What should I connect and import?',
      category: 'install',
      source: 'architecture/product.md',
      a: "Start with the accounts that already know you. Connect Google with one OAuth click for Gmail, Calendar, and Contacts. Grant Full Disk Access on your Mac and Robot Dojo reads your local Apple data: iMessage, Contacts, Calendar, Notes, Photos metadata, Call history, and Mail. Drop a Google Takeout archive or any foundation-model chat exports into your inbox folder for deeper history. The more real context Robot Dojo has, the faster it feels like it knows you.",
    }),
    makeQa({
      q: 'Where does my data live?',
      category: 'privacy',
      source: 'architecture/product.md + architecture/architecture.md',
      a: "On your machine. Always. Robot Dojo runs locally and stores everything on your hardware; the robotdojo.ai servers never see your private data. When you want to reach your instance from another computer or your phone, robotdojo.ai provides an encrypted, zero-knowledge relay: end-to-end encrypted, no cloud storage, and Robot Dojo cannot read what passes through it. Remote access via the relay is a paid Black Belt feature.",
    }),
    makeQa({
      q: 'Do I need a dedicated computer?',
      category: 'install',
      source: 'architecture/product.md',
      a: "No. Robot Dojo runs fine on the Mac you already own. 16GB of RAM is enough on any modern machine. A Mac mini is a better host if you want one, because it stays on whether your laptop is open or not, so the relay is always reachable from another computer or your phone. Move to a dedicated machine any time; nothing locks you in.",
    }),
    makeQa({
      q: 'Is it open source?',
      category: 'product',
      source: 'architecture/product.md + architecture/architecture.md',
      a: "Yes. White Belt is MIT, fully open source, free to read, audit, fork, and run. Black Belt is source-available on a subscription: the code is still public so you can audit every line, and an active subscription unlocks the premium engines and the encrypted relay.",
    }),
    makeQa({
      q: 'How do I install Robot Dojo?',
      category: 'install',
      source: 'architecture/product.md + apps/static/install.sh',
      a: "One command on your Mac: curl -fsSL https://robotdojo.ai/install.sh | bash. Or open the Install modal at the top of robotdojo.ai for the same command. Install takes 10–20 minutes; when the local server is ready, your browser opens to setup.",
    }),
    // Kept in the projection (public-truth contract requires the "Black Belt
    // knows your world" copy), and the launch-tier language test requires the
    // BB blurb to live in faq-data.json (slice 0–10).
    makeQa({
      q: 'What is Black Belt?',
      category: 'belts',
      source: 'architecture/product.md',
      a: 'Black Belt knows your world. It includes White Belt plus entity extraction, enrichment, entity context files, people, places, companies, relationship context, entity-aware chat, premium apps, and premium tool runs. Every install includes Black Belt for 90 days. Then the key expires.',
    }),
    makeQa({
      q: 'What happens when Black Belt expires?',
      category: 'belts',
      source: 'architecture/product.md',
      a: `White Belt knows you locally: ${firstSentences(expiry, 5)}`,
    }),
    makeQa({
      q: 'Which docs are canonical?',
      category: 'repo',
      source: 'architecture/architecture.md + architecture/structure.md',
      a: 'Canonical docs are split by purpose: architecture/product.md says what Robot Dojo is, architecture/architecture.md says how the product is shaped, architecture/structure.md says where things belong, architecture/sitemap.md is generated file inventory, and architecture/ontology.md is generated directory ontology. Product truth changes start in architecture/product.md.',
    }),
    makeQa({
      q: 'Where do files belong in the repo?',
      category: 'repo',
      source: 'architecture/structure.md + architecture/ontology.md',
      a: 'The root stays rare and canonical. Browser code belongs in apps/, reusable business logic in lib/, HTTP handlers in routes/ or api/, operational scripts in scripts/, tests in tests/, and planning artifacts in pipeline/. The generated ontology enforces those boundaries.',
    }),
    makeQa({
      q: 'Does Robot Dojo depend on the first user?',
      category: 'identity',
      source: 'architecture/product.md',
      a: firstSentences(firstUser, 4),
    }),
    makeQa({
      q: 'What can I ask on /faq?',
      category: 'public-chat',
      source: 'architecture/product.md + architecture/architecture.md',
      a: 'Use /faq for product, install, privacy, tier, architecture, repo-structure, and usage questions about Robot Dojo. It is public and bounded to the public Robot Dojo docs corpus.',
    }),
    makeQa({
      q: 'What source files power this answer?',
      category: 'public-chat',
      source: 'config/public-truth-sources.json',
      a: `The projection is generated from registered public-safe sources: ${sources.map((s) => s.path).join(', ')}.`,
    }),
  ];
}

function groupByCategory(faq) {
  const categories = {};
  for (const item of faq) {
    (categories[item.category] ||= []).push({
      q: item.q,
      a: item.a,
      tags: [item.category],
      keywords: item.q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
      source: item.source,
    });
  }
  return categories;
}

function contextFromFaq(faq, category = null) {
  const items = category ? faq.filter((i) => i.category === category) : faq;
  return items.map((i) => `Q: ${i.q}\nA: ${i.a}\nSource: ${i.source}`).join('\n\n');
}

function buildProjection(sources) {
  const faq = buildFaq(sources);
  const hashInput = JSON.stringify(sources.map((s) => ({
    path: s.path,
    sha256: s.sha256,
    excerpt: s.excerpt,
  })));
  const truthVersion = sha256(hashInput).slice(0, 16);
  const sourceCorpus = sources.map((s) => `# ${s.title}\nPath: ${s.path}\nsha256: ${s.sha256}\n\n${s.excerpt}`).join('\n\n---\n\n');
  const system = [
    'You are Miyagi for Robot Dojo public docs chat.',
    'Answer concisely using only the public Robot Dojo truth projection below.',
    'Cite source path names naturally when useful.',
    'If the projection does not support a claim, say it is not covered in the public docs.',
    PUBLIC_CHAT_SCOPE,
  ].join(' ');
  const contextHeader = `Robot Dojo public truth version ${truthVersion}. This projection is generated from canonical docs and registered public-safe source summaries. It is not a second product source of truth.`;
  const baseContext = `${contextHeader}\n\n## Common questions\n\n${contextFromFaq(faq)}\n\n## Registered public sources\n\n${sourceCorpus}`;
  const contexts = {
    'faq-context': { system, context: baseContext },
    ask: { system, context: baseContext },
    core: { system, context: `${contextHeader}\n\n${contextFromFaq(faq)}` },
    'install-guide': { system, context: `${contextHeader}\n\n${contextFromFaq(faq, 'install')}\n\n${sourceByPath(sources, 'apps/static/install.sh').excerpt}` },
    'setup-guide': { system, context: `${contextHeader}\n\n${contextFromFaq(faq, 'install')}\n\n${contextFromFaq(faq, 'privacy')}` },
    'faq-how-it-works': { system, context: `${contextHeader}\n\n${sourceByPath(sources, 'architecture/architecture.md').excerpt}` },
    'faq-privacy': { system, context: `${contextHeader}\n\n${contextFromFaq(faq, 'privacy')}\n\n${section(sources, 'architecture/architecture.md', 'Core Invariants', ['Core invariants'])}` },
    'faq-your-data': { system, context: `${contextHeader}\n\n${contextFromFaq(faq, 'privacy')}` },
    'faq-pricing': { system, context: `${contextHeader}\n\n${contextFromFaq(faq, 'belts')}` },
    'faq-open-source': { system, context: `${contextHeader}\n\n${contextFromFaq(faq, 'product')}\n\n${sourceByPath(sources, 'README.md').excerpt}` },
    'repo-structure': { system, context: `${contextHeader}\n\n${contextFromFaq(faq, 'repo')}\n\n${sourceByPath(sources, 'architecture/structure.md').excerpt}\n\n${sourceByPath(sources, 'architecture/ontology.md').excerpt}` },
  };

  return {
    schema: 'robotdojo.publicTruth.v1',
    truthVersion,
    generatedAt: 'deterministic',
    boundary: PUBLIC_CHAT_SCOPE,
    sourceRegistry: 'config/public-truth-sources.json',
    sources: sources.map(({ path, title, sha256, sections }) => ({
      path,
      title,
      sha256,
      sections: sections.map((s) => s.heading),
    })),
    faq,
    contexts,
  };
}

function jsExport(name, value) {
  return `export const ${name} = ${JSON.stringify(value, null, 2)};`;
}

function writePublicTruthModule(projection) {
  const body = [
    '/**',
    ' * Generated by scripts/generate-public-truth.js — do not edit.',
    ' * Source registry: config/public-truth-sources.json.',
    ' */',
    '',
    jsExport('publicTruth', projection),
    '',
    'export const truthVersion = publicTruth.truthVersion;',
    'export const publicTruthSources = publicTruth.sources;',
    'export const publicTruthFaq = publicTruth.faq;',
    'export const publicTruthContexts = publicTruth.contexts;',
    '',
  ].join('\n');
  writeFileSync(OUT_JS, body, 'utf8');
}

function writeFaqBundle(projection) {
  const categories = groupByCategory(projection.faq);
  const coreFaq = {
    version: projection.truthVersion,
    generated: projection.generatedAt,
    system: projection.contexts.core.system,
    context_header: `Robot Dojo public truth version ${projection.truthVersion}.`,
    categories,
  };
  const context = (name) => projection.contexts[name] || projection.contexts['faq-context'];
  const parts = [
    '/**',
    ' * Generated by scripts/generate-public-truth.js — do not edit.',
    ' * Compatibility exports for consumers that still import faq-bundle.js.',
    ' */',
    '',
    jsExport('coreFaq', coreFaq),
    jsExport('faqContext', context('faq-context')),
    jsExport('faqHowItWorks', context('faq-how-it-works')),
    jsExport('faqOpenSource', context('faq-open-source')),
    jsExport('faqPricing', context('faq-pricing')),
    jsExport('faqPrivacy', context('faq-privacy')),
    jsExport('faqYourData', context('faq-your-data')),
    jsExport('installGuide', context('install-guide')),
    jsExport('setupGuide', context('setup-guide')),
    '',
  ];
  writeFileSync(OUT_FAQ, parts.join('\n'), 'utf8');
}

function writeFaqData(projection) {
  const faqData = projection.faq.slice(0, 10).map(({ q, a, category, source }) => ({ q, a, category, source, truthVersion: projection.truthVersion }));
  writeFileSync(OUT_FAQ_DATA, JSON.stringify(faqData, null, 2) + '\n', 'utf8');
}

function writeLegacyFaqJson(projection) {
  mkdirSync(OUT_LEGACY_FAQ_DIR, { recursive: true });
  const context = (name) => projection.contexts[name] || projection.contexts['faq-context'];
  const packs = {
    'core.json': {
      version: projection.truthVersion,
      generated: projection.generatedAt,
      system: projection.contexts.core.system,
      context_header: `Robot Dojo public truth version ${projection.truthVersion}. Generated from canonical docs; not source truth.`,
      categories: groupByCategory(projection.faq),
    },
    'faq-context.json': context('faq-context'),
    'faq-how-it-works.json': context('faq-how-it-works'),
    'faq-open-source.json': context('faq-open-source'),
    'faq-pricing.json': context('faq-pricing'),
    'faq-privacy.json': context('faq-privacy'),
    'faq-your-data.json': context('faq-your-data'),
    'install-guide.json': context('install-guide'),
    'setup-guide.json': context('setup-guide'),
  };
  for (const [name, data] of Object.entries(packs)) {
    writeFileSync(join(OUT_LEGACY_FAQ_DIR, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Special-case renderers for homepage FAQ answers that need real links.
// The plain-text answer (item.a) stays correct for LLM system-prompt + JSON
// outputs; only the homepage HTML render swaps in `<a>` tags. WHY here, not in
// the answer string: the LLM context must stay plain text (no HTML noise in
// the model's working corpus), and the JSON outputs must stay safe for any
// downstream renderer. The mapping is deterministic and the input is the
// generator's own output, so there is no XSS vector.
function homepageAnswerHtml(item) {
  if (item.q === "Is this like Garry Tan's GBrain?") {
    return [
      "Similar arc, different audience. ",
      '<a href="https://github.com/garrytan/gbrain" target="_blank" rel="noopener noreferrer">GBrain</a>',
      " is a developer tool: a knowledge graph you or an agent fills by writing markdown pages. Robot Dojo is for non-technical people: more productized, less configuration. It extracts signal from data you already have (email, iMessage, calendar, transcripts, contacts), so you don&#39;t write pages; Robot Dojo reads what you already did.",
    ].join('');
  }
  if (item.q === 'How do I install Robot Dojo?') {
    return [
      'One command on your Mac: <code>curl -fsSL https://robotdojo.ai/install.sh | bash</code>. Or ',
      '<a href="#" data-modal="install">open the Install modal</a>',
      ' for the same command. Install takes 10&ndash;20 minutes; when the local server is ready, your browser opens to setup.',
    ].join('');
  }
  return escapeHtml(item.a);
}

const INDEX_FAQ_START = '      <div class="m-faq">\n';
const INDEX_FAQ_END = '\n      </div>\n      <p class="m-faq-more">';

// Strip the generator-owned homepage regions (FAQ block + Black Belt price
// stamps) so a working-tree delta can be classified as "projection only"
// versus a hand-authored marketing-copy edit.
export function stripIndexHtmlGeneratorOwned(html) {
  let next = String(html || '');
  const start = next.indexOf(INDEX_FAQ_START);
  const contentStart = start === -1 ? -1 : start + INDEX_FAQ_START.length;
  const end = contentStart === -1 ? -1 : next.indexOf(INDEX_FAQ_END, contentStart);
  if (start !== -1 && end !== -1) {
    next = next.slice(0, contentStart) + next.slice(end);
  }
  return next.replace(/(<span data-price-belt="black">)[^<]*(<\/span>)/g, '$1</span>');
}

export function indexHtmlDiffIsGeneratorOwned(headHtml, workHtml) {
  return stripIndexHtmlGeneratorOwned(headHtml) === stripIndexHtmlGeneratorOwned(workHtml);
}

function writeHomepageFaq(projection) {
  // Homepage no longer ships a FAQ accordion. Keep this as a no-op when the
  // markers are absent so a regenerate cannot fail the Vercel marketing build.
  const html = read(INDEX_HTML);
  const startToken = INDEX_FAQ_START;
  const start = html.indexOf(startToken);
  if (start === -1) return;
  const faqHtml = projection.faq.slice(0, 8).map((item) => [
    `        <details class="m-faq-item" data-truth-version="${projection.truthVersion}" data-source="${escapeHtml(item.source)}">`,
    `          <summary>${escapeHtml(item.q)}</summary>`,
    `          <p>${homepageAnswerHtml(item)}</p>`,
    '        </details>',
  ].join('\n')).join('\n\n');
  const contentStart = start + startToken.length;
  const endToken = INDEX_FAQ_END;
  const end = html.indexOf(endToken, contentStart);
  if (end === -1) throw new Error('failed to find homepage FAQ end');
  const next = html.slice(0, contentStart) + faqHtml + html.slice(end);
  writeFileSync(INDEX_HTML, next, 'utf8');
}

function writeHomepageTruthVersion(projection) {
  const html = read(INDEX_HTML);
  const next = html.replace(
    /(<meta name="public-truth-version" content=")[^"]*(")/,
    `$1${projection.truthVersion}$2`,
  );
  if (next === html && !/name="public-truth-version"/.test(html)) {
    throw new Error('failed to find homepage public-truth-version meta');
  }
  writeFileSync(INDEX_HTML, next, 'utf8');
}

function writeBeltPrice() {
  // Stamp every data-price-belt="black" span in index.html from the pricing
  // SSOT (lib/pricing.js), same build-time-projection pattern as the FAQ.
  const html = read(INDEX_HTML);
  const price = escapeHtml(priceDisplay('black'));
  const next = html.replace(
    /(<span data-price-belt="black">)[^<]*(<\/span>)/g,
    (_match, open, close) => `${open}${price}${close}`,
  );
  writeFileSync(INDEX_HTML, next, 'utf8');
}

function writeLlms(projection) {
  const lines = [
    '# Robot Dojo',
    '',
    '> Local-first personal intelligence. Chat is the hero. Context is the product.',
    '',
    `Public truth version: ${projection.truthVersion}. Generated from ${projection.sourceRegistry}.`,
    '',
    'Robot Dojo is a local-first personal intelligence system. White Belt knows you. Black Belt knows your world. Every install includes Black Belt for 90 days; if Black Belt expires, premium engines pause while user-owned local artifacts remain local.',
    '',
    '## Ask',
    '',
    `- [Public docs chat](${SITE_BASE}/ask): Public Robot Dojo product, install, privacy, tier, architecture, and repo-structure questions.`,
    '',
    '## Canonical Sources',
    '',
  ];
  for (const source of projection.sources) {
    lines.push(`- [${source.title}](${SITE_BASE}/): ${source.path} sha256=${source.sha256}`);
  }
  lines.push('');
  lines.push('## Common Questions');
  lines.push('');
  for (const item of projection.faq.slice(0, 10)) {
    lines.push(`- ${item.q}: ${item.a}`);
  }
  lines.push('');
  writeFileSync(OUT_LLMS, stripTrailingLineWhitespace(lines.join('\n')), 'utf8');

  const full = [
    '# Robot Dojo — Full Public Truth Projection',
    '',
    `truthVersion: ${projection.truthVersion}`,
    '',
    projection.boundary,
    '',
    '## FAQ',
    '',
    projection.faq.map((i) => `### ${i.q}\nSource: ${i.source}\n\n${i.a}`).join('\n\n'),
    '',
    '## Contexts',
    '',
    Object.entries(projection.contexts).map(([name, ctx]) => `### ${name}\n\n${ctx.context}`).join('\n\n---\n\n'),
    '',
  ].join('\n');
  const cleanFull = stripTrailingLineWhitespace(full);
  writeFileSync(OUT_LLMS_FULL, cleanFull, 'utf8');
}

// Banned launch-copy patterns. Exported (with the pure matcher below) so the
// safety assertion is unit-testable without fixturing the whole generator
// (st_a5baa72c AC2 — the de-tax must NOT swallow this throw).
export const BANNED_PUBLIC_COPY_PATTERNS = [
  /\bSamurai\b/i,
  /fine[- ]?tun/i,
  /top[- ]?10/i,
  /teaser/i,
  /robotdojo\.ai\/faq/i,
];

// Pure: return the banned patterns that match `text` (empty array = clean).
export function bannedPublicCopyMatches(text) {
  return BANNED_PUBLIC_COPY_PATTERNS.filter((re) => re.test(text));
}

function assertNoBannedPublicCopy(projection) {
  const text = JSON.stringify(projection) + read(OUT_LLMS) + read(OUT_LLMS_FULL);
  const banned = bannedPublicCopyMatches(text);
  if (banned.length) {
    throw new Error(`public truth contains banned launch copy: ${banned.map(String).join(', ')}`);
  }
}

export function main() {
  const sources = buildSources();
  const projection = buildProjection(sources);
  writePublicTruthModule(projection);
  writeFaqBundle(projection);
  writeFaqData(projection);
  writeLegacyFaqJson(projection);
  writeHomepageFaq(projection);
  writeHomepageTruthVersion(projection);
  writeBeltPrice();
  writeFileSync(OUT_JSON, JSON.stringify(projection, null, 2) + '\n', 'utf8');
  writeLlms(projection);
  const version = writeVersionJson();
  assertNoBannedPublicCopy(projection);
  console.log(`wrote public truth ${projection.truthVersion}`);
  console.log(`wrote version ${version.manifest.build_id}`);
}

// Run main() when invoked directly. Compare REAL paths, not the raw
// import.meta.url vs argv[1] strings: on macOS a temp/symlinked checkout
// (e.g. /var/folders → /private/var/folders, as the generator-drift test's
// `git clone --local` clone uses) canonicalizes one side but not the other,
// so the naive string compare silently fails and main() never runs — turning
// any freshness guard built on this generator into a no-op (st_fdd414de).
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
})();
if (invokedDirectly) {
  main();
}
