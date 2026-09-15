/**
 * Parse a topic workbench LOG.md into sessions and pick the ones a query needs.
 * Web chat and Recap use the same log the coding agent reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { REPO_ROOT } from './robotdojo-paths.js';

const SESSION_HEAD = /^## Work session\s+(\d{4}-\d{2}-\d{2})(?:[^\n]*)/gm;
const STOP = new Set([
  'about', 'after', 'again', 'could', 'does', 'from', 'have', 'into',
  'just', 'like', 'more', 'some', 'than', 'that', 'their', 'them', 'then',
  'there', 'these', 'this', 'those', 'what', 'when', 'where', 'which', 'with',
  'would', 'your', 'resume',
]);

export function logSearchTokens(q) {
  return [...new Set(String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 5 && !STOP.has(t)))]
    .slice(0, 8);
}

export function splitLogSessions(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const matches = [...raw.matchAll(SESSION_HEAD)];
  if (!matches.length) {
    return [{
      date: '',
      title: '',
      body: raw.trim(),
      decision: extractSection(raw, 'Decision'),
      why: extractSection(raw, 'Why'),
      citations: extractSection(raw, 'Citations'),
      next: extractSection(raw, 'Next-session anchors'),
    }].filter((s) => s.body);
  }
  return matches.map((match, i) => {
    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    const body = raw.slice(start, end).trim();
    const titleLine = body.split('\n').find((line) => /^#\s+/.test(line.trim()) && !/^##\s+/.test(line.trim()));
    return {
      date: match[1],
      title: titleLine ? titleLine.replace(/^#\s+/, '').trim() : `Session ${match[1]}`,
      body,
      decision: extractSection(body, 'Decision'),
      why: extractSection(body, 'Why'),
      citations: extractSection(body, 'Citations'),
      next: extractSection(body, 'Next-session anchors'),
    };
  });
}

function extractSection(text, heading) {
  const re = new RegExp(`(?:^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : '';
}

export function scoreLogSession(session, query) {
  const tokens = logSearchTokens(query);
  if (!tokens.length) return 0;
  const hay = String(session.body || '').toLowerCase();
  return tokens.reduce((n, token) => n + (hay.includes(token) ? 1 : 0), 0);
}

export function memoryBudgetChars(responseMode = 'context') {
  if (responseMode === 'deep') return 12_000;
  if (responseMode === 'fast') return 2_000;
  return 4_000;
}

export function selectLogSessions(sessions, query, { budgetChars = 4000, maxSessions = 12, limit } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return [];
  const cap = Math.max(1, Math.min(Number(limit || maxSessions) || 12, 24));
  const scored = list.map((session) => ({ session, score: scoreLogSession(session, query) }));
  const hits = scored.filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || String(b.session.date).localeCompare(String(a.session.date)));
  const ranked = hits.length
    ? hits
    : list.slice(-cap).map((session) => ({ session, score: 0 }));
  const chrono = [...ranked]
    .map((row) => row.session)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let picked = chrono.slice(Math.max(0, chrono.length - cap));
  const budget = Math.max(400, Number(budgetChars) || 4000);
  while (picked.length > 1 && formatLogSessions(picked).length > budget) {
    picked = picked.slice(1);
  }
  return picked;
}

export function latestLogSession(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return list.length ? list[list.length - 1] : null;
}

function sessionMemoryBody(session, sessionChars) {
  const parts = [
    session.decision && `## Decision\n${session.decision}`,
    session.why && `## Why\n${session.why}`,
    session.citations && `## Citations\n${session.citations}`,
    session.next && `## Next-session anchors\n${session.next}`,
  ].filter(Boolean);
  const structured = parts.join('\n\n').trim();
  const raw = (structured || session.body || '').trim();
  const cap = Math.max(400, Math.min(Number(sessionChars) || 2800, 8000));
  if (raw.length <= cap) return raw;
  return raw.slice(0, cap).trimEnd() + '\n…';
}

export function formatLogSessions(sessions, { historyUrl = '', sessionChars = 2800, heading = 'Memory' } = {}) {
  if (!sessions?.length) return '';
  const blocks = sessions.map((session) => {
    const head = [session.date, session.title].filter(Boolean).join(' — ');
    return [`### ${head}`, sessionMemoryBody(session, sessionChars)].filter(Boolean).join('\n');
  });
  const cite = historyUrl
    ? `When you answer from the past, quote the relevant passage, then link ${historyUrl}.`
    : '';
  const title = String(heading || 'Memory').trim() || 'Memory';
  return [`## ${title}`, cite, ...blocks].filter(Boolean).join('\n\n');
}

export function readLogFile(rootPath, repoRoot = REPO_ROOT) {
  if (!rootPath) return '';
  const abs = isAbsolute(rootPath)
    ? join(rootPath, 'LOG.md')
    : join(repoRoot, rootPath, 'LOG.md');
  if (!existsSync(abs)) return '';
  return readFileSync(abs, 'utf8');
}

export function isScaffoldProjection(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return true;
  return /Default topic workbench created as the canonical landing zone/i.test(s)
    || /Registered workbench substrate is ready to resume/i.test(s)
    || /not a health-condition entity/i.test(s)
    || /personal\/health topic workbench/i.test(s)
    || /Health remains a personal/i.test(s)
    || /Continue from the newest source-backed synthesis/i.test(s)
    || /Continue from this log/i.test(s);
}

/** Seeded first sessions that copied a context card, or empty scaffold. */
export function isPlaceholderLogSession(session) {
  if (!session) return true;
  const decision = String(session.decision || '').trim();
  if (!decision || isScaffoldProjection(decision)) return true;
  const next = String(session.next || '');
  if (/Continue from this log/i.test(next) && !String(session.why || '').trim()) return true;
  return false;
}

export function projectionFromLog(rootPath, repoRoot = REPO_ROOT) {
  const sessions = splitLogSessions(readLogFile(rootPath, repoRoot));
  const real = [...sessions].reverse().find((s) => !isPlaceholderLogSession(s));
  const last = real || latestLogSession(sessions);
  if (!last) return { latestState: '', nextAction: '' };
  const latestState = String(last.decision || '').trim();
  const nextLines = String(last.next || '').split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  const nextAction = nextLines.join('\n');
  return { latestState, nextAction, why: String(last.why || '').trim(), date: last.date, title: last.title };
}
