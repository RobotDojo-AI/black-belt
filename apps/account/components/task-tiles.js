/**
 * Task tiles — onboarding guidance at the top of the integrations page.
 * st_42799dbe AC 6/7.
 *
 * Three dismissable tiles in fixed display order (set by the backend
 * /api/setup-steps endpoint per AC 6):
 *   1. integrate_accounts  — Google "proceed with caution" guidance
 *   2. installation_faq    — public docs chat link
 *   3. assistant_intro     — @miyagi prompt
 *
 * Each tile has an X button. Clicking X fires DELETE /api/setup-steps/:step
 * and removes the tile from the DOM immediately (optimistic). The backend
 * persists `dismissed_at` so the tile stays gone after reload. NO localStorage
 * is used — DB is the source of truth (AC 7).
 *
 * WHY a vanilla function vs a framework component: this codebase ships
 * no bundler or framework. The component is a single async function that
 * mounts into a DOM node and re-renders on dismissal.
 */

// Static copy for each tile. Source of truth lives in 00-scope.md AC 6.
// WHY in JS not the API: the backend stores step keys only — copy lives in
// the frontend so we can iterate without a schema migration.
const TILE_COPY = {
  integrate_accounts: {
    icon: 'electrical_services',
    title: 'Integrate all accounts',
    body: "When you connect Google, you'll see a 'proceed with caution' screen — that's because Robot Dojo is awaiting Google certification, not because anything is unsafe. Click 'Advanced' and continue to grant access.",
  },
  installation_faq: {
    icon: 'help',
    title: 'Installation help',
    body: "Stuck on a step? Open the public docs chat for installation, integrations, and troubleshooting answers.",
    actionLabel: 'Open Ask',
    actionHref: '/ask',
  },
  assistant_intro: {
    icon: 'auto_awesome',
    title: 'Ask @miyagi anything',
    body: "Normal chat already uses your memory. Mention @miyagi for product guidance or when you want to save a Topic, identity/context change, or durable fact on purpose.",
  },
};

/**
 * Mount the task tiles into the given container element. Re-fetches state
 * from /api/setup-steps each call so external dismissals (e.g. another
 * tab) reflect on the next render.
 *
 * @param {HTMLElement} containerEl - element to receive the tiles
 * @param {object} [opts]
 *   - onDismiss: optional callback fired after a successful DELETE
 */
async function mountTaskTiles(containerEl, opts = {}) {
  if (!containerEl) return;

  let steps = [];
  try {
    const data = await fetchJSON('/api/setup-steps');
    steps = Array.isArray(data?.steps) ? data.steps : [];
  } catch (err) {
    // Silent failure — task tiles are optional UI. Don't block integrations.
    console.warn('[task-tiles] fetch failed:', err?.message || err);
    containerEl.innerHTML = '';
    return;
  }

  if (steps.length === 0) {
    // All tiles dismissed — render nothing. AC 7 implicit: dismissed state
    // means tile disappears completely.
    containerEl.innerHTML = '';
    return;
  }

  containerEl.innerHTML = steps.map(({ step }) => _renderTile(step)).join('');

  // Wire up dismiss buttons. WHY delegation not per-element: keeps the
  // markup template-clean and avoids re-binding on re-render.
  containerEl.querySelectorAll('[data-task-dismiss]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const step = btn.getAttribute('data-task-dismiss');
      if (!step) return;
      // Optimistic remove — server confirms below; on failure we re-mount
      // so the tile reappears (rare; the only failure modes are network
      // or auth, and the route is idempotent).
      const tileEl = btn.closest('.task-tile');
      if (tileEl) tileEl.remove();
      try {
        await fetchJSON(`/api/setup-steps/${encodeURIComponent(step)}`, { method: 'DELETE' });
        if (typeof opts.onDismiss === 'function') opts.onDismiss(step);
      } catch (err) {
        console.warn('[task-tiles] dismiss failed:', err?.message || err);
        // Re-mount on failure so the user sees the tile didn't actually go away.
        mountTaskTiles(containerEl, opts);
      }
    });
  });
}

function _renderTile(step) {
  const copy = TILE_COPY[step];
  if (!copy) {
    // Unknown step from backend (forward-compat) — render minimal placeholder.
    return `<div class="task-tile" data-step="${_escAttr(step)}">
      <span class="material-symbols-outlined task-tile-icon">label</span>
      <div class="task-tile-body"><div class="task-tile-title">${_escHtml(step)}</div></div>
      <button class="task-tile-dismiss" data-task-dismiss="${_escAttr(step)}" aria-label="Dismiss">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>`;
  }
  const action = copy.actionHref
    ? `<a class="task-tile-action" href="${_escAttr(copy.actionHref)}">${_escHtml(copy.actionLabel || 'Open')}</a>`
    : '';
  return `<div class="task-tile" data-step="${_escAttr(step)}">
    <span class="material-symbols-outlined task-tile-icon">${_escAttr(copy.icon)}</span>
    <div class="task-tile-body">
      <div class="task-tile-title">${_escHtml(copy.title)}</div>
      <div class="task-tile-text">${_escHtml(copy.body)}</div>
      ${action}
    </div>
    <button class="task-tile-dismiss" data-task-dismiss="${_escAttr(step)}" aria-label="Dismiss">
      <span class="material-symbols-outlined">close</span>
    </button>
  </div>`;
}

// Minimal escapers — no DOMPurify dependency for static text content.
function _escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function _escAttr(s) { return _escHtml(s); }

// Expose globally — apps/account/app.js is a non-module script.
window.mountTaskTiles = mountTaskTiles;
