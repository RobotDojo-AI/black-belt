/**
 * Google Sheets — create spreadsheets from data arrays.
 * Black Belt: create structured data documents from chat.
 */
import config from './config.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4';

async function gFetch(url, options, email) {
  const { getValidAccessToken } = await import('./google-oauth.js');
  const token = await getValidAccessToken(email);
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
    throw new Error(`Google Sheets API ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Create a new Google Sheet from a data array.
 * @param {object} params
 * @param {string} params.title
 * @param {string[][]} params.data - Row arrays (each element is a cell value)
 * @param {string[]} [params.headers] - Column headers (prepended as first row)
 * @param {string} params.accountEmail
 * @returns {{ sheetId: string, url: string }}
 */
export async function createGoogleSheet({ title, data, headers, accountEmail }) {
  const rows = [];
  if (headers && headers.length) rows.push(headers.map(String));
  for (const row of (data || [])) rows.push(row.map(v => (v == null ? '' : String(v))));

  const body = {
    properties: { title },
    sheets: [{
      properties: { title: 'Sheet1' },
      data: [{
        rowData: rows.map(row => ({
          values: row.map(v => ({ userEnteredValue: { stringValue: v } })),
        })),
      }],
    }],
  };

  const result = await gFetch(`${SHEETS_API}/spreadsheets`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, accountEmail);

  return {
    sheetId: result.spreadsheetId,
    url: result.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${result.spreadsheetId}/edit`,
  };
}
