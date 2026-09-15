/**
 * lulu-client.js — Lulu Print API client (SANDBOX by default).
 *
 * Compute tier: Tier 0 (local, deterministic — HTTP to a print service). No LLM;
 * no DB writes.
 *
 * Belt-and-suspenders against a real order: `base` defaults to
 * api.sandbox.lulu.com and every call refuses a non-sandbox base unless an
 * explicit `allowProduction: true` is passed — which this story never sets. The
 * 6×9 perfect-bound SKU is a documented to-verify constant: a real
 * cost-calculation returning a number is the authoritative confirmation it is
 * valid; a wrong SKU 400s before any print job is created.
 */
import config from './config.js';

const SANDBOX_BASE = 'https://api.sandbox.lulu.com';

// The 6×9 (0600X0900) black-and-white, standard, perfect-bound (PB), 60# white
// uncoated, 444ppi, matte (GXX) package. INFERRED from Lulu's pod_package_id
// grammar — NOT trusted as fact. A successful calcPrintJobCost (a real number
// returned) is the confirmation; on a 400, reconcile against Lulu's Product
// Sheet. Never hardcoded as verified.
export const LULU_PG_POD_PACKAGE_ID = '0600X0900BWSTDPB060UW444GXX';

/** Default shipping level — the cheapest tracked mail tier for the preview. */
export const DEFAULT_SHIPPING_LEVEL = 'MAIL';

function assertSandboxBase(base, allowProduction) {
  const isSandbox = /(^|\.)sandbox\.lulu\.com/i.test(new URL(base).hostname);
  if (!isSandbox && !allowProduction) {
    throw new Error('lulu_non_sandbox_base_refused');
  }
}

function resolveBase(options) {
  const base = options.base || config.luluApiBase || SANDBOX_BASE;
  assertSandboxBase(base, options.allowProduction === true);
  return base.replace(/\/+$/, '');
}

/** The 6×9 B&W perfect-bound SKU for a spec (only one today). */
export function podPackageId(_spec = {}) {
  return LULU_PG_POD_PACKAGE_ID;
}

/**
 * luluAccessToken(options) → OAuth2 client-credentials bearer token. Lulu's
 * token endpoint takes HTTP Basic (base64 of key:secret) + grant_type=client_
 * credentials form body.
 */
export async function luluAccessToken(options = {}) {
  const base = resolveBase(options);
  const key = options.clientKey ?? config.luluClientKey;
  const secretVal = options.clientSecret ?? config.luluClientSecret;
  if (!key || !secretVal) throw new Error('lulu_credentials_missing');
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const basic = Buffer.from(`${key}:${secretVal}`).toString('base64');
  const res = await fetchImpl(`${base}/auth/realms/glasstree/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`lulu_token_failed_${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('lulu_token_missing');
  return data.access_token;
}

async function authedFetch(path, body, options) {
  const base = resolveBase(options);
  const token = options.token || await luluAccessToken(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const method = options.method || 'POST';
  const res = await fetchImpl(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`lulu_request_failed_${res.status}`);
    err.status = res.status;
    err.detail = json;
    throw err;
  }
  return json;
}

function toLineItemCostInput(lineItems) {
  return lineItems.map((item) => ({
    pod_package_id: item.podPackageId || podPackageId(item),
    page_count: item.pageCount,
    quantity: item.quantity ?? 1,
  }));
}

function toShippingAddress(address = {}) {
  return {
    name: address.name,
    street1: address.street1,
    street2: address.street2 || '',
    city: address.city,
    state_code: address.stateCode || address.state_code || '',
    country_code: address.countryCode || address.country_code,
    postcode: address.postcode || address.zip,
    phone_number: address.phoneNumber || address.phone_number || '',
  };
}

/**
 * calcPrintJobCost({ lineItems, shippingAddress, shippingLevel }) → normalized
 * { totalCostInclTax, shippingCost, lineItemCosts, currency, raw }. A numeric
 * total proves the SKU + address are accepted by Lulu.
 */
export async function calcPrintJobCost({ lineItems, shippingAddress, shippingLevel = DEFAULT_SHIPPING_LEVEL }, options = {}) {
  const body = {
    line_items: toLineItemCostInput(lineItems),
    shipping_address: toShippingAddress(shippingAddress),
    shipping_level: shippingLevel,
  };
  const json = await authedFetch('/print-job-cost-calculations/', body, options);
  return {
    totalCostInclTax: Number(json?.total_cost_incl_tax),
    shippingCost: json?.shipping_cost?.total_cost_incl_tax != null
      ? Number(json.shipping_cost.total_cost_incl_tax)
      : (json?.shipping_cost != null ? Number(json.shipping_cost) : null),
    lineItemCosts: json?.line_item_costs || [],
    currency: json?.currency || 'USD',
    raw: json,
  };
}

/**
 * createPrintJob({ lineItems, shippingAddress, contactEmail, shippingLevel }) →
 * { id, status, raw }. Each line item carries the interior + cover source URLs
 * Lulu will fetch (must be public https).
 */
export async function createPrintJob({ lineItems, shippingAddress, contactEmail, shippingLevel = DEFAULT_SHIPPING_LEVEL }, options = {}) {
  const body = {
    contact_email: contactEmail,
    line_items: lineItems.map((item) => ({
      title: item.title,
      printable_normalization: {
        pod_package_id: item.podPackageId || podPackageId(item),
        interior: {
          source_url: item.interiorUrl,
          ...(item.interiorMd5 ? { source_md5_sum: item.interiorMd5 } : {}),
        },
        cover: {
          source_url: item.coverUrl,
          ...(item.coverMd5 ? { source_md5_sum: item.coverMd5 } : {}),
        },
      },
      quantity: item.quantity ?? 1,
    })),
    shipping_address: toShippingAddress(shippingAddress),
    shipping_level: shippingLevel,
  };
  const json = await authedFetch('/print-jobs/', body, options);
  return {
    id: json?.id,
    status: json?.status?.name || json?.status || 'CREATED',
    raw: json,
  };
}

/**
 * getPrintJob(id) → { id, status, raw }. Fetches an existing sandbox print job
 * by id. Used to re-verify a previously-captured live proof reproducibly with
 * just the stored keys (no re-hosting / no shipping env), so the AC6 gate stays
 * green after the one-time proof's ephemeral hosting is torn down.
 */
export async function getPrintJob(id, options = {}) {
  const json = await authedFetch(`/print-jobs/${id}/`, null, { ...options, method: 'GET' });
  return {
    id: json?.id,
    status: json?.status?.name || json?.status || null,
    raw: json,
  };
}
