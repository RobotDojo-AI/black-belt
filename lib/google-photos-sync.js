/**
 * Google Photos sync via Photos Library API.
 * Stores photo metadata (no image bytes) into the `photos` table.
 * Indexed data: creation time, GPS coords, camera, filename.
 * Uses INSERT OR IGNORE — safe to re-run.
 *
 * Incremental mode (default): fetches photos created in the last 30 days.
 * Full mode (sinceDate=null, fullSync=true): pages through all media items.
 */
import db from './db.js';
import { getValidAccessToken, listConnectedGoogleAccounts } from './google-oauth.js';
import { insertTimelineEvent } from './timeline-schema.js';

const PHOTOS_BASE = 'https://photoslibrary.googleapis.com/v1';

const insertPhoto = db.prepare(`
  INSERT OR IGNORE INTO photos
    (id, account_id, filename, mime_type, creation_time,
     width, height, latitude, longitude,
     camera_make, camera_model, product_url, description)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

async function photosFetch(url, accessToken, body = null) {
  const opts = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  };

  if (body) {
    opts.method = 'POST';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);

  if (res.status === 401) throw new Error('401 Unauthorized — token may be expired or missing photoslibrary scope');
  if (res.status === 403) throw new Error('403 Forbidden — photoslibrary.readonly scope not granted; re-auth required');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Photos API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

function parseItem(item, accountId) {
  const meta = item.mediaMetadata || {};
  const photo = meta.photo || {};

  const lat = photo.latitude ?? null;
  const lon = photo.longitude ?? null;

  return [
    item.id,
    accountId,
    item.filename || '',
    item.mimeType || '',
    meta.creationTime || null,
    meta.width ? parseInt(meta.width) : null,
    meta.height ? parseInt(meta.height) : null,
    lat,
    lon,
    photo.cameraMake || null,
    photo.cameraModel || null,
    item.productUrl || null,
    item.description || null,
  ];
}

export async function syncGooglePhotosAccount(email, opts = {}) {
  const { maxItems = 2000, sinceDate, fullSync = false } = opts;

  const acctRow = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='email' AND email=?`).get(email);
  const accountId = acctRow?.id || email;

  let accessToken;
  try {
    accessToken = await getValidAccessToken(email);
  } catch (err) {
    return { synced: 0, error: err.message };
  }

  if (!accessToken) return { synced: 0, error: 'no token' };

  let synced = 0;
  let pageToken = null;

  // Build search body for incremental — use dateFilter on last 30 days or since provided date
  const useSearch = !fullSync;
  const since = sinceDate ? new Date(sinceDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const now = new Date();

  const searchBody = {
    pageSize: 100,
    filters: {
      dateFilter: {
        ranges: [{
          startDate: { year: since.getFullYear(), month: since.getMonth() + 1, day: since.getDate() },
          endDate:   { year: now.getFullYear(),   month: now.getMonth() + 1,   day: now.getDate() },
        }],
      },
    },
  };

  try {
    while (synced < maxItems) {
      let data;

      if (useSearch) {
        if (pageToken) searchBody.pageToken = pageToken;
        data = await photosFetch(`${PHOTOS_BASE}/mediaItems:search`, accessToken, searchBody);
      } else {
        const params = new URLSearchParams({ pageSize: '100' });
        if (pageToken) params.set('pageToken', pageToken);
        data = await photosFetch(`${PHOTOS_BASE}/mediaItems?${params}`, accessToken);
      }

      const items = data.mediaItems || [];
      if (!items.length) break;

      const tx = db.transaction((batch) => {
        for (const item of batch) {
          const row = parseItem(item, accountId);
          const result = insertPhoto.run(...row);
          if (result.changes > 0) {
            synced++;
            insertTimelineEvent({
              sourceType: 'photo',
              sourceId: item.id,
              eventDate: row[4] || new Date().toISOString(),
              eventType: 'photo',
              summary: item.filename || 'Photo',
              content: `${item.filename || ''}\n${row[4] || ''}`,
              metadata: { account_id: accountId, mime_type: item.mimeType || null, has_location: row[7] != null && row[8] != null },
            });
          }
        }
      });

      tx(items);

      pageToken = data.nextPageToken || null;
      if (!pageToken) break;
    }
  } catch (err) {
    console.error(`[photos] sync failed for ${email}:`, err.message);
    return { synced, error: err.message };
  }

  if (synced > 0) console.info(`[photos] synced ${synced} new photos for ${email}`);
  return { synced };
}

export async function syncAllGooglePhotosAccounts(opts = {}) {
  const accounts = listConnectedGoogleAccounts();
  if (!accounts.length) return { synced: 0, accounts: 0 };

  let total = 0;
  const errors = [];

  for (const email of accounts) {
    const result = await syncGooglePhotosAccount(email, opts);
    total += result.synced;
    if (result.error) errors.push(`${email}: ${result.error}`);
  }

  return {
    synced: total,
    accounts: accounts.length,
    ...(errors.length ? { errors } : {}),
  };
}
