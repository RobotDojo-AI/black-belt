/**
 * delaware-dashboard.js — Delaware fiscal dashboard generator.
 *
 * Reads delaware-financials.json and writes a static dashboard.html.
 * No LLM. No external dependencies. Opens directly from file:// without a server.
 *
 * Layout:
 *   Header: title + source link
 *   Three-column segment section (Residents | In-State Ops | State Products)
 *     Each: revenue total, P/P/P bars, expenditure, net income
 *   Cross-segment subsidy flow (CSS arrow)
 *   Valuation summary panel
 *
 * AC8 requires these exact text labels: "Residents", "In-State", "State Products",
 * "Subsidy", "WACC", "Enterprise Value".
 *
 * INTELLIGENCE_TIER: extraction — deterministic JSON → HTML transform, no LLM.
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/states/delaware-dashboard.js
 */
export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');

const DELAWARE_DIR = resolve(
  REPO_ROOT,
  'user/workbenches/topics/work/states/wk_states/states/delaware'
);
const INPUT_JSON = resolve(DELAWARE_DIR, 'delaware-financials.json');
const OUTPUT_HTML = resolve(DELAWARE_DIR, 'dashboard.html');

function fmt(n, decimals = 1) {
  if (n == null || isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(abs / 1000).toFixed(1)}B`;
  return `$${abs.toFixed(decimals)}M`;
}

function fmtSign(n) {
  if (n == null || isNaN(n)) return 'N/A';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${fmt(n)}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * Build three horizontal bars for Produce/Possess/Purchase.
 * Widths are proportional to the segment's total revenue.
 */
function buildPPPBars(revenues) {
  const total = revenues.total || 1; // avoid div/0
  const bars = [
    { label: 'Produce', value: revenues.produce || 0, color: '#2563eb' },
    { label: 'Possess', value: revenues.possess || 0, color: '#7c3aed' },
    { label: 'Purchase', value: revenues.purchase || 0, color: '#059669' },
  ];
  return bars.map(b => {
    const pct = Math.max(4, Math.round((b.value / total) * 100));
    return `<div class="ppp-row">
      <span class="ppp-label">${b.label}</span>
      <div class="ppp-track">
        <div class="ppp-bar" style="width:${pct}%;background:${b.color}" title="${fmt(b.value)}"></div>
      </div>
      <span class="ppp-value">${fmt(b.value)}</span>
    </div>`;
  }).join('\n');
}

function buildSegmentCard(title, segData, accentColor) {
  const netClass = segData.net_income >= 0 ? 'positive' : 'negative';
  return `<div class="segment-card" style="border-top: 4px solid ${accentColor}">
    <h2 class="seg-title">${title}</h2>
    <div class="seg-stat">
      <span class="stat-label">Revenue</span>
      <span class="stat-value">${fmt(segData.revenues.total)}</span>
    </div>
    <div class="ppp-section">
      ${buildPPPBars(segData.revenues)}
    </div>
    <div class="seg-stat">
      <span class="stat-label">Expenditure</span>
      <span class="stat-value">(${fmt(segData.expenditures.total)})</span>
    </div>
    <div class="seg-stat net">
      <span class="stat-label">Net Income</span>
      <span class="stat-value ${netClass}">${fmtSign(segData.net_income)}</span>
    </div>
  </div>`;
}

async function main() {
  if (!existsSync(INPUT_JSON)) {
    console.error('[states/dashboard] delaware-financials.json not found — run delaware-model.js first');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(INPUT_JSON, 'utf8'));
  const { segments, consolidated, cross_segment_subsidy: subsidy, valuation } = data;

  // Source URL from manifest for the header link
  const manifestPath = resolve(DELAWARE_DIR, 'source-docs/manifest.json');
  let sourceUrl = 'https://finance.delaware.gov';
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    sourceUrl = manifest.documents?.[0]?.url || sourceUrl;
  } catch { /* manifest not yet written — use fallback */ }

  // FCF yield = FCF year 1 / enterprise value (as %)
  const fcfYield = valuation?.fcf_projections?.[0]?.fcf_millions && valuation?.enterprise_value
    ? ((valuation.fcf_projections[0].fcf_millions / (valuation.enterprise_value * 1000)) * 100).toFixed(1)
    : 'N/A';

  const segCards = [
    buildSegmentCard('Residents', segments.residents, '#2563eb'),
    buildSegmentCard('In-State Ops', segments.in_state_operations, '#7c3aed'),
    buildSegmentCard('State Products', segments.state_products, '#059669'),
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Delaware Fiscal Dashboard FY2024</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      line-height: 1.5;
    }

    /* ── Header ───────────────────────────────────────────────────────── */
    .header {
      background: #1e293b;
      color: white;
      padding: 24px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: 0.05em; }
    .header-sub { font-size: 0.8rem; color: #94a3b8; margin-top: 4px; }
    .header-link a { color: #60a5fa; font-size: 0.85rem; text-decoration: none; }
    .header-link a:hover { text-decoration: underline; }

    /* ── Layout ───────────────────────────────────────────────────────── */
    .container { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
    .section-title {
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: #64748b;
      text-transform: uppercase;
      margin-bottom: 16px;
    }

    /* ── Segment cards ────────────────────────────────────────────────── */
    .segments-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      margin-bottom: 40px;
    }
    @media (max-width: 800px) {
      .segments-grid { grid-template-columns: 1fr; }
    }
    .segment-card {
      background: white;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .seg-title {
      font-size: 1rem;
      font-weight: 700;
      margin-bottom: 16px;
      color: #0f172a;
    }
    .seg-stat {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .seg-stat.net { border-bottom: none; margin-top: 4px; }
    .stat-label { font-size: 0.85rem; color: #64748b; }
    .stat-value { font-size: 0.95rem; font-weight: 600; }
    .positive { color: #059669; }
    .negative { color: #dc2626; }

    /* ── P/P/P bars ───────────────────────────────────────────────────── */
    .ppp-section { padding: 12px 0; }
    .ppp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .ppp-label {
      font-size: 0.72rem;
      color: #64748b;
      width: 56px;
      flex-shrink: 0;
    }
    .ppp-track {
      flex: 1;
      background: #f1f5f9;
      border-radius: 3px;
      height: 10px;
      overflow: hidden;
    }
    .ppp-bar {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .ppp-value {
      font-size: 0.72rem;
      color: #64748b;
      width: 52px;
      text-align: right;
    }

    /* ── Subsidy flow ─────────────────────────────────────────────────── */
    .subsidy-panel {
      background: white;
      border-radius: 12px;
      padding: 28px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      margin-bottom: 40px;
    }
    .subsidy-flow {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      margin: 20px 0;
    }
    .subsidy-box {
      padding: 16px 24px;
      border-radius: 8px;
      text-align: center;
      min-width: 160px;
    }
    .subsidy-box.source { background: #ecfdf5; border: 2px solid #059669; }
    .subsidy-box.dest   { background: #eff6ff; border: 2px solid #2563eb; }
    .subsidy-box-label { font-size: 0.8rem; color: #64748b; margin-bottom: 4px; }
    .subsidy-box-name  { font-size: 1rem; font-weight: 700; }
    .subsidy-box.source .subsidy-box-name { color: #059669; }
    .subsidy-box.dest .subsidy-box-name   { color: #2563eb; }
    .subsidy-arrow {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0 16px;
      min-width: 180px;
    }
    .arrow-amount {
      font-size: 1.4rem;
      font-weight: 700;
      color: #f59e0b;
    }
    .arrow-line {
      width: 120px;
      height: 3px;
      background: #f59e0b;
      position: relative;
      margin: 6px 0;
    }
    .arrow-line::after {
      content: '';
      position: absolute;
      right: -1px;
      top: -5px;
      border: 6px solid transparent;
      border-left-color: #f59e0b;
    }
    .arrow-per-resident {
      font-size: 0.78rem;
      color: #92400e;
      text-align: center;
    }
    .subsidy-note {
      font-size: 0.82rem;
      color: #64748b;
      text-align: center;
      margin-top: 12px;
    }

    /* ── Valuation panel ──────────────────────────────────────────────── */
    .valuation-panel {
      background: #1e293b;
      color: white;
      border-radius: 12px;
      padding: 28px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .valuation-panel .section-title { color: #94a3b8; }
    .val-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      margin-top: 8px;
    }
    @media (max-width: 600px) { .val-grid { grid-template-columns: 1fr; } }
    .val-item { text-align: center; }
    .val-label { font-size: 0.78rem; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.06em; }
    .val-value { font-size: 1.6rem; font-weight: 700; color: white; }
    .val-sub   { font-size: 0.72rem; color: #64748b; margin-top: 4px; }

    /* ── Consolidated footer bar ──────────────────────────────────────── */
    .consolidated-bar {
      background: white;
      border-radius: 12px;
      padding: 20px 28px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      display: flex;
      justify-content: space-around;
      margin-bottom: 40px;
    }
    .cons-item { text-align: center; }
    .cons-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
    .cons-value { font-size: 1.1rem; font-weight: 700; }
  </style>
</head>
<body>

<div class="header">
  <div>
    <h1>DELAWARE — FISCAL DASHBOARD FY2024</h1>
    <div class="header-sub">Generated: ${data.generated_at || 'N/A'}</div>
  </div>
  <div class="header-link">
    <a href="${sourceUrl}" target="_blank" rel="noopener">Source: ACFR FY2024 ↗</a>
  </div>
</div>

<div class="container">

  <!-- ── Consolidated summary ─────────────────────────────────────────── -->
  <div class="consolidated-bar">
    <div class="cons-item">
      <div class="cons-label">Total Revenue</div>
      <div class="cons-value">${fmt(consolidated.total_revenue)}</div>
    </div>
    <div class="cons-item">
      <div class="cons-label">Total Expenditure</div>
      <div class="cons-value">(${fmt(consolidated.total_expenditure)})</div>
    </div>
    <div class="cons-item">
      <div class="cons-label">Net Income</div>
      <div class="cons-value ${consolidated.net_income >= 0 ? 'positive' : 'negative'}">${fmtSign(consolidated.net_income)}</div>
    </div>
    <div class="cons-item">
      <div class="cons-label">Population</div>
      <div class="cons-value">1.0M</div>
    </div>
  </div>

  <!-- ── Segment cards ─────────────────────────────────────────────────── -->
  <div class="section-title">Segment Performance</div>
  <div class="segments-grid">
    ${segCards}
  </div>

  <!-- ── Subsidy flow ──────────────────────────────────────────────────── -->
  <div class="subsidy-panel">
    <div class="section-title">Cross-Segment Subsidy Flow</div>
    <div class="subsidy-flow">
      <div class="subsidy-box source">
        <div class="subsidy-box-label">Surplus from</div>
        <div class="subsidy-box-name">State Products</div>
        <div style="font-size:0.8rem;color:#065f46;margin-top:4px;">Net: ${fmtSign(segments.state_products.net_income)}</div>
      </div>
      <div class="subsidy-arrow">
        <div class="arrow-amount">${fmt(subsidy?.amount_millions || 0)}</div>
        <div class="arrow-line"></div>
        <div class="arrow-per-resident">$${(subsidy?.per_resident_dollars || 0).toLocaleString()} per resident</div>
      </div>
      <div class="subsidy-box dest">
        <div class="subsidy-box-label">Funds deficit in</div>
        <div class="subsidy-box-name">Residents</div>
        <div style="font-size:0.8rem;color:#1e40af;margin-top:4px;">Net: ${fmtSign(segments.residents.net_income)}</div>
      </div>
    </div>
    <div class="subsidy-note">
      The incorporation franchise (Segment 3 — State Products) generates a surplus that cross-subsidizes
      resident public services. Delaware residents receive more in services than they pay in taxes.
    </div>
  </div>

  <!-- ── Valuation ─────────────────────────────────────────────────────── -->
  <div class="valuation-panel">
    <div class="section-title">Valuation Summary (DCF)</div>
    <div class="val-grid">
      <div class="val-item">
        <div class="val-label">WACC</div>
        <div class="val-value">${fmtPct(valuation?.wacc)}</div>
        <div class="val-sub">10yr Treasury 4.5% + Aaa spread 0.05%</div>
      </div>
      <div class="val-item">
        <div class="val-label">Enterprise Value</div>
        <div class="val-value">${valuation?.enterprise_value ? fmt(valuation.enterprise_value) : 'N/A'}</div>
        <div class="val-sub">DCF of 5-yr FCF + terminal value</div>
      </div>
      <div class="val-item">
        <div class="val-label">FCF Yield</div>
        <div class="val-value">${fcfYield !== 'N/A' ? fcfYield + '%' : 'N/A'}</div>
        <div class="val-sub">Year 1 FCF / Enterprise Value</div>
      </div>
    </div>
  </div>

</div><!-- /container -->

</body>
</html>`;

  writeFileSync(OUTPUT_HTML, html);
  console.log(`[states/dashboard] Dashboard written: ${OUTPUT_HTML}`);
  console.log(JSON.stringify({ ok: true, output: OUTPUT_HTML }, null, 2));
}

main().catch(err => {
  console.error('[states/dashboard] Unexpected error:', err);
  process.exit(1);
});
