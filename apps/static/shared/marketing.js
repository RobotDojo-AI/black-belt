/* Robot Dojo — Marketing Shell
   Renders the Private Beta banner, nav, and footer on all marketing pages.
   WHY shared: every marketing page calls initMarketing() in a small inline
   <script type="module">; consistency across surfaces is enforced here, not
   duplicated in each HTML file. */

// st_85ca4f3c — the "Connect" nav CTA now points at /connect (not /chat).
// /chat is middleware-gated; for an anonymous visitor it falls through to
// /login?reason=server_required, leaving the address bar saying "/login"
// while the page title says "Connect". /connect serves the same login page
// directly, so the URL the user sees matches the button they clicked.
const CONNECT_URL = '/connect';

// NAV_LINKS — ordered left-to-right. Install opens a modal with the terminal
// one-liner; Connect is the right-side app/login entry.
// st_85ca4f3c — FAQ opens in a new tab: it's the public chat surface, a
// destination the visitor wants to keep open while still browsing the
// marketing site they came from. rel=noopener is mandatory whenever
// target=_blank to block the opened page from controlling the opener.
const NAV_LINKS = [
  { label: 'Install', modal: 'install' },
];

// ─── Private Beta banner ─────────────────────────────────────────
//
// WHY this exists: access to robotdojo.ai is gated by manually granted keys.
// The banner makes the access model explicit at the top of every marketing
// page so a private-beta visitor understands the install path.
//
// WHY position:sticky over fixed: sticky stays in document flow so layouts
// below don't need padding-top offsets; it also avoids covering content on
// narrow viewports where a fixed header eats vertical space.
export function renderBetaBanner() {
  // Idempotent: if the page already has a static banner element (apps/index.html
  // ships one inline so SSR/curl tests see the banner copy in the raw body),
  // skip injection. Other marketing pages have no static banner — this branch
  // injects it dynamically.
  if (document.querySelector('.m-beta-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'm-beta-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.textContent = 'Private beta. 90 days of Black Belt on install.';
  document.body.prepend(banner);
}

export function renderNav() {
  const existing = document.querySelector('.m-nav.marketing-nav');
  if (existing) {
    _injectInstallModal();
    _bindNav(existing);
    _bindModalTriggers();
    return;
  }

  const nav = document.createElement('nav');
  nav.className = 'm-nav marketing-nav';
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', 'Main');

  // Build nav link HTML from NAV_LINKS. WHY data-modal vs href: install
  // opens the install modal (terminal one-liner); other entries are real
  // page links.
  const linkHtml = NAV_LINKS.map((l) => {
    if (l.modal) return `<a class="m-nav-link" href="#" data-modal="${l.modal}">${l.label}</a>`;
    const targetAttr = l.target === '_blank' ? ' target="_blank" rel="noopener"' : '';
    return `<a class="m-nav-link" href="${l.href}"${targetAttr}>${l.label}</a>`;
  }).join('\n      ');

  nav.innerHTML = `
    <a href="/" class="m-nav-brand" aria-label="Robot Dojo home">
      <img src="/static/img/logo.svg" alt="Robot Dojo" width="36" height="36">
      <span class="m-nav-brand-text">
        <span class="m-nav-brand-name">Robot Dojo</span>
      </span>
    </a>
    <button class="m-hamburger" aria-label="Menu" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <div class="m-nav-links">
      ${linkHtml}
      <a class="m-btn m-btn-primary m-nav-cta" href="${CONNECT_URL}">Connect</a>
    </div>
  `;

  // WHY appendChild after the banner (which is already prepended): the
  // banner sits at document top; the nav appears immediately beneath it.
  // Both are sticky via CSS.
  document.body.appendChild(nav);
  // Move the nav up so it directly follows the banner in document order.
  const banner = document.querySelector('.m-beta-banner');
  if (banner) banner.parentNode.insertBefore(nav, banner.nextSibling);

  // Install modal
  _injectInstallModal();
  _bindNav(nav);
  _bindModalTriggers();
}

function _bindNav(nav) {
  if (!nav || nav.dataset.marketingBound === '1') return;
  nav.dataset.marketingBound = '1';
  // Hamburger toggle
  const hamburger = nav.querySelector('.m-hamburger');
  const linksEl = nav.querySelector('.m-nav-links');
  hamburger?.addEventListener('click', () => {
    const open = linksEl.classList.toggle('open');
    hamburger.setAttribute('aria-expanded', open);
  });
}

function _bindModalTriggers() {
  // Modal triggers
  document.querySelectorAll('[data-modal]').forEach(el => {
    if (el.dataset.marketingModalBound === '1') return;
    el.dataset.marketingModalBound = '1';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const modal = document.getElementById(`m-modal-${el.dataset.modal}`);
      if (modal) modal.removeAttribute('hidden');
    });
  });
}

function _injectInstallModal() {
  if (document.getElementById('m-modal-install')) return;
  const INSTALL_CMD = 'curl -fsSL https://robotdojo.ai/install.sh | bash';

  const modal = document.createElement('div');
  modal.id = 'm-modal-install';
  modal.className = 'm-modal-overlay install-modal';
  modal.setAttribute('hidden', '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Install Robot Dojo');
  modal.innerHTML = `
    <div class="m-modal">
      <button class="m-modal-close" aria-label="Close">&times;</button>
      <h2 class="m-modal-title">Install Robot Dojo</h2>
      <ul class="m-modal-steps">
        <li>Open an account on your Mac with admin privileges</li>
        <li>Open the Terminal app</li>
        <li>Paste this command into the terminal and hit enter</li>
        <li>Install takes 10&ndash;20 minutes</li>
        <li>Your browser opens to setup when the local server is ready</li>
      </ul>
      <div class="m-modal-cmd-wrap">
        <code id="m-install-cmd" class="m-modal-cmd">${INSTALL_CMD}</code>
        <button class="m-modal-copy" data-copy-target="m-install-cmd" aria-label="Copy command">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="16" height="16">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Open the modal when its dialog gets a [data-open] flip — Playwright
  // tests assert visibility via the `open` attribute on .install-modal.
  modal.addEventListener('toggle', () => {});

  // Close on backdrop click or × button
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('.m-modal-close')) modal.setAttribute('hidden', '');
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) modal.setAttribute('hidden', '');
  });
}

// ─── Footer ──────────────────────────────────────────────────────

export function renderFooter() {
  const footer = document.createElement('footer');
  footer.className = 'm-footer';
  footer.setAttribute('role', 'contentinfo');
  const year = new Date().getFullYear();
  footer.innerHTML = `
    <span>&copy; ${year} Robot Dojo, LLC</span>
    <div class="m-footer-links">
      <a href="/licensing">Licensing</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </div>
  `;
  document.body.appendChild(footer);
}

// Copy-to-clipboard for install command (and any [data-copy-target] button)
function initCopyButtons() {
  document.querySelectorAll('[data-copy-target]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      const text = target.innerText.trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback for older browsers / insecure contexts
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch { /* noop */ }
        document.body.removeChild(ta);
      }
      const original = btn.innerHTML;
      btn.innerHTML = 'Copied';
      btn.classList.add('is-copied');
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('is-copied');
      }, 1500);
    });
  });
}

// WHY banner-first: the Private Beta banner is the access-model signal a
// personal-contact visitor must see at the top. renderNav() inserts the nav
// directly beneath it via insertBefore(...nextSibling).
export function initMarketing() {
  renderBetaBanner();
  renderNav();
  renderFooter();
  initCopyButtons();
}
