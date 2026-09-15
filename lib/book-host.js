/**
 * book-host.js — public PDF hosting so Lulu's sandbox can fetch interior+cover.
 *
 * Compute tier: Tier 0 (local, deterministic — file hashing + an HTTP self-probe).
 * No LLM; no DB writes.
 *
 * Lulu pulls each file from a public `source_url`; a local path will not work.
 * The running server is already publicly reachable at
 * https://{deviceSlug}.robotdojo.ai, so publishArtifact registers the file under
 * an unguessable token and returns the token URL that routes/books.js streams.
 * Before returning, it fetches its own public URL FROM OUTSIDE the process with
 * TLS verification ENFORCED (Lulu fetches with TLS on; a TLS-disabled probe would
 * green-light a cert-mismatched URL Lulu then rejects) and asserts
 * 200 + application/pdf + matching byte length + md5.
 */
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import config from './config.js';
import { booksRoot } from './book-engine.js';

const ALLOWED_KINDS = new Set(['interior', 'cover']);

function tokenStorePath() {
  return join(booksRoot(), '.artifact-tokens.json');
}

async function readTokenStore() {
  const path = tokenStorePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function writeTokenStore(store) {
  const path = tokenStorePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

function md5Of(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

/**
 * assertReachable(url, expect) — fetch the public URL with TLS ENFORCED and
 * verify it serves the exact bytes. Throws with the fix on any failure.
 */
export async function assertReachable(url, { md5, size, fetchImpl = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url); // TLS validation is ON — never disabled here.
  } catch (error) {
    throw new Error(`book_host_unreachable: ${url} did not respond (${error?.message || error}). Start the tunnel, or set the Cloudflare R2 fallback.`);
  }
  if (!res.ok) throw new Error(`book_host_unreachable_${res.status}: ${url}. Start the tunnel, or set the Cloudflare R2 fallback.`);
  const contentType = res.headers.get('content-type') || '';
  if (!/application\/pdf/i.test(contentType)) throw new Error(`book_host_bad_content_type: expected application/pdf, got '${contentType}'`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (size != null && buffer.length !== size) throw new Error(`book_host_size_mismatch: served ${buffer.length} bytes, expected ${size}`);
  if (md5 && md5Of(buffer) !== md5) throw new Error('book_host_md5_mismatch: served bytes do not match the local file');
  return true;
}

/**
 * publishArtifact(localPath, { buildId, volumeIndex, kind }, options) →
 * { url, md5, size, token }. Registers a public token URL and, unless
 * options.skipProbe, self-probes it with TLS enforced before returning.
 */
export async function publishArtifact(localPath, { buildId, volumeIndex, kind }, options = {}) {
  if (!ALLOWED_KINDS.has(kind)) throw new Error(`book_host_bad_kind: ${kind}`);
  const deviceSlug = options.deviceSlug ?? config.deviceSlug;
  if (!deviceSlug) {
    throw new Error('book_host_device_slug_unset: no public tunnel configured. Start the tunnel (set ROBOTDOJO_DEVICE_SLUG), or configure the Cloudflare R2 fallback (robotdojo-CLOUDFLARE_API_TOKEN).');
  }

  const absolute = resolve(localPath);
  if (!absolute.startsWith(resolve(booksRoot()))) throw new Error('book_host_path_outside_books');
  const bytes = await readFile(absolute);
  const md5 = md5Of(bytes);
  const token = randomBytes(24).toString('hex');

  const store = await readTokenStore();
  store[token] = { buildId, volumeIndex, kind, path: absolute, md5, size: bytes.length, createdAt: new Date().toISOString() };
  await writeTokenStore(store);

  const host = options.host || `${deviceSlug}.robotdojo.ai`;
  const url = `https://${host}/api/books/artifact/${token}/${kind}.pdf`;

  if (!options.skipProbe) {
    await assertReachable(url, { md5, size: bytes.length, fetchImpl: options.fetchImpl });
  }
  return { url, md5, size: bytes.length, token };
}

/**
 * readArtifactForToken(token, file) → { buffer, size, contentType } | null.
 * The route resolver: validates the token + filename, maps to the on-disk PDF
 * (which must live under booksRoot), and returns its bytes. Path-traversal and
 * kind mismatches return null (404).
 */
export async function readArtifactForToken(token, file) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
  const match = String(file || '').match(/^(interior|cover)\.pdf$/);
  if (!match) return null;
  const kind = match[1];

  const store = await readTokenStore();
  const entry = store[token];
  if (!entry || entry.kind !== kind) return null;

  const absolute = resolve(entry.path);
  if (!absolute.startsWith(resolve(booksRoot())) || !existsSync(absolute)) return null;
  const buffer = await readFile(absolute);
  return { buffer, size: buffer.length, contentType: 'application/pdf' };
}

/** Remove a build's hosting tokens (cleanup after a proof / on rebuild). */
export async function revokeArtifactTokens(buildId) {
  const store = await readTokenStore();
  let changed = false;
  for (const [token, entry] of Object.entries(store)) {
    if (entry.buildId === buildId) { delete store[token]; changed = true; }
  }
  if (changed) await writeTokenStore(store);
  return changed;
}
