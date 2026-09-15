#!/usr/bin/env node
/**
 * check-self-audit-section.js — st_43221114 AC 16.
 *
 * Asserts an artifact contains a `## 10/10 self-audit` section with three
 * answered sub-questions:
 *   Q1. What does 10/10 look like for this artifact?
 *   Q2. What is the gap between 10/10 and what is shipping?
 *   Q3. Owner's waiver.
 *
 * Rejects:
 *   (a) Q1 with a bare single-word generic answer ("good", "complete", "shipped").
 *   (b) Q2 "none" alongside a Q1 that's also vacuous (no real strongest-version-check
 *       articulation surfaced).
 *   (c) Q2 names a gap but Q3 has no `>` blockquote.
 *   (d) Q3 blockquote does not mention a keyword from the gap (waiver must
 *       address the gap, not a generic "ship it").
 *
 * Usage:
 *   node check-self-audit-section.js --file <artifact-path>
 *
 * Exit 0 = gate passes; exit 1 = gate fails with specific diagnostic.
 */
import { readFileSync, existsSync } from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--file') out.file = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`FAIL — ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv);
if (!args.file) fail('--file <path> required');
if (!existsSync(args.file)) fail(`file not found: ${args.file}`);

const body = readFileSync(args.file, 'utf8');

// (a) Section heading present.
const sectionRegex = /\n## 10\/10 self-audit\b/;
if (!sectionRegex.test(body)) {
  fail(`missing '## 10/10 self-audit' section in ${args.file}`);
}

