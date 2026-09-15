#!/usr/bin/env node
/**
 * build-book.js — one-command "source → print-ready book" entry.
 *
 * Compute tier: Tier 0 (local, deterministic — HTML extraction, layout, and a
 * headless Chromium PDF render; no LLM). No INTELLIGENCE_TIER declaration is
 * required because nothing here calls a model.
 *
 * Usage:
 *   node scripts/build/build-book.js --source-url https://paulgraham.com/articles.html \
 *     --instructions "all of Paul Graham essays, oldest to newest"
 *   node scripts/build/build-book.js --pdf /path/to/input.pdf
 *   ... --submit-sandbox --volume 1 --shipping-json /path/addr.json --contact-email you@example.com
 *
 * The book PDFs land in user/media/books/{buildId}/vol-n/{interior,cover}.pdf.
 * With --submit-sandbox and a --volume, the named volume is published to a
 * public URL and a Lulu SANDBOX cost + delivery preview is printed. No real
 * order is placed; nothing ships.
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildBook } from '../../lib/book-engine.js';
import { publishArtifact } from '../../lib/book-host.js';
import { submitBookPrintJob } from '../../lib/book-print-job.js';
import config from '../../lib/config.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function buildSource(args) {
  if (args.pdf) return { kind: 'pdf', filePath: args.pdf };
  if (args['pdf-url']) return { kind: 'pdf', url: args['pdf-url'] };
  if (args['source-url']) {
    return {
      kind: 'index',
      url: args['source-url'],
      instructions: args.instructions || '',
      volumeCount: args.volumes ? Number(args.volumes) : undefined,
    };
  }
  throw new Error('Provide --source-url <index-url> [--instructions "..."], or --pdf <path>, or --pdf-url <url>.');
}

// Optional per-book cover art: public-domain paintings bundled (gitignored) at
// user/media/book-assets/<slug>/covers.json. --cover-art <path> overrides; the
// Paul Graham index auto-loads its bundle. Absent → the generative cover design.
function loadCoverArt(args, source) {
  const explicit = args['cover-art'];
  const auto = source.kind === 'index' && /paulgraham\.com/i.test(source.url || '')
    ? join(homedir(), 'robotdojo/user/media/book-assets/pg-essays/covers.json') : null;
  const path = explicit || auto;
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = buildSource(args);
  const coverArt = loadCoverArt(args, source);

  process.stdout.write(`Building book from ${source.kind === 'pdf' ? (source.filePath || source.url) : source.url}${coverArt ? ` (with ${coverArt.length} cover paintings)` : ''} ...\n`);
  const result = await buildBook(source, { force: args.force === true, coverArt });

  process.stdout.write(`\nBuild ${result.buildId} — ${result.sourceLabel}\n`);
  for (const volume of result.volumes) {
    process.stdout.write(
      `  Vol ${volume.index}${volume.eraLabel ? ` (${volume.eraLabel})` : ''}: `
      + `${volume.pageCount} pages, spine ${volume.spineIn.toFixed(3)}in\n`,
    );
    process.stdout.write(`    interior: ${volume.interiorPath}\n`);
    process.stdout.write(`    cover:    ${volume.coverPath}\n`);
  }

  if (args['submit-sandbox']) {
    const volumeIndex = Number(args.volume || 1);
    const volume = result.volumes.find((v) => v.index === volumeIndex);
    if (!volume) throw new Error(`--volume ${volumeIndex} not found in the build`);
    if (!args['shipping-json']) throw new Error('--submit-sandbox requires --shipping-json <path> and --contact-email');
    const shippingAddress = JSON.parse(await readFile(args['shipping-json'], 'utf8'));
    const contactEmail = args['contact-email'] || config.ownerEmail;
    if (!contactEmail) throw new Error('--submit-sandbox requires --contact-email (or a configured owner email)');

    process.stdout.write(`\nPublishing volume ${volumeIndex} artifacts for the sandbox fetch ...\n`);
    const interior = await publishArtifact(volume.interiorPath, { buildId: result.buildId, volumeIndex, kind: 'interior' });
    const cover = await publishArtifact(volume.coverPath, { buildId: result.buildId, volumeIndex, kind: 'cover' });

    process.stdout.write('Submitting to Lulu SANDBOX (no real order) ...\n');
    const job = await submitBookPrintJob({
      buildId: result.buildId,
      volumeIndex,
      pageCount: volume.pageCount,
      title: `${result.sourceLabel} — Volume ${volumeIndex}`,
      interiorUrl: interior.url,
      coverUrl: cover.url,
      interiorMd5: interior.md5,
      coverMd5: cover.md5,
      shippingAddress,
      contactEmail,
    });

    process.stdout.write(`\nSANDBOX preview — print job ${job.printJobId} (${job.status})${job.reused ? ' [reused, no re-submit]' : ''}\n`);
    process.stdout.write(`  Cost: ${job.cost.totalCostInclTax} ${job.cost.currency} (shipping ${job.cost.shippingCost} ${job.cost.currency})\n`);
    process.stdout.write(`  Ships to: ${shippingAddress.name}, ${shippingAddress.city} ${shippingAddress.postcode}\n`);
    process.stdout.write('  No money spent. Nothing shipped.\n');
  }
}

main().catch((error) => {
  process.stderr.write(`build-book failed: ${error?.message || error}\n`);
  process.exit(1);
});
