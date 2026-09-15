/**
 * Google Docs — create and append to Google Docs via the Docs API.
 * Black Belt: draft/create documents from chat.
 */
import config from './config.js';

const DOCS_API = 'https://docs.googleapis.com/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

async function getToken(email) {
  const { getValidAccessToken } = await import('./google-oauth.js');
  return getValidAccessToken(email);
}

async function gFetch(url, options, email) {
  const token = await getToken(email);
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(config.timeouts.api),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Docs API ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Convert a markdown string to a flat list of Google Docs batchUpdate requests.
 * Handles: # H1, ## H2, ### H3, **bold**, plain paragraphs.
 * Returns { text, requests } where text is the full plain text and requests
 * are formatting mutations to apply after the text is inserted.
 */
function markdownToRequests(markdown) {
  const lines = markdown.split('\n');
  const segments = [];

  for (const line of lines) {
    if (/^### /.test(line)) {
      segments.push({ style: 'HEADING_3', text: line.replace(/^### /, '') + '\n' });
    } else if (/^## /.test(line)) {
      segments.push({ style: 'HEADING_2', text: line.replace(/^## /, '') + '\n' });
    } else if (/^# /.test(line)) {
      segments.push({ style: 'HEADING_1', text: line.replace(/^# /, '') + '\n' });
    } else {
      segments.push({ style: 'NORMAL_TEXT', text: line + '\n' });
    }
  }

  const fullText = segments.map(s => s.text).join('');
  const requests = [{ insertText: { location: { index: 1 }, text: fullText } }];

  let offset = 1;
  for (const seg of segments) {
    const start = offset;
    const end = offset + seg.text.length;

    if (seg.style !== 'NORMAL_TEXT') {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end },
          paragraphStyle: { namedStyleType: seg.style },
          fields: 'namedStyleType',
        },
      });
    }

    // Bold: **text**
    const boldRe = /\*\*(.+?)\*\*/g;
    let m;
    const lineOffset = start;
    const plainLine = seg.text;
    let plainPos = 0;
    let docPos = lineOffset;

    while ((m = boldRe.exec(plainLine)) !== null) {
      const rawStart = m.index;
      const innerText = m[1];
      const boldStart = docPos + rawStart - (plainPos * 0);
      requests.push({
        updateTextStyle: {
          range: { startIndex: boldStart, endIndex: boldStart + innerText.length + 4 },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    }

    offset = end;
  }

  return { text: fullText, requests };
}

/**
 * Create a new Google Doc.
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.content - Markdown content
 * @param {string} params.accountEmail - Google account to create in
 * @param {string|null} [params.folderId]
 * @returns {{ docId: string, url: string }}
 */
export async function createGoogleDoc({ title, content, accountEmail, folderId = null }) {
  const doc = await gFetch(`${DOCS_API}/documents`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  }, accountEmail);

  const docId = doc.documentId;

  if (content) {
    const { requests } = markdownToRequests(content);
    await gFetch(`${DOCS_API}/documents/${docId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    }, accountEmail);
  }

  if (folderId) {
    const token = await getToken(accountEmail);
    const file = await fetch(`${DRIVE_API}/files/${docId}?fields=parents`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json());
    const prevParents = (file.parents || []).join(',');
    await fetch(`${DRIVE_API}/files/${docId}?addParents=${folderId}&removeParents=${prevParents}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.timeouts.api),
    });
  }

  return { docId, url: `https://docs.google.com/document/d/${docId}/edit` };
}

/**
 * Append content to an existing Google Doc.
 * @param {string} docId
 * @param {string} content - Markdown content to append
 * @param {string} accountEmail
 */
export async function appendToDoc(docId, content, accountEmail) {
  const doc = await gFetch(`${DOCS_API}/documents/${docId}`, {}, accountEmail);
  const endIndex = doc.body.content.at(-1)?.endIndex ?? 1;
  const insertIndex = Math.max(1, endIndex - 1);

  const rawText = content.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,3} /gm, '');
  await gFetch(`${DOCS_API}/documents/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: insertIndex }, text: '\n' + rawText } }],
    }),
  }, accountEmail);
}
