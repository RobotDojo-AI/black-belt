/**
 * lib/referral/canonical-domains.js — st_b879a361
 *
 * Loads the three canonical domain files (YC + big-tech + VC) once at module
 * import and exposes:
 *   - getCanonicalDomains() → Set<string> — union of all three
 *   - classifyDomain(domain) → { companyType, tier }
 *
 * WHY one cached Set: 5,862 YC + 50 big-tech + 51 VC ≈ 5,963 domains. Loaded
 * once at server boot, queried per-person at qualify time. Set.has() is O(1).
 *
 * WHY a per-domain classify map: company_type and company_priority_tier need
 * to be resolved with the same lookup that decides "is this domain canonical?"
 * So we build one map keyed by domain → { companyType, tier } at boot.
 *
 * Per scope AC 6:
 *   YC domains          → { companyType: 'startup',  tier: 1 }
 *   VC firms            → { companyType: 'vc',       tier: 1 }
 *   Big-tech tier=2/3   → { companyType: 'bigTech',  tier: per-entry }
 *
 * Collision resolution: if a domain appears in multiple files, YC wins
 * (companyType='startup', tier=1). The big-tech file's _meta documents that
 * dual-listed companies (Stripe, Coinbase, etc.) are excluded from it, so
 * collisions should be rare or zero in practice.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(HERE, '..', '..', 'config');

// Eager load — module-scope cache. The files are tiny (~100KB total).
const _classifyMap = new Map(); // domain → { companyType, tier }
const _allDomains = new Set();

function _load() {
  if (_allDomains.size > 0) return;

  // YC — array of bare hostnames.
  try {
    const yc = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'yc-domains.json'), 'utf8'));
    if (Array.isArray(yc)) {
      for (const d of yc) {
        const dom = String(d).toLowerCase();
        if (!dom) continue;
        _classifyMap.set(dom, { companyType: 'startup', tier: 1 });
        _allDomains.add(dom);
      }
    }
  } catch (err) {
    // Fail-soft: missing yc file means the Set is empty for that source.
    // The server still boots; Path A just won't match YC entries.
    console.warn(`[canonical-domains] yc-domains.json load failed: ${err.message}`);
  }

  // VC firms — object with .firms[].domains[].
  try {
    const vc = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'vc-firms-domains.json'), 'utf8'));
    if (vc && Array.isArray(vc.firms)) {
      for (const firm of vc.firms) {
        const tier = firm?.tier ?? 1;
        for (const d of firm?.domains || []) {
          const dom = String(d).toLowerCase();
          if (!dom) continue;
          // VC overrides YC if a domain accidentally appears in both —
          // but big-tech does NOT override YC (see below).
          if (!_classifyMap.has(dom)) {
            _classifyMap.set(dom, { companyType: 'vc', tier });
          }
          _allDomains.add(dom);
        }
      }
    }
  } catch (err) {
    console.warn(`[canonical-domains] vc-firms-domains.json load failed: ${err.message}`);
  }

  // Big-tech — object with .companies[].domains[] + per-entry tier.
  try {
    const bt = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'big-tech-domains.json'), 'utf8'));
    if (bt && Array.isArray(bt.companies)) {
      for (const company of bt.companies) {
        const tier = company?.tier ?? 3;
        for (const d of company?.domains || []) {
          const dom = String(d).toLowerCase();
          if (!dom) continue;
          // YC + VC win over big-tech to keep dual-listed founders ranked at tier 1.
          if (!_classifyMap.has(dom)) {
            _classifyMap.set(dom, { companyType: 'bigTech', tier });
          }
          _allDomains.add(dom);
        }
      }
    }
  } catch (err) {
    console.warn(`[canonical-domains] big-tech-domains.json load failed: ${err.message}`);
  }
}

_load();

/**
 * @returns {Set<string>} union of all canonical domains (lowercase, bare).
 */
export function getCanonicalDomains() {
  return _allDomains;
}

/**
 * @param {string} domain — bare hostname, case-insensitive
 * @returns {{companyType: 'startup'|'bigTech'|'vc'|'unknown', tier: number|null}}
 */
export function classifyDomain(domain) {
  if (!domain) return { companyType: 'unknown', tier: null };
  const d = String(domain).toLowerCase().replace(/^www\./, '');
  const hit = _classifyMap.get(d);
  if (hit) return hit;
  return { companyType: 'unknown', tier: null };
}

// Test-only: reset cache so tests can re-load after env tweaks. Not exposed
// in production — only used by node:test specs that mutate config paths.
export function _resetForTests() {
  _allDomains.clear();
  _classifyMap.clear();
  _load();
}
