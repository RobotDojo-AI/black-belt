/**
 * Compact the promoted Monarch week onto family/finances.
 * Reportable numbers only in ## Summary and chunk totals. Hidden stays in raw.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { USER_CONTEXTS_DIR, USER_ROOT } from './robotdojo-paths.js';
import { reportableNetWorth, reportableTxnSum } from './monarch-store.js';

export const MONARCH_TOPIC = 'finances';
export const MONARCH_SOURCE_TYPE = 'monarch';
export const MONARCH_CHUNK_IDS = Object.freeze([
  'portfolio',
  'accounts',
  'spend-rollups',
  'pending',
  'hidden-index',
]);

const SUMMARY_HEADING = '## Summary';
const HUMAN_TAIL_MARKERS = Object.freeze([
  '## History',
  '<!-- HUMAN-AUTHORED',
  '## Canonical run-rate',
  '## Lessons',
]);

function money(n) {
  const value = Number(n || 0);
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function txnCategory(txn) {
  return txn.category?.name || txn.category || 'Uncategorized';
}

function txnName(txn) {
  return txn.merchant?.name || txn.plaidName || txn.notes || txn.id;
}

function holdingName(pos) {
  return pos.security?.name || pos.holdings?.[0]?.name || pos.id;
}

function holdingTicker(pos) {
  return pos.security?.ticker || pos.holdings?.[0]?.ticker || '';
}

export function isHiddenTxn(txn) {
  return !!txn.hideFromReports;
}

export function isHiddenPosition(pos) {
  return !!pos.hidden;
}

export function reportableTransactions(transactions = []) {
  return transactions.filter((t) => !isHiddenTxn(t));
}

export function reportablePositions(positions = []) {
  return positions.filter((p) => !isHiddenPosition(p));
}

export function reportableAccounts(accounts = []) {
  return accounts.filter((a) => a.includeInNetWorth !== false && !a.isHidden);
}

export function spendRollups(transactions = [], { now = new Date() } = {}) {
  const year = now.toISOString().slice(0, 4);
  const day90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ytdStart = `${year}-01-01`;
  const buckets = new Map();
  for (const txn of reportableTransactions(transactions)) {
    const cat = String(txnCategory(txn));
    const amt = Number(txn.amount || 0);
    const date = String(txn.date || '').slice(0, 10);
    if (!buckets.has(cat)) buckets.set(cat, { category: cat, ytd: 0, last90: 0 });
    const row = buckets.get(cat);
    if (date >= ytdStart) row.ytd += amt;
    if (date >= day90) row.last90 += amt;
  }
  return [...buckets.values()].sort((a, b) => a.category.localeCompare(b.category));
}

export function buildSummaryMarkdown({ accounts = [], transactions = [], positions = [], manifest, history, monthCloses } = {}) {
  const reportableTxns = reportableTransactions(transactions);
  const reportablePos = reportablePositions(positions);
  const reportableAccts = reportableAccounts(accounts);
  const nw = reportableNetWorth(accounts);
  const txnSum = reportableTxnSum(transactions);
  const posTotal = reportablePos.reduce((sum, p) => sum + Number(p.totalValue || 0), 0);
  const pending = reportableTxns.filter((t) => t.pending);
  const rollups = spendRollups(transactions);

  const lines = [
    SUMMARY_HEADING,
    '',
    `Week ${manifest?.week || ''} pulled ${manifest?.pulledAt || ''}.`.trim(),
    `Reportable net worth ${money(nw)}. Reportable transaction sum ${money(txnSum)}. Positions ${money(posTotal)}.`,
    `${reportableAccts.length} reportable accounts, ${reportableTxns.length} reportable transactions (${pending.length} pending), ${reportablePos.length} reportable positions.`,
    '',
    'Accounts',
  ];
  for (const acct of reportableAccts) {
    lines.push(`- ${acct.displayName || acct.id}: ${money(acct.displayBalance ?? acct.currentBalance)}`);
  }
  lines.push('', 'Positions');
  for (const pos of reportablePos) {
    const ticker = holdingTicker(pos);
    lines.push(`- ${holdingName(pos)}${ticker ? ` (${ticker})` : ''}: qty ${pos.quantity ?? '—'} value ${money(pos.totalValue)} basis ${money(pos.basis)} @ ${pos.accountName || pos.accountId || 'account'}`);
  }
  const snaps = Array.isArray(history) ? history : [];
  if (snaps.length) {
    lines.push('', 'Portfolio snapshots');
    for (const row of snaps) {
      lines.push(`- ${row.week}: net worth ${money(row.reportableNetWorth)}, ${row.positionCount ?? '—'} positions`);
    }
  }
  const closes = Array.isArray(monthCloses) ? monthCloses : [];
  if (closes.length) {
    lines.push('', 'Month-close net worth');
    for (const row of closes) {
      const brokerage = row.byType?.brokerage;
      const extra = Number.isFinite(brokerage) ? `, brokerage ${money(brokerage)}` : '';
      lines.push(`- ${row.asOf}: ${money(row.reportableNetWorth)}${extra}`);
    }
    const latest = closes[closes.length - 1];
    const view = latest?.view;
    if (view?.mix) {
      lines.push('', `Month-end view ${view.asOf} — $ then % of column`);
      lines.push('', 'Mix $ (Personal / Roth / Trad / Total)');
      for (const [row, cols] of Object.entries(view.mix.dollars || {})) {
        lines.push(`- ${row}: ${money(cols.personal)} / ${money(cols.roth)} / ${money(cols.trad)} / ${money(cols.total)}`);
      }
      lines.push('', 'Mix % of column');
      for (const [row, cols] of Object.entries(view.mix.pct || {})) {
        lines.push(`- ${row}: ${cols.personal}% / ${cols.roth}% / ${cols.trad}% / ${cols.total}%`);
      }
      if (view.btc) {
        const b = view.btc;
        const line = (label, s) => {
          if (!s) return null;
          const n = s.mstrBtcNotional == null ? 'n/a' : `${s.mstrBtcNotional} BTC`;
          return `- ${label}: BTC ${s.coins} (${money(s.coinValue)}); MSTR ${money(s.mstrValue)} = ${n} notional; BTC+MSTR ${money(s.combinedValue)} / ${s.combinedBtcNotional ?? 'n/a'} BTC`;
        };
        lines.push('', 'BTC by book (coins vs MSTR notional)');
        for (const row of [
          line('Personal', b.personal),
          line('Roth', b.roth),
          line('Trad', b.trad),
          line('Total', b.total || b),
        ]) {
          if (row) lines.push(row);
        }
      }
      if (view.crypto?.dollars) {
        lines.push('', 'Crypto $');
        for (const [row, cols] of Object.entries(view.crypto.dollars)) {
          lines.push(`- ${row}: ${money(cols.personal)} / ${money(cols.roth)} / ${money(cols.trad)} / ${money(cols.total)}`);
        }
      }
      if (view.reserve?.dollars) {
        lines.push('', 'Gold / cash $');
        for (const [row, cols] of Object.entries(view.reserve.dollars)) {
          lines.push(`- ${row}: ${money(cols.personal)} / ${money(cols.roth)} / ${money(cols.trad)} / ${money(cols.total)}`);
        }
      }
    }
  }
  lines.push('', 'Spend rollups (reportable, YTD + last 90 days)');
  for (const row of rollups) {
    lines.push(`- ${row.category}: YTD ${money(row.ytd)}, last 90 ${money(row.last90)}`);
  }
  lines.push('', 'Pending');
  if (!pending.length) lines.push('- none');
  for (const txn of pending) {
    lines.push(`- ${txnName(txn)} ${money(txn.amount)} on ${txn.date} (pending)`);
  }
  lines.push('');
  return lines.join('\n');
}

export function humanTailIndex(existing) {
  const current = String(existing || '');
  let best = -1;
  for (const marker of HUMAN_TAIL_MARKERS) {
    const i = current.indexOf(marker);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

export function mergeSummaryPreservingHistory(existing, summary) {
  const current = String(existing || '');
  const tailIdx = humanTailIndex(current);
  const tail = tailIdx >= 0 ? current.slice(tailIdx).trimEnd() : '';
  const nextSummary = String(summary || '').trimEnd();
  if (tail) return `${nextSummary}\n\n${tail}\n`;
  return `${nextSummary}\n`;
}

export function buildMonarchChunks({ accounts = [], transactions = [], positions = [] } = {}) {
  const reportableTxns = reportableTransactions(transactions);
  const reportablePos = reportablePositions(positions);
  const reportableAccts = reportableAccounts(accounts);
  const pending = reportableTxns.filter((t) => t.pending);
  const hiddenTxns = transactions.filter(isHiddenTxn);
  const hiddenPos = positions.filter(isHiddenPosition);
  const rollups = spendRollups(transactions);

  const portfolioLines = reportablePos.map((pos) => {
    const ticker = holdingTicker(pos);
    return `${holdingName(pos)}${ticker ? ` ticker=${ticker}` : ''} qty=${pos.quantity ?? ''} value=${pos.totalValue ?? ''} basis=${pos.basis ?? ''} account=${pos.accountName || pos.accountId || ''}`;
  });
  const accountLines = reportableAccts.map((a) => `${a.displayName || a.id} balance=${a.displayBalance ?? a.currentBalance}`);
  const spendLines = rollups.map((r) => `${r.category} ytd=${r.ytd} last90=${r.last90}`);
  const pendingLines = pending.map((t) => `${txnName(t)} ${t.amount} ${t.date} pending`);
  const hiddenLines = [
    ...hiddenTxns.map((t) => `txn id=${t.id} name=${txnName(t)}`),
    ...hiddenPos.map((p) => `holding id=${p.id} name=${holdingName(p)}`),
  ];

  return [
    { source_id: 'portfolio', content: portfolioLines.join('\n') || 'No reportable positions.' },
    { source_id: 'accounts', content: accountLines.join('\n') || 'No reportable accounts.' },
    { source_id: 'spend-rollups', content: spendLines.join('\n') || 'No reportable spend rollups.' },
    { source_id: 'pending', content: pendingLines.join('\n') || 'No pending transactions.' },
    { source_id: 'hidden-index', content: hiddenLines.join('\n') || 'No hidden rows.' },
  ].map((row) => ({
    topic: MONARCH_TOPIC,
    source_type: MONARCH_SOURCE_TYPE,
    source_id: row.source_id,
    chunk_index: 0,
    content: row.content,
    metadata: JSON.stringify({ source: 'monarch-compact' }),
    token_count: Math.ceil(row.content.length / 4),
    embedded: 0,
    skip_embed: 0,
  }));
}

export function replaceMonarchChunks(database, chunks) {
  if (!database) return { written: 0, deleted: 0 };
  const sourceIds = chunks.map((c) => c.source_id);
  let deleted = 0;
  const tx = database.transaction(() => {
    if (sourceIds.length) {
      const placeholders = sourceIds.map(() => '?').join(',');
      const result = database.prepare(`
        DELETE FROM chunks
         WHERE source_type = ?
           AND source_id NOT IN (${placeholders})
      `).run(MONARCH_SOURCE_TYPE, ...sourceIds);
      deleted = result.changes || 0;
    } else {
      const result = database.prepare(`DELETE FROM chunks WHERE source_type = ?`).run(MONARCH_SOURCE_TYPE);
      deleted = result.changes || 0;
    }
    const insert = database.prepare(`
      INSERT INTO chunks
        (topic, source_type, source_id, chunk_index, content, metadata, token_count, embedded, skip_embed, created_at)
      VALUES
        (@topic, @source_type, @source_id, @chunk_index, @content, @metadata, @token_count, @embedded, @skip_embed, datetime('now'))
      ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
        content=excluded.content,
        metadata=excluded.metadata,
        token_count=excluded.token_count,
        embedded=CASE WHEN chunks.content IS excluded.content THEN chunks.embedded ELSE 0 END,
        skip_embed=excluded.skip_embed
    `);
    for (const chunk of chunks) insert.run(chunk);
  });
  tx();
  return { written: chunks.length, deleted };
}

export function financesDiskPath() {
  return join(USER_CONTEXTS_DIR, 'topics', 'family', 'finances', 'context.md');
}

function synthesisPath() {
  return join(USER_ROOT, 'workbenches', 'topics', 'family', 'finances', 'wk_finances', 'SYNTHESIS.md');
}

export async function compactMonarchWeek({
  snapshot,
  database,
  applyContext = null,
  diskPath,
  existingContextMd,
} = {}) {
  if (!snapshot) throw new Error('compactMonarchWeek: snapshot required');
  const summary = buildSummaryMarkdown(snapshot);
  let existing = existingContextMd;
  if (existing == null && database) {
    try {
      existing = database.prepare('SELECT context_md FROM user_topics WHERE slug = ?').get(MONARCH_TOPIC)?.context_md || '';
    } catch { existing = ''; }
  }
  const contextMd = mergeSummaryPreservingHistory(existing, summary);
  const targetDisk = diskPath || financesDiskPath();
  mkdirSync(dirname(targetDisk), { recursive: true });
  writeFileSync(targetDisk, contextMd, 'utf8');

  // Never touch the workbench synthesis file.
  const synthesis = synthesisPath();
  if (existsSync(synthesis) && targetDisk === synthesis) {
    throw new Error('compactMonarchWeek: refused to overwrite SYNTHESIS.md');
  }

  if (database) {
    const apply = applyContext || (await import('./topic-context-apply.js')).applyTopicContext;
    await apply(database, {
      slug: MONARCH_TOPIC,
      contextMd,
      sourceType: MONARCH_SOURCE_TYPE,
      source: 'monarch-compact',
    });
  }

  const chunks = buildMonarchChunks(snapshot);
  const chunkResult = replaceMonarchChunks(database, chunks);
  return { summary, contextMd, chunks, ...chunkResult };
}
