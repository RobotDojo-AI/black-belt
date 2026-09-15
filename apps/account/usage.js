// Usage section — cost tracking with daily grid (7d / 30d / 90d)

let usageDays = 30;

async function renderUsage() {
  const toolbar = $('#accountsToolbar');
  toolbar.innerHTML = `
    <span class="accounts-toolbar-title">Usage</span>
    <div class="usage-range-pills">
      <button class="usage-pill${usageDays === 7 ? ' active' : ''}" onclick="setUsageRange(7)">7d</button>
      <button class="usage-pill${usageDays === 30 ? ' active' : ''}" onclick="setUsageRange(30)">30d</button>
      <button class="usage-pill${usageDays === 90 ? ' active' : ''}" onclick="setUsageRange(90)">90d</button>
    </div>`;

  const feed = $('#accountsFeed');
  feed.innerHTML = '<div class="acct-loading">Loading usage data...</div>';

  const data = await fetchJSON(`/api/usage/range?days=${usageDays}`);
  if (!data || data.error) {
    feed.innerHTML = '<div class="accounts-empty"><span class="material-symbols-outlined accounts-empty-icon">analytics</span><p>No usage data yet</p></div>';
    return;
  }

  const dates = (data.byDay || []).map(d => d.date);
  const dailyTotals = {};
  for (const d of data.byDay || []) dailyTotals[d.date] = d.cost_cents;

  let html = '';

  // Model Pricing reference table
  html += `<div class="acct-section-header">Model Pricing</div>
<div class="acct-card">
<table class="usage-model-table">
  <thead><tr><th>Lane</th><th>Best for</th><th>Context</th><th>Cost</th></tr></thead>
  <tbody>`;
  for (const r of (typeof MODEL_TABLE !== 'undefined' ? MODEL_TABLE : [])) {
    html += `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[4])}</td></tr>`;
  }
  html += `</tbody></table>
<p class="usage-footnote">Pricing is pass-through from connected model providers. No markup.</p>
</div>`;

  const total = (data.totalCents / 100).toFixed(2);
  const avg = (data.avgCentsPerDay / 100).toFixed(2);

  // Summary stats
  html += `<div class="acct-card">
    <div class="usage-summary">
      <div class="usage-stat"><div class="usage-stat-value">$${total}</div><div class="usage-stat-label">Total (${usageDays}d)</div></div>
      <div class="usage-stat"><div class="usage-stat-value">$${avg}</div><div class="usage-stat-label">Daily avg</div></div>
      <div class="usage-stat"><div class="usage-stat-value">${data.activeDays}</div><div class="usage-stat-label">Active days</div></div>
    </div>
  </div>`;

  // Build daily summaries for hover tooltips (what happened each expensive day)
  const dailySummaries = {};
  const avgCents = data.totalCents / (dates.length || 1);
  for (const row of (data.dailyByPurpose || [])) {
    if (!dailySummaries[row.date]) dailySummaries[row.date] = [];
    dailySummaries[row.date].push({ purpose: row.purpose, cents: row.cost_cents });
  }
  // Only keep summaries for days above average
  for (const d of dates) {
    const cents = dailyTotals[d] || 0;
    if (cents <= avgCents * 1.5) delete dailySummaries[d];
    else if (dailySummaries[d]) dailySummaries[d].sort((a, b) => b.cents - a.cents);
  }

  // Build all breakdown data
  const providerDaily = {}, providerTotals = {};
  for (const row of (data.dailyByModel || [])) {
    const prov = modelToProvider(row.model);
    if (!providerDaily[prov]) { providerDaily[prov] = {}; providerTotals[prov] = 0; }
    providerDaily[prov][row.date] = (providerDaily[prov][row.date] || 0) + row.cost_cents;
    providerTotals[prov] += row.cost_cents;
  }
  const purposeDaily = {}, purposeTotals = {};
  for (const row of (data.dailyByPurpose || [])) {
    if (!purposeDaily[row.purpose]) { purposeDaily[row.purpose] = {}; purposeTotals[row.purpose] = 0; }
    purposeDaily[row.purpose][row.date] = (purposeDaily[row.purpose][row.date] || 0) + row.cost_cents;
    purposeTotals[row.purpose] += row.cost_cents;
  }
  const providers = Object.keys(providerTotals).sort((a, b) => providerTotals[b] - providerTotals[a]);
  const purposes = Object.keys(purposeTotals).sort((a, b) => purposeTotals[b] - purposeTotals[a]);

  // Unified grid: bar chart + provider + use case, all in one table for perfect vertical alignment
  if (dates.length) {
    const maxCents = Math.max(...dates.map(d => dailyTotals[d] || 0), 1);
    const chartHeight = 120;
    const labelEvery = dates.length > 14 ? Math.ceil(dates.length / 7) : 1;

    html += '<div class="acct-card"><div class="usage-grid-wrap"><table class="usage-grid">';

    // Header: date labels
    html += '<thead><tr><th class="usage-grid-label"></th>';
    for (let i = 0; i < dates.length; i++) {
      const label = i % labelEvery === 0 ? dates[i].slice(5) : '';
      html += `<th class="usage-grid-date" title="${dates[i]}">${label}</th>`;
    }
    html += '<th class="usage-grid-total">Total</th></tr></thead><tbody>';

    // Bar chart row
    html += `<tr class="usage-chart-row"><td class="usage-grid-label" style="vertical-align:bottom;font-size:10px;color:var(--muted)">Daily</td>`;
    for (const d of dates) {
      const cents = dailyTotals[d] || 0;
      const h = Math.max(Math.round((cents / maxCents) * chartHeight), 1);
      const summary = dailySummaries[d];
      const tip = summary ? `${d}: ${fmt(cents)}\n${summary.map(s => `  ${s.purpose}: ${fmt(s.cents)}`).join('\n')}` : `${d}: ${fmt(cents)}`;
      const highlight = summary ? ' usage-bar-hot' : '';
      html += `<td class="usage-chart-cell" title="${esc(tip)}"><div class="usage-inline-bar${highlight}" style="height:${h}px"></div></td>`;
    }
    html += `<td class="usage-grid-total">${fmt(data.totalCents)}</td></tr>`;

    // Daily totals row
    html += '<tr class="usage-grid-footer"><td class="usage-grid-label">Daily Total</td>';
    for (const d of dates) {
      const cents = dailyTotals[d] || 0;
      html += `<td class="usage-grid-cell usage-grid-total-cell">${fmt(cents)}</td>`;
    }
    html += `<td class="usage-grid-total usage-grid-grand">${fmt(data.totalCents)}</td></tr>`;

    // Separator
    html += '<tr class="usage-grid-section"><td colspan="' + (dates.length + 2) + '">By Provider</td></tr>';

    // Provider rows
    for (const key of providers) {
      html += `<tr><td class="usage-grid-label">${esc(key)}</td>`;
      for (const d of dates) {
        const cents = providerDaily[key]?.[d] || 0;
        const intensity = data.totalCents > 0 && cents > 0 ? Math.round((cents / data.totalCents) * 300) : 0;
        const bg = intensity > 0 ? `background:color-mix(in srgb, var(--accent) ${Math.min(intensity, 15)}%, transparent)` : '';
        html += `<td class="usage-grid-cell" style="${bg}" title="${d}: ${cents > 0 ? fmt(cents) : '$0'}">${fmt(cents)}</td>`;
      }
      html += `<td class="usage-grid-total">${fmt(providerTotals[key])}</td></tr>`;
    }

    // Separator
    html += '<tr class="usage-grid-section"><td colspan="' + (dates.length + 2) + '">By Use Case</td></tr>';

    // Purpose rows
    for (const key of purposes) {
      html += `<tr><td class="usage-grid-label">${esc(key)}</td>`;
      for (const d of dates) {
        const cents = purposeDaily[key]?.[d] || 0;
        const intensity = data.totalCents > 0 && cents > 0 ? Math.round((cents / data.totalCents) * 300) : 0;
        const bg = intensity > 0 ? `background:color-mix(in srgb, var(--accent) ${Math.min(intensity, 15)}%, transparent)` : '';
        html += `<td class="usage-grid-cell" style="${bg}" title="${d}: ${cents > 0 ? fmt(cents) : '$0'}">${fmt(cents)}</td>`;
      }
      html += `<td class="usage-grid-total">${fmt(purposeTotals[key])}</td></tr>`;
    }

    html += '</tbody></table></div></div>';
  }

  feed.innerHTML = html;
}

