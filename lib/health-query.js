/**
 * Health data query layer for LLM context injection.
 *
 * Provides exact quantitative health data (lab values, biometrics, meds)
 * for injection into the system prompt. No RAG hallucination — all values
 * come from the structured DB.
 *
 * Architecture:
 *   RAG = narrative context (notes, doctor letters, interpretation)
 *   SQL = quantitative data (exact lab values, trends, medication timelines)
 *   Both are injected; LLM synthesizes.
 */

import db from './db.js';

function healthGroupIdForDisplay(groupId) {
  return groupId === 'auto_imported' ? 'labs' : groupId;
}

// ─── Marker alias map ─────────────────────────────────────────────────────
// Maps common user-facing names / query keywords to canonical health_markers ids.
// Used to pull full time-series when a marker is mentioned in the user's message.

export const MARKER_ALIASES = {
  ldl:          ['ldl', 'cholesterol', 'lipid'],
  hdl:          ['hdl'],
  total_chol:   ['total cholesterol', 'total chol'],
  triglycerides:['triglyceride'],
  apob:         ['apob', 'apolipoprotein'],
  hscrp:        ['crp', 'c-reactive', 'inflammation', 'hscrp'],
  esr:          ['esr', 'sed rate'],
  ferritin:     ['ferritin'],
  iron:         ['iron level', 'serum iron', 'iron,'],
  vitamin_d:    ['vitamin d', 'vit d', '25-oh', 'vitd'],
  testosterone: ['testosterone'],
  free_testosterone: ['free testosterone', 'free t'],
  tsh:          ['tsh', 'thyroid'],
  hba1c:        ['a1c', 'hba1c', 'hemoglobin a1c', 'glycated'],
  glucose:      ['glucose', 'blood sugar', 'fasting glucose'],
  wbc:          ['wbc', 'white blood', 'white cell'],
  platelets:    ['platelet'],
  anc:          ['anc', 'neutrophil'],
  alt:          ['alt', 'sgpt', 'alanine'],
  ast:          ['ast', 'sgot', 'aspartate'],
  bilirubin:    ['bilirubin'],
  creatinine:   ['creatinine'],
  calcium_serum:['calcium'],
  weight:       ['weight'],
  body_fat:     ['body fat', 'body composition'],
  dheas:        ['dhea'],
  shbg:         ['shbg', 'sex hormone binding'],
  b12:          ['b12', 'cobalamin'],
  folate:       ['folate', 'folic acid'],
  zinc:         ['zinc'],
  copper:       ['copper'],
  egfr:         ['egfr', 'kidney function', 'glomerular filtration'],
  bun:          ['bun', 'urea nitrogen'],
  homocysteine: ['homocysteine', 'homocystine'],
  lpa:          ['lpa', 'lipoprotein a'],
  pth:          ['pth', 'parathyroid'],
  uric_acid:    ['uric acid', 'gout'],
  cortisol:     ['cortisol'],
  insulin:      ['insulin'],
  oura_hrv:     ['hrv', 'heart rate variability'],
  oura_rhr:     ['resting heart rate', 'resting hr', 'oura rhr'],
  oura_total_sleep: ['total sleep', 'sleep hours', 'oura sleep'],
  oura_deep_sleep:  ['deep sleep'],
  oura_rem_sleep:   ['rem sleep', 'rem'],
  oura_readiness:   ['readiness', 'recovery'],
};

// ─── Prepared statements ──────────────────────────────────────────────────

let _stmts = null;
function stmts() {
  if (_stmts) return _stmts;
  _stmts = {
    allLatest: db.prepare(`
      SELECT dp.marker_id, dp.date, dp.value, m.name, m.unit, m.ref_low, m.ref_high, m.target,
             CASE WHEN m.group_id = 'auto_imported' THEN 'labs' ELSE m.group_id END AS group_id
      FROM health_data_points dp
      JOIN health_markers m ON m.id = dp.marker_id
      WHERE dp.excluded = 0
        AND dp.date = (
          SELECT MAX(d2.date) FROM health_data_points d2
          WHERE d2.marker_id = dp.marker_id AND d2.excluded = 0
        )
      ORDER BY m.group_id, m.name
    `),
    recentMetrics: db.prepare(`
      SELECT dp.marker_id, dp.date, dp.value, m.name, m.unit, m.ref_low, m.ref_high,
             CASE WHEN m.group_id = 'auto_imported' THEN 'labs' ELSE m.group_id END AS group_id
      FROM health_data_points dp
      JOIN health_markers m ON m.id = dp.marker_id
      WHERE dp.excluded = 0
        AND dp.date >= date('now', '-' || ? || ' days')
        AND dp.date = (
          SELECT MAX(d2.date) FROM health_data_points d2
          WHERE d2.marker_id = dp.marker_id AND d2.excluded = 0
            AND d2.date >= date('now', '-' || ? || ' days')
        )
      ORDER BY dp.date DESC, m.group_id, m.name
    `),
    markerHistory: db.prepare(`
      SELECT date, value FROM health_data_points
      WHERE marker_id = ? AND excluded = 0
      ORDER BY date ASC
    `),
    markerMeta: db.prepare(`
      SELECT id, name, unit, ref_low, ref_high, target,
             CASE WHEN group_id = 'auto_imported' THEN 'labs' ELSE group_id END AS group_id
      FROM health_markers WHERE id = ?
    `),
    activeMeds: db.prepare(`
      SELECT name, type, dose, frequency, timing, date_started, notes
      FROM curated_medications WHERE status = 'active'
      ORDER BY type, timing, name
    `),
    recentNotes: db.prepare(`
      SELECT date, content, tags FROM health_notes
      WHERE date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC LIMIT 10
    `),
  };
  return _stmts;
}

