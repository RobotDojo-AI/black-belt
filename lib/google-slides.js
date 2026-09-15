/**
 * Google Slides — create basic presentations.
 * Black Belt: create slide decks from chat.
 */
import config from './config.js';

const SLIDES_API = 'https://slides.googleapis.com/v1';

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
    throw new Error(`Google Slides API ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Create a Google Slides presentation.
 * @param {object} params
 * @param {string} params.title
 * @param {Array<{ title: string, body: string }>} params.slides
 * @param {string} params.accountEmail
 * @returns {{ presentationId: string, url: string }}
 */
export async function createPresentation({ title, slides, accountEmail }) {
  const presentation = await gFetch(`${SLIDES_API}/presentations`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  }, accountEmail);

  const presentationId = presentation.presentationId;
  const existingSlides = presentation.slides || [];

  const requests = [];

  for (let i = 0; i < (slides || []).length; i++) {
    const slide = slides[i];
    const slideId = `slide_${i}`;
    const titleId = `title_${i}`;
    const bodyId = `body_${i}`;

    if (i === 0 && existingSlides.length > 0) {
      const firstSlide = existingSlides[0];
      const titleEl = firstSlide.pageElements?.find(e => e.shape?.placeholder?.type === 'CENTERED_TITLE' || e.shape?.placeholder?.type === 'TITLE');
      const bodyEl = firstSlide.pageElements?.find(e => e.shape?.placeholder?.type === 'BODY' || e.shape?.placeholder?.type === 'SUBTITLE');

      if (titleEl) {
        requests.push({
          insertText: {
            objectId: titleEl.objectId,
            text: slide.title || '',
            insertionIndex: 0,
          },
        });
      }
      if (bodyEl && slide.body) {
        requests.push({
          insertText: {
            objectId: bodyEl.objectId,
            text: slide.body,
            insertionIndex: 0,
          },
        });
      }
    } else {
      requests.push({
        createSlide: {
          objectId: slideId,
          insertionIndex: i,
          slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
            { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId },
          ],
        },
      });
      if (slide.title) {
        requests.push({ insertText: { objectId: titleId, text: slide.title, insertionIndex: 0 } });
      }
      if (slide.body) {
        requests.push({ insertText: { objectId: bodyId, text: slide.body, insertionIndex: 0 } });
      }
    }
  }

  if (requests.length) {
    await gFetch(`${SLIDES_API}/presentations/${presentationId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    }, accountEmail);
  }

  return {
    presentationId,
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
  };
}
