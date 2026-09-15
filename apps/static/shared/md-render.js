/**
 * apps/static/shared/md-render.js — shared markdown renderer.
 *
 * Exposes window.renderMarkdown(body, targetEl) for use by any SPA that
 * loads marked.min.js (and optionally purify.min.js) as global scripts.
 *
 * WHY a shared module: prevents per-SPA duplication of the marked.parse
 * call and the DOMPurify sanitization gate. One place to update the parse
 * options, one place to add sanitization rules.
 *
 * Load order: marked.min.js must be loaded before this file. purify.min.js
 * is optional — sanitization is skipped gracefully if DOMPurify is absent
 * (local-only environments without external threat model).
 */

/**
 * Render a markdown string into targetEl.
 * Clears the element and replaces its innerHTML with sanitized HTML.
 * If body is null/empty, renders a "No content yet" placeholder.
 *
 * @param {string|null} body — raw markdown string, or null
 * @param {HTMLElement} targetEl — element to render into
 */
function renderMarkdown(body, targetEl) {
  if (!body) {
    targetEl.innerHTML = '<p class="rd-no-content">No content yet.</p>';
    return;
  }
  // marked is loaded globally via /static/vendor/marked.min.js.
  // breaks:false — preserve GFM line breaks without adding <br> on every
  // soft wrap. gfm:true — GitHub Flavored Markdown (tables, fenced code, etc.).
  const html = marked.parse(body, { breaks: false, gfm: true });
  // DOMPurify is optional — if not loaded, render the parsed HTML directly.
  // In local-first deployments the threat surface is the user's own data.
  const clean = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  targetEl.innerHTML = clean;
}

window.renderMarkdown = renderMarkdown;