// ─── Formatters ───────────────────────────────────────────────────────────

function formatLatestSummary() {
  const rows = stmts().allLatest.all();
  if (!rows.length) return null;

  const lines = ['### Latest Lab & Biometric Values', ''];
  for (const r of rows) {
    let flag = '';
    if (r.ref_low != null && r.value < r.ref_low) flag = ' ⚠ LOW';
    if (r.ref_high != null && r.value > r.ref_high) flag = ' ⚠ HIGH';
    lines.push(`- **${r.name}**: ${r.value} ${r.unit || ''} (${r.date})${flag}`);
  }
  return lines.join('\n');
}

function formatActiveMeds() {
  const meds = stmts().activeMeds.all();
  if (!meds.length) return null;

  const rx = meds.filter(m => m.type === 'rx');
  const supps = meds.filter(m => m.type === 'supplement');
  const lines = ['### Current Medications & Supplements (owner-verified, authoritative)', ''];

  if (rx.length) {
    lines.push('**Prescriptions:**');
    for (const m of rx) {
      lines.push(`- **${m.name}** ${m.dose || ''} — ${m.frequency || ''}${m.timing ? ', ' + m.timing : ''}`);
      if (m.notes) lines.push(`  _${m.notes}_`);
    }
    lines.push('');
  }

  if (supps.length) {
    lines.push('**Supplements:**');
    for (const m of supps) {
      lines.push(`- **${m.name}** ${m.dose || ''} — ${m.frequency || ''}${m.timing ? ', ' + m.timing : ''}`);
      if (m.notes) lines.push(`  _${m.notes}_`);
    }
  }

  return lines.join('\n');
}

