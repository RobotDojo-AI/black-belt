/**
 * book-print-job.js — idempotent Lulu SANDBOX submit for one volume.
 *
 * Compute tier: Tier 0 (local, deterministic — hashing + Lulu HTTP). No LLM; no
 * DB writes.
 *
 * The AC6 no-double-order guard: the job id is content-hashed from the build,
 * volume, SKU, and shipping address; the result is persisted under
 * user/media/books/{buildId}/jobs/{id}.json. A retry or resume that computes the
 * same id returns the stored result and never calls Lulu again.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { booksRoot } from './book-engine.js';
import { calcPrintJobCost, createPrintJob, podPackageId, DEFAULT_SHIPPING_LEVEL } from './lulu-client.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalAddress(address = {}) {
  return JSON.stringify({
    name: address.name || '',
    street1: address.street1 || '',
    street2: address.street2 || '',
    city: address.city || '',
    stateCode: address.stateCode || address.state_code || '',
    countryCode: address.countryCode || address.country_code || '',
    postcode: address.postcode || address.zip || '',
  });
}

/** Content-hashed job id — stable across retries for the same submit spec. */
export function makeBookPrintJobId(spec = {}) {
  return sha256(JSON.stringify({
    buildId: spec.buildId,
    volumeIndex: spec.volumeIndex,
    sku: spec.sku || podPackageId(spec),
    shippingAddress: canonicalAddress(spec.shippingAddress),
    mode: 'sandbox',
  })).slice(0, 32);
}

function jobPath(buildId, id) {
  return join(booksRoot(), String(buildId), 'jobs', `${id}.json`);
}

async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

async function readExistingJob(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * submitBookPrintJob(spec, options) → the persisted job result. If a completed
 * job file already exists for this content-hashed id, it is returned as-is (no
 * re-submit). Otherwise: cost-calc (a numeric total confirms the SKU) → create
 * print job → persist { id, printJobId, cost, printJob, submittedAt }.
 */
export async function submitBookPrintJob(spec, options = {}) {
  const {
    buildId, volumeIndex, pageCount, interiorUrl, coverUrl,
    interiorMd5, coverMd5, shippingAddress, contactEmail,
    title, shippingLevel = DEFAULT_SHIPPING_LEVEL,
  } = spec;

  const id = makeBookPrintJobId(spec);
  const path = jobPath(buildId, id);

  const existing = await readExistingJob(path);
  if (existing) return { ...existing, reused: true };

  const sku = podPackageId(spec);
  const lineItem = {
    title: title || `Volume ${volumeIndex}`,
    podPackageId: sku,
    pageCount,
    quantity: 1,
    interiorUrl,
    coverUrl,
    interiorMd5,
    coverMd5,
  };

  const cost = await calcPrintJobCost({
    lineItems: [lineItem],
    shippingAddress,
    shippingLevel,
  }, options);

  const printJob = await createPrintJob({
    lineItems: [lineItem],
    shippingAddress,
    contactEmail,
    shippingLevel,
  }, options);

  const result = {
    id,
    printJobId: printJob.id,
    status: printJob.status,
    sku,
    volumeIndex,
    cost: {
      totalCostInclTax: cost.totalCostInclTax,
      shippingCost: cost.shippingCost,
      currency: cost.currency,
    },
    shippingAddress,
    printJob: printJob.raw,
    submittedAt: new Date().toISOString(),
    reused: false,
  };
  await writeAtomicJson(path, result);
  return result;
}