// Extract section body: from heading to next `## ` (or end of file, or `---`
// divider at column 0).
const start = body.search(sectionRegex);
const after = body.slice(start);
let endRel = after.slice(1).search(/\n## /);
let dividerRel = after.slice(1).search(/\n---\n/);
const endIndex = (() => {
  const candidates = [endRel, dividerRel].filter(n => n >= 0);
  if (candidates.length === 0) return after.length;
  return 1 + Math.min(...candidates);
})();
const sectionBody = after.slice(0, endIndex);

// Locate the three answer regions. The convention from the scope:
//   > **What does 10/10 look like for this artifact?**
//   > <answer text, possibly multi-line, prefixed with `>`>
//   >
//   > **What is the gap between 10/10 and what is shipping?**
//   > <answer>
//   >
//   > **Owner's waiver:**
//   > <quoted blockquote>
//
// Both bold-question and blockquote forms are accepted. We split on the three
// question markers and inspect the prose between them.
const Q1_MARKER = /What does 10\/10 look like/i;
const Q2_MARKER = /What is the gap/i;
const Q3_MARKER = /(owner'?s? waiver|waiver:?)\b/i;

const q1Idx = sectionBody.search(Q1_MARKER);
const q2Idx = sectionBody.search(Q2_MARKER);
const q3Idx = sectionBody.search(Q3_MARKER);
if (q1Idx === -1) fail(`Q1 'What does 10/10 look like' not found in self-audit section of ${args.file}`);
if (q2Idx === -1) fail(`Q2 'What is the gap' not found in self-audit section of ${args.file}`);
if (q3Idx === -1) fail(`Q3 waiver marker not found in self-audit section of ${args.file}`);

const q1Body = sectionBody.slice(q1Idx, q2Idx);
const q2Body = sectionBody.slice(q2Idx, q3Idx);
const q3Body = sectionBody.slice(q3Idx);

// Strip the marker line from each body to inspect the answer text only.
function stripMarkerLine(t) {
  // remove the first line containing the marker
  return t.replace(/^[^\n]*\n/, '');
}
const q1Answer = stripMarkerLine(q1Body).trim();
const q2Answer = stripMarkerLine(q2Body).trim();
const q3Answer = stripMarkerLine(q3Body).trim();

if (!q1Answer) fail(`Q1 answer empty in ${args.file}`);
if (!q2Answer) fail(`Q2 answer empty in ${args.file}`);
if (!q3Answer) fail(`Q3 answer empty in ${args.file}`);

// (a) Q1 vacuous-word rejection.
// Strip blockquote chars and whitespace, look at the first real "answer text"
// — if it's purely one of the banned words (or restates that with `complete.` /
// `good.` and nothing else), fail.
const q1Plain = q1Answer.replace(/^[>\s]+/gm, '').trim();
const VACUOUS = /^(good|complete|shipped|done|great|fine|ok|excellent)[\.\!\?\s]*$/i;
if (VACUOUS.test(q1Plain)) {
  fail(`Q1 answer is vacuous ("${q1Plain.slice(0, 32)}..."): name what 10/10 looks like for this artifact specifically, not a single-word generic. ${args.file}`);
}
// Also require some substantive length — at least 40 chars of non-whitespace.
if (q1Plain.replace(/\s+/g, '').length < 40) {
  fail(`Q1 answer too thin (<40 non-whitespace chars): ${args.file}`);
}

// (b/c/d) Gap analysis.
const q2Plain = q2Answer.replace(/^[>\s]+/gm, '').trim();
const q2NoGap = /^(no gap|none|n\/a|no gaps)[\.\!\?\s]*$/i.test(q2Plain.split('\n')[0]);

if (q2NoGap) {
  // Q2 "none" requires explicit articulation of what strongest-version-check
  // surfaced — at least one substantive sentence beyond the "none" header.
  const beyond = q2Plain.replace(/^(no gap|none|n\/a|no gaps)[\.\!\?\s]*/i, '').trim();
  if (beyond.replace(/\s+/g, '').length < 40 || VACUOUS.test(q1Plain)) {
    fail(`Q2 'none' alongside vacuous Q1 — name what strongest-version-check surfaced or admit a real gap. ${args.file}`);
  }
} else {
  // Q2 names a gap. Q3 must contain a quoted-words construct — either a
  // nested `> > "..."` blockquote OR straight-quoted owner phrase `"..."`.
  // The entire self-audit may already live inside a top-level blockquote (one
  // `>` per line); detecting a "blockquote of owner words" therefore means
  // looking for either a NESTED blockquote OR explicit "..." quotation
  // around an attributable sentence (more than one quoted word).
  const hasNestedBlockquote = /^\s*>\s*>\s*\S/m.test(q3Body);
  // ASCII " ... " or curly “...” spanning at least two words.
  const hasStraightQuote = /["“][^"”]{8,}["”]/.test(q3Body);
  if (!hasNestedBlockquote && !hasStraightQuote) {
    fail(`Q2 names a gap but Q3 has no blockquote / quoted phrase of the owner's verbatim waiver. ${args.file}`);
  }
  // (d) Waiver must reference the gap. Heuristic: at least one significant
  // word from Q2 (length >= 5, not a stopword) appears in Q3.
  const STOPWORDS = new Set([
    'about','above','after','again','against','because','before','between','during','about',
    'every','their','there','these','those','which','while','where','would','should','could',
    'might','shall','being','through','within','without','around','really','still','first',
    'second','third','though','others','other','someone','something','anyone','anything',
    'gap', 'gaps', 'this', 'that', 'with', 'from', 'have', 'will', 'into', 'than', 'then',
    'when', 'they', 'them', 'were', 'been', 'just', 'like', 'also', 'over', 'such',
    'this', 'most', 'some',
  ]);
  const q2Tokens = q2Plain.toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 5 && !STOPWORDS.has(w));
  const q3Lower = q3Body.toLowerCase();
  const overlap = q2Tokens.filter(t => q3Lower.includes(t));
  if (overlap.length === 0) {
    fail(`Q3 waiver does not reference any keyword from the Q2 gap — waiver must address the specific gap, not be a generic "ship it". ${args.file}`);
  }
}

console.log(`ok — ${args.file}: self-audit section valid (Q1/Q2/Q3 answered, gap-waiver consistent)`);