function formatMarkerTimeSeries(markerId) {
  const meta = stmts().markerMeta.get(markerId);
  if (!meta) return null;
  const data = stmts().markerHistory.all(markerId);
  if (!data.length) return null;

  const lines = [`### ${meta.name} (${meta.unit || 'no unit'})`];
  if (meta.ref_low != null || meta.ref_high != null) {
    lines.push(`Reference range: ${meta.ref_low ?? '—'} – ${meta.ref_high ?? '—'} ${meta.unit || ''}`);
  }
  if (meta.target != null) lines.push(`Personal target: ${meta.target} ${meta.unit || ''}`);
  lines.push('');

  for (const pt of data) {
    let flag = '';
    if (meta.ref_low != null && pt.value < meta.ref_low) flag = ' ⚠ LOW';
    if (meta.ref_high != null && pt.value > meta.ref_high) flag = ' ⚠ HIGH';
    lines.push(`  ${pt.date}: ${pt.value} ${meta.unit || ''}${flag}`);
  }

  if (data.length > 1) {
    const latest = data[data.length - 1];
    const first = data[0];
    if (first.value !== 0) {
      const pct = ((latest.value - first.value) / first.value * 100).toFixed(1);
      const sign = pct > 0 ? '+' : '';
      lines.push(`\nTrend: ${sign}${pct}% from ${first.date} to ${latest.date}`);
    }
  }

  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build health context for system prompt injection.
 *
 * Always includes: latest values for all markers + active medications.
 * Optionally: full time-series for markers mentioned in the message.
 *
 * @param {object} [opts]
 * @param {string} [opts.message] - user's message (used to detect which markers to expand)
 * @param {string[]} [opts.sections] - subset: ['metrics', 'medications', 'trends', 'notes']
 * @param {number} [opts.days] - window for 'recent' section (default 90)
 * @returns {string|null}
 */
export function buildHealthContext({ message = null, sections = null, days = 90 } = {}) {
  const parts = [];
  const wantAll = !sections;

  if (wantAll || sections.includes('metrics')) {
    const summary = formatLatestSummary();
    if (summary) parts.push(summary);
  }

  if (wantAll || sections.includes('medications')) {
    const meds = formatActiveMeds();
    if (meds) parts.push(meds);
  }

  // Expand full time-series for markers the user asked about
  if (message && (wantAll || sections.includes('trends'))) {
    const lower = message.toLowerCase();
    const matched = new Set();
    for (const [markerId, aliases] of Object.entries(MARKER_ALIASES)) {
      for (const alias of aliases) {
        if (lower.includes(alias)) {
          matched.add(markerId);
          break;
        }
      }
    }
    for (const markerId of matched) {
      const ts = formatMarkerTimeSeries(markerId);
      if (ts) parts.push(ts);
    }
  }

  if ((wantAll || sections.includes('notes')) && days) {
    try {
      const notes = stmts().recentNotes.all(days);
      if (notes.length) {
        const noteLines = ['### Recent Health Notes', ''];
        for (const n of notes) {
          const tags = JSON.parse(n.tags || '[]');
          const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
          noteLines.push(`- **${n.date}**${tagStr}: ${n.content}`);
        }
        parts.push(noteLines.join('\n'));
      }
    } catch { /* health_notes may not exist */ }
  }

  if (!parts.length) return null;
  return '## Health Data (from structured database — exact values)\n\n' + parts.join('\n\n');
}

/**
 * Return recent biometric values (weight, BP, HR, HRV, labs) within N days.
 * Compact — no time-series expansion.
 *
 * @param {number} [days=90]
 * @returns {Array<{name, value, unit, date, marker_id, group_id, flag}>}
 */
export function getRecentMetrics(days = 90) {
  try {
    const rows = stmts().recentMetrics.all(days, days);
    return rows.map(r => {
      let flag = null;
      if (r.ref_low != null && r.value < r.ref_low) flag = 'LOW';
      if (r.ref_high != null && r.value > r.ref_high) flag = 'HIGH';
      return {
        marker_id: r.marker_id,
        name: r.name,
        value: r.value,
        unit: r.unit || '',
        date: r.date,
        group_id: healthGroupIdForDisplay(r.group_id),
        flag,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Return trend direction for specific marker IDs.
 * Trend is computed from first vs latest data point.
 *
 * @param {string[]} [markerNames=[]] - marker ids to check
 * @returns {Array<{marker_id, name, first_date, first_value, latest_date, latest_value, pct_change, direction}>}
 */
export function getTrends(markerNames = []) {
  const results = [];
  for (const markerId of markerNames) {
    const meta = stmts().markerMeta.get(markerId);
    if (!meta) continue;
    const data = stmts().markerHistory.all(markerId);
    if (data.length < 2) continue;

    const first = data[0];
    const latest = data[data.length - 1];
    const pctChange = first.value !== 0
      ? ((latest.value - first.value) / first.value * 100)
      : null;

    results.push({
      marker_id: markerId,
      name: meta.name,
      first_date: first.date,
      first_value: first.value,
      latest_date: latest.date,
      latest_value: latest.value,
      pct_change: pctChange !== null ? Math.round(pctChange * 10) / 10 : null,
      direction: pctChange === null ? 'unknown' : pctChange > 1 ? 'up' : pctChange < -1 ? 'down' : 'stable',
    });
  }
  return results;
}

/**
 * Compact health context string for injection into every chat (regardless of topic).
 * Uses getRecentMetrics(30) — recent values only, no time-series expansion.
 * ~500 tokens. Never throws.
 *
 * @returns {string}
 */
export function buildCompactHealthContext() {
  try {
    const metrics = getRecentMetrics(30);
    const meds = stmts().activeMeds.all();

    const parts = [];

    if (metrics.length) {
      const lines = metrics
        .slice(0, 20)
        .map(m => `- **${m.name}**: ${m.value} ${m.unit} (${m.date})${m.flag ? ' ⚠ ' + m.flag : ''}`);
      parts.push('### Recent Health Metrics (last 30d)\n' + lines.join('\n'));
    }

    if (meds.length) {
      const rx = meds.filter(m => m.type === 'rx').map(m => m.name).join(', ');
      const supp = meds.filter(m => m.type === 'supplement').map(m => m.name).join(', ');
      const lines = [];
      if (rx) lines.push(`Prescriptions: ${rx}`);
      if (supp) lines.push(`Supplements: ${supp}`);
      if (lines.length) parts.push('### Active Medications\n' + lines.join('\n'));
    }

    if (!parts.length) return '';
    return '## Health Summary\n\n' + parts.join('\n\n');
  } catch {
    return '';
  }
}