function buildDailyGrid(dates, rowKeys, dailyMap, rowTotals, colTotals) {
  const labelEvery = dates.length > 14 ? Math.ceil(dates.length / 7) : 1;

  // Find global max cell for shading (light tints only)
  let globalMax = 0;
  for (const key of rowKeys) {
    for (const d of dates) {
      const c = dailyMap[key]?.[d] || 0;
      if (c > globalMax) globalMax = c;
    }
  }

  let html = '<div class="usage-grid-wrap"><table class="usage-grid"><thead><tr><th class="usage-grid-label"></th>';
  for (let i = 0; i < dates.length; i++) {
    const label = i % labelEvery === 0 ? dates[i].slice(5) : '';
    html += `<th class="usage-grid-date" title="${dates[i]}">${label}</th>`;
  }
  html += '<th class="usage-grid-total">Total</th></tr></thead><tbody>';

  for (const key of rowKeys) {
    html += `<tr><td class="usage-grid-label">${esc(key)}</td>`;
    for (const d of dates) {
      const cents = dailyMap[key]?.[d] || 0;
      // Light tint: max 20% opacity, proportional to global max
      const intensity = globalMax > 0 && cents > 0 ? Math.round((cents / globalMax) * 20) : 0;
      const bg = intensity > 0 ? `background:color-mix(in srgb, var(--accent) ${Math.max(intensity, 4)}%, transparent)` : '';
      const val = cents > 0 ? '$' + (cents / 100).toFixed(2) : '';
      html += `<td class="usage-grid-cell" style="${bg}" title="${d}: ${val || '$0'}">${val}</td>`;
    }
    html += `<td class="usage-grid-total">${fmt(rowTotals[key])}</td></tr>`;
  }

  // Footer: daily totals — should match bar chart
  html += '<tr class="usage-grid-footer"><td class="usage-grid-label">Total</td>';
  for (const d of dates) {
    const cents = colTotals[d] || 0;
    html += `<td class="usage-grid-cell usage-grid-total-cell">${fmt(cents)}</td>`;
  }
  const grandTotal = Object.values(rowTotals).reduce((s, v) => s + v, 0);
  html += `<td class="usage-grid-total usage-grid-grand">${fmt(grandTotal)}</td></tr>`;

  html += '</tbody></table></div>';
  return html;
}

function fmt(cents) { return '$' + (cents / 100).toFixed(2); }

function modelToProvider(model) {
  if (model.startsWith('claude')) return 'Anthropic';
  if (model.startsWith('gemini')) return 'Google';
  if (model.startsWith('grok')) return 'xAI';
  if (model.startsWith('llama') || model.startsWith('mistral') || model.startsWith('nomic')) return 'Local';
  return model;
}

function setUsageRange(days) {
  usageDays = days;
  renderUsage();
}

// Shared date utilities (loaded before app.js)
function formatDate(s) {
  try { return new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return s; }
}
function formatSyncAge(s) {
  if (!s) return 'never';
  try {
    const ms = Date.now() - new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z').getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
  } catch { return s; }
}
