/**
 * Brave Search API integration.
 * Simple web search with result formatting for LLM context injection.
 *
 * API key: robotdojo-BRAVE_API_KEY in Keychain (or BRAVE_API_KEY env).
 */
import { secret } from './config.js';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Search the web via Brave Search API.
 * @param {string} query
 * @param {object} options
 * @param {number} options.count - Number of results (default 3)
 * @param {number} options.timeoutMs - Request timeout in milliseconds (default 5000)
 * @param {boolean} options.extraSnippets - Request extra_snippets from API (default false)
 * @returns {Promise<Array<{title: string, url: string, snippet: string, extraSnippets?: string[]}>>}
 *   Returns empty array on any failure — never throws.
 */
export async function braveSearch(query, { count = 3, timeoutMs = 5000, extraSnippets = false } = {}) {
  const key = secret('BRAVE_API_KEY') || process.env.BRAVE_API_KEY;
  if (!key) return [];

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  url.searchParams.set('text_decorations', 'false');
  url.searchParams.set('extra_snippets', extraSnippets ? 'true' : 'false');

  try {
    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.error(`[brave-search] API error ${res.status}`);
      return [];
    }

    const data = await res.json();
    return (data.web?.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
      extraSnippets: Array.isArray(r.extra_snippets) ? r.extra_snippets.map(s => s.snippet || s.text || String(s)).filter(Boolean) : [],
    }));
  } catch (err) {
    console.error('[brave-search] Search failed:', err.message);
    return [];
  }
}

/**
 * Format Brave results as LLM-ready context block.
 * @param {Array<{title, url, snippet}>} results
 * @returns {string}
 */
export function formatSearchContext(results) {
  if (!results.length) return '';
  return '## Web search results\n\n' +
    results.map(r => `[${r.title}](${r.url}): ${r.snippet}`).join('\n');
}
