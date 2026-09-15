#!/usr/bin/env node
/**
 * pipeline-route.js
 * Takes --idea "text" and scores open stories by Jaccard word overlap.
 * Recommends fold-in or create based on top match score.
 *
 * Usage: node ~/robotdojo/scripts/pipeline-route.js --idea "description of your idea"
 *
 * Env:
 *   ROBOTDOJO_STORIES_DIR — override stories directory (for testing)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

// --- Config ---
const STORIES_DIR = PIPELINE_STORIES_DIR;

const EXCLUDE_KANBAN = new Set(['done', 'cancelled', 'archived']);
const FOLD_IN_THRESHOLD = 0.35;

// Stop words to filter
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'in', 'of', 'to', 'for', 'with', 'and', 'or',
  'but', 'on', 'at', 'by', 'from', 'as', 'this', 'that', 'it', 'be',
  'are', 'was', 'were', 'has', 'have', 'had', 'not', 'no', 'all', 'its',
  'if', 'so', 'do', 'does', 'did', 'can', 'will', 'would', 'should',
  'may', 'might', 'into', 'than', 'then', 'when', 'where', 'which',
  'who', 'how', 'what', 'up', 'out', 'about', 'also', 'any', 'each',
  'our', 'we', 'they', 'their', 'my', 'your', 'his', 'her', 'us',
]);

// --- Parse --idea argument ---
function parseArgs(argv) {
  const ideaIdx = argv.indexOf('--idea');
  if (ideaIdx === -1 || ideaIdx >= argv.length - 1) {
    return null;
  }
  return argv[ideaIdx + 1];
}

// --- Tokenize text into a set of lowercase words, filtered ---
function tokenize(text) {
  if (!text) return new Set();
  const words = text.toLowerCase().split(/[\s\W_]+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

// --- Jaccard similarity ---
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// --- Load open stories ---
function loadOpenStories() {
  let entries;
  try {
    entries = readdirSync(STORIES_DIR);
  } catch (err) {
    process.stderr.write(`Error: cannot read stories dir ${STORIES_DIR}\n`);
    process.exit(1);
  }

  const stories = [];
  for (const entry of entries) {
    if (!/^(st|df|wk)_/.test(entry)) continue;
    const metaPath = join(STORIES_DIR, entry, 'meta.json');
    try {
      const raw = readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(raw);
      if (!EXCLUDE_KANBAN.has(meta.kanban)) {
        stories.push(meta);
      }
    } catch (err) {
      process.stderr.write(`Warning: skipping malformed meta.json at ${metaPath}: ${err.message}\n`);
    }
  }
  return stories;
}

// --- Main ---
function main() {
  const idea = parseArgs(process.argv);

  if (!idea) {
    process.stderr.write('Usage: pipeline-route.js --idea "description of your idea"\n');
    process.stderr.write('Required: --idea flag with idea text\n');
    process.exit(1);
  }

  const ideaTokens = tokenize(idea);
  const stories = loadOpenStories();

  // Score all stories
  const scored = stories.map(s => {
    const slugTokens = tokenize((s.slug || '').replace(/-/g, ' '));
    const descTokens = tokenize(s.description || '');
    const combined = new Set([...slugTokens, ...descTokens]);
    const score = jaccard(ideaTokens, combined);
    return { story: s, score };
  });

  // Sort by score descending, take top 3
  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);

  process.stdout.write(`Routing: "${idea}"\n\n`);

  if (top3.length === 0) {
    process.stdout.write('No open stories found.\n\nRecommendation: create new story (no open stories to match against)\n');
    return;
  }

  process.stdout.write('Top matches:\n');
  top3.forEach((item, idx) => {
    const { story, score } = item;
    const slug = story.slug || story.story_name || story.story_id;
    const id = story.story_id;
    const desc = story.description ? `\n     Desc: ${story.description}` : '';
    process.stdout.write(`  ${idx + 1}. ${slug} (${id}) — score: ${score.toFixed(2)}${desc}\n`);
  });

  process.stdout.write('\n');

  const topScore = top3[0].score;
  const topSlug = top3[0].story.slug || top3[0].story.story_name || top3[0].story.story_id;

  if (topScore >= FOLD_IN_THRESHOLD) {
    process.stdout.write(`Recommendation: fold-in to ${topSlug} (score ${topScore.toFixed(2)} ≥ ${FOLD_IN_THRESHOLD})\n`);
  } else {
    process.stdout.write(`Recommendation: create new story (top score ${topScore.toFixed(2)} < ${FOLD_IN_THRESHOLD} threshold)\n`);
  }
}

main();
