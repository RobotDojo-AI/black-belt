/**
 * Format skill — rendering engine.
 * Renders a SEGS array into a Google Doc using the canonical memo style.
 *
 * Style:
 *   - All NORMAL_TEXT — no heading styles
 *   - Font: Inter, lineSpacing: 115, no explicit spaceAbove/spaceBelow
 *   - Hierarchy: bold headers only; bullets and body text are NOT bold
 *   - Bullet glyph: ● (filled circle), indent 36
 *   - Blank \n paragraphs used as spacers (not padding properties)
 *
 * Segment shape:
 *   { type, text }                       — plain segment (text is a string)
 *   { type, runs: [{ t, link? }, ...] }  — rich segment; concatenated runs,
 *                                          runs carrying `link` get linked +
 *                                          underlined + link-blue. Use this to
 *                                          link a name inside a line without
 *                                          linking the whole line.
 *   types: 'h' header(bold) · 'b' bullet · 'b2' nested · 'b3' nested-2 · '_' spacer · 'pb' page break · else body
 *   Nested bullets: leading tabs in the inserted text (b2 = 1 tab, b3 = 2 tabs).
 *   createParagraphBullets counts those tabs as nesting level. Tabs are consumed
 *   when bullets are applied. Do not indent after bullets — that leaves nestingLevel 0.
 */
import { getValidAccessToken } from '../../../lib/google-oauth.js';

const DOCS_API = 'https://docs.googleapis.com/v1';

async function gFetch(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Docs ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}

/**
 * Render a SEGS array into a Google Doc.
 * @param {string} docId - Google Doc ID
 * @param {string} accountEmail - Google account email for OAuth
 * @param {Array} segments - Array of segment objects from a content file
 * @returns {{ charCount: number, requestCount: number }}
 */
export async function render(docId, accountEmail, segments) {
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    throw new Error('segments must be a non-empty array');
  }

  const token = await getValidAccessToken(accountEmail);
  if (!token) throw new Error(`No valid OAuth token for ${accountEmail}`);

  // ── Compute positions ──────────────────────────────────────────────────────
  let fullText = '';
  const positioned = [];
  let offset = 1;
  const pageBreaks = [];

  for (const seg of segments) {
    if (seg.type === 'pb') { pageBreaks.push(offset); continue; }
    const segText = seg.runs ? seg.runs.map(r => r.t).join('') : seg.text;
    const nest = seg.type === 'b3' ? 2 : seg.type === 'b2' ? 1 : 0;
    const prefix = nest ? '\t'.repeat(nest) : '';
    const line = prefix + segText + '\n';
    positioned.push({ ...seg, start: offset, prefixLen: prefix.length, end: offset + line.length });
    fullText += line;
    offset += line.length;
  }

  // ── Build requests ─────────────────────────────────────────────────────────
  const requests = [];

  // 1. Insert all text at once
  requests.push({ insertText: { location: { index: 1 }, text: fullText } });

  // 2. Per segment: lineSpacing + font + bold
  for (const seg of positioned) {
    if (seg.type === '_') {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: seg.start, endIndex: seg.end },
          paragraphStyle: { lineSpacing: 115 },
          fields: 'lineSpacing',
        },
      });
      continue;
    }
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: seg.start, endIndex: seg.end },
        paragraphStyle: { lineSpacing: 115 },
        fields: 'lineSpacing',
      },
    });
    requests.push({
      updateTextStyle: {
        range: { startIndex: seg.start, endIndex: seg.end - 1 },
        textStyle: {
          bold: seg.type === 'h',
          weightedFontFamily: { fontFamily: 'Inter' },
        },
        fields: 'bold,weightedFontFamily',
      },
    });
  }

  // 3. Rich runs — runs carrying `bold` and/or `link` get per-run styling
  for (const seg of positioned) {
    if (!seg.runs) continue;
    let ro = seg.start + (seg.prefixLen || 0);
    for (const r of seg.runs) {
      if ((r.bold || r.link) && r.t.length > 0) {
        const textStyle = {};
        const fields = [];
        if (r.bold) {
          textStyle.bold = true;
          textStyle.weightedFontFamily = { fontFamily: 'Inter' };
          fields.push('bold', 'weightedFontFamily');
        }
        if (r.link) {
          textStyle.link = { url: r.link };
          textStyle.underline = true;
          textStyle.foregroundColor = { color: { rgbColor: { red: 0.07, green: 0.39, blue: 0.85 } } };
          fields.push('link', 'underline', 'foregroundColor');
        }
        requests.push({
          updateTextStyle: {
            range: { startIndex: ro, endIndex: ro + r.t.length },
            textStyle,
            fields: fields.join(','),
          },
        });
      }
      ro += r.t.length;
    }
  }

  // 4. Bullet groups — b / b2 / b3 stay in one list so nesting can take.
  //    Leading tabs are consumed as nestingLevel; later groups shift left
  //    by tabs already consumed in earlier groups.
  let bStart = null, bEnd = null, groupTabs = 0, tabsConsumed = 0;
  const flush = () => {
    if (bStart !== null) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: bStart - tabsConsumed, endIndex: bEnd - tabsConsumed },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
      tabsConsumed += groupTabs;
      bStart = null; bEnd = null; groupTabs = 0;
    }
  };
  for (const seg of positioned) {
    if (seg.type === 'b' || seg.type === 'b2' || seg.type === 'b3') {
      if (bStart === null) bStart = seg.start;
      bEnd = seg.end;
      groupTabs += seg.prefixLen || 0;
    } else flush();
  }
  flush();

  // 5. Page breaks — last, reverse order. Subtract tabs already consumed by bullets.
  for (const idx of [...pageBreaks].reverse()) {
    const tabsBefore = positioned
      .filter(s => s.prefixLen && s.start < idx)
      .reduce((n, s) => n + s.prefixLen, 0);
    requests.push({ insertPageBreak: { location: { index: idx - tabsBefore } } });
  }

  // ── Execute ────────────────────────────────────────────────────────────────
  const doc = await gFetch(`${DOCS_API}/documents/${docId}`, token);
  const endIndex = doc.body.content.at(-1)?.endIndex ?? 1;

  if (endIndex > 2) {
    await gFetch(`${DOCS_API}/documents/${docId}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }] }),
    });
  }

  const CHUNK = 400;
  for (let i = 0; i < requests.length; i += CHUNK) {
    await gFetch(`${DOCS_API}/documents/${docId}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({ requests: requests.slice(i, i + CHUNK) }),
    });
  }

  return { charCount: fullText.length, requestCount: requests.length };
}
