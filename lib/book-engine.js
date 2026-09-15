/**
 * book-engine.js — the deterministic "source → print-ready book" orchestrator.
 *
 * Compute tier: Tier 0 (local, deterministic — fetch/extract/layout/render). No
 * LLM anywhere in the pipeline; no DB writes.
 *
 * buildBook runs the whole chain: resolveCorpus → splitIntoVolumes → per volume
 * assemble+render interior, compute spine, render cover, verify, then write
 * user/media/books/{buildId}/vol-n/{interior,cover}.pdf + manifest.json. buildId
 * is content-addressed (source spec + corpus fingerprint) so the same source and
 * corpus reuse existing artifacts instead of rebuilding.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { USER_MEDIA_DIR } from './robotdojo-paths.js';
import { resolveCorpus } from './link-corpus.js';
import { splitIntoVolumes } from './book-volumes.js';
import { assembleVolumeHtml, interiorPrintCss, interiorFontFaces, renderInteriorPdf } from './book-interior.js';
import { spineWidthInches, coverWidthInches, assembleCoverHtml, renderCoverPdf } from './book-cover.js';

const MIN_VOLUME_PAGES = 400;
const MAX_VOLUME_PAGES = 600;

export function booksRoot() {
  return resolve(USER_MEDIA_DIR, 'books');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalSourceKey(source) {
  return JSON.stringify({
    kind: source.kind,
    url: source.url || '',
    filePath: source.filePath || '',
    instructions: source.instructions || '',
    volumeCount: source.volumeCount ?? null,
  });
}

function corpusFingerprint(essays) {
  return sha256(essays.map((essay) => `${essay.url}::${essay.wordCount || 0}`).join('\n'));
}

/** Deterministic author/book titling from the resolved corpus label. */
function bookMetaFor(sourceLabel) {
  const label = String(sourceLabel || '').trim();
  if (/paul graham/i.test(label)) return { bookTitle: 'Essays', author: 'Paul Graham' };
  return { bookTitle: label || 'Collected Writing', author: '' };
}

async function renderVolumeArtifacts(volume, meta, buildDir, css, browser) {
  const volDir = join(buildDir, `vol-${volume.index}`);
  const interiorPath = join(volDir, 'interior.pdf');
  const coverPath = join(volDir, 'cover.pdf');

  const html = assembleVolumeHtml(volume, meta);
  const { pageCount } = await renderInteriorPdf(html, css, interiorPath, { browser });

  const spineIn = spineWidthInches(pageCount);
  const coverHtml = assembleCoverHtml(volume, meta, spineIn);
  const cover = await renderCoverPdf(coverHtml, coverPath, { spineIn, browser });

  return {
    index: volume.index,
    eraLabel: volume.eraLabel,
    yearStart: volume.yearStart,
    yearEnd: volume.yearEnd,
    essayCount: volume.essays.length,
    wordCount: volume.wordCount,
    interiorPath,
    coverPath,
    pageCount,
    spineIn,
    coverWidthIn: coverWidthInches(spineIn),
    withinGuardrail: pageCount >= MIN_VOLUME_PAGES && pageCount <= MAX_VOLUME_PAGES,
  };
}

async function readExistingManifest(buildDir) {
  const manifestPath = join(buildDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const complete = Array.isArray(manifest.volumes) && manifest.volumes.length
      && manifest.volumes.every((v) => existsSync(v.interiorPath) && existsSync(v.coverPath));
    return complete ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * buildBook(source, options) → { buildId, buildDir, source, sourceLabel,
 * volumes, manifest }.
 *
 * source: { kind:'index', url, instructions, volumeCount? } | { kind:'pdf',
 * filePath|url }. options.force re-renders even if artifacts exist.
 */
export async function buildBook(source, options = {}) {
  const corpus = await resolveCorpus(source, options);
  const essays = corpus.essays;
  if (!essays.length) throw new Error('empty_corpus');

  const volumes = splitIntoVolumes(essays, {
    volumeCount: source.volumeCount ?? options.volumeCount,
    wordsPerPage: options.wordsPerPage,
  });

  const buildId = sha256(`${canonicalSourceKey(source)}::${corpusFingerprint(essays)}`).slice(0, 24);
  const buildDir = join(booksRoot(), buildId);

  if (!options.force) {
    const existing = await readExistingManifest(buildDir);
    if (existing) {
      return { buildId, buildDir, source, sourceLabel: corpus.sourceLabel, volumes: existing.volumes, manifest: existing };
    }
  }

  await mkdir(buildDir, { recursive: true });
  const meta = { ...bookMetaFor(corpus.sourceLabel), totalVolumes: volumes.length, coverArt: options.coverArt || null, sourceUrl: source.url || null };
  const css = interiorPrintCss(interiorFontFaces());

  // One Chromium instance; each volume renders as its own page (~450pp), one at
  // a time — never a single 1,800-page render.
  const browser = await chromium.launch();
  const rendered = [];
  try {
    for (const volume of volumes) {
      rendered.push(await renderVolumeArtifacts(volume, meta, buildDir, css, browser));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const manifest = {
    buildId,
    source,
    sourceLabel: corpus.sourceLabel,
    ordering: corpus.ordering,
    author: meta.author,
    bookTitle: meta.bookTitle,
    createdAt: new Date().toISOString(),
    totalEssays: essays.length,
    totalWords: essays.reduce((sum, essay) => sum + (essay.wordCount || 0), 0),
    volumes: rendered,
  };
  await writeFile(join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  return { buildId, buildDir, source, sourceLabel: corpus.sourceLabel, volumes: rendered, manifest };
}
