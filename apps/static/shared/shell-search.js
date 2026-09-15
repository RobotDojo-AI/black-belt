// Shell Persistent Search — extracted from shell.js
// Dependencies: $(), esc() from api.js; closeNotifPanel() from shell-notifications.js

let persistentSearchTimeout = null;

function openSearch() {
  // Focus the persistent search bar (always visible in global topbar)
  const psi = $('#persistentSearchInput');
  if (psi) { psi.focus(); return; }
}
function closeSearch() {
  closePersistentSearchResults();
}

function closePersistentSearchResults() {
  const dropdown = $('.persistent-search-results');
  if (dropdown) dropdown.remove();
}

function clearPersistentSearch() {
  const input = $('#persistentSearchInput');
  if (input) { input.value = ''; input.focus(); }
  $('#persistentSearchClear').classList.remove('visible');
  closePersistentSearchResults();
}

// --- Search type filter ---
const SEARCH_TYPES = [
  { id: 'chat', name: 'Chats', icon: 'chat' },
  { id: 'email', name: 'Emails', icon: 'mail' },
  { id: 'person', name: 'People', icon: 'person' },
];
const DEFAULT_SEARCH_TYPES = ['chat', 'email', 'person'];

function getSearchTypes() {
  const stored = localStorage.getItem('search_type_filters');
  if (stored) try { return JSON.parse(stored); } catch (err) { console.warn('[shell] Corrupt search_type_filters in localStorage, resetting'); }
  return DEFAULT_SEARCH_TYPES;
}
function setSearchTypes(types) {
  localStorage.setItem('search_type_filters', JSON.stringify(types));
  updateFilterBadge();
}
function updateFilterBadge() {
  const badge = $('#searchFilterBadge');
  if (!badge) return;
  const types = getSearchTypes();
  const isAll = types.length === SEARCH_TYPES.length;
  const isDefault = JSON.stringify(types.sort()) === JSON.stringify(DEFAULT_SEARCH_TYPES.sort());
  if (isAll || isDefault) { badge.dataset.visible = 'false'; return; }
  badge.textContent = types.length;
  badge.dataset.visible = 'true';
}
function toggleSearchFilter() {
  let dropdown = $('#searchFilterDropdown');
  if (dropdown) { dropdown.remove(); return; }
  dropdown = document.createElement('div');
  dropdown.id = 'searchFilterDropdown';
  dropdown.className = 'search-filter-dropdown';
  const types = getSearchTypes();
  const isAll = types.length === SEARCH_TYPES.length;
  dropdown.innerHTML = `
    <label class="search-filter-item">
      <input type="checkbox" ${isAll ? 'checked' : ''} onchange="toggleAllSearchTypes(this.checked)"> All
    </label>
    ${SEARCH_TYPES.map(t => `
      <label class="search-filter-item">
        <input type="checkbox" data-type="${t.id}" ${types.includes(t.id) ? 'checked' : ''} onchange="toggleSearchType('${t.id}', this.checked)">
        <span class="material-symbols-outlined icon-sm">${t.icon}</span> ${t.name}
      </label>
    `).join('')}
  `;
  // Append to persistent-search (not wrapper) so position:absolute is relative to search bar
  $('#persistentSearch')?.appendChild(dropdown);
}
function toggleSearchType(type, checked) {
  let types = getSearchTypes();
  if (checked && !types.includes(type)) types.push(type);
  else types = types.filter(t => t !== type);
  if (!types.length) types = DEFAULT_SEARCH_TYPES;
  setSearchTypes(types);
  // Update "All" checkbox
  const allCb = document.querySelector('#searchFilterDropdown input:first-of-type');
  if (allCb) allCb.checked = types.length === SEARCH_TYPES.length;
  // Re-search if input has value
  const input = $('#persistentSearchInput');
  if (input?.value.trim()) doPersistentSearch(input.value);
}
function toggleAllSearchTypes(checked) {
  const types = checked ? SEARCH_TYPES.map(t => t.id) : DEFAULT_SEARCH_TYPES;
  setSearchTypes(types);
  document.querySelectorAll('#searchFilterDropdown input[data-type]').forEach(cb => {
    cb.checked = types.includes(cb.dataset.type);
  });
  const input = $('#persistentSearchInput');
  if (input?.value.trim()) doPersistentSearch(input.value);
}

// --- Search results renderer ---
const SEARCH_ICONS = { chat: 'chat', email: 'mail', person: 'person' };

function renderSearchDropdown(data, target) {
  const { results, counts, hasMore } = data;
  if (!results.length) {
    target.innerHTML = '<div class="search-empty">No results</div>';
    return;
  }
  // Type count pills
  const pills = Object.entries(counts)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => {
      const t = SEARCH_TYPES.find(s => s.id === type);
      return `<span class="search-type-pill"><span class="material-symbols-outlined icon-sm">${t?.icon || 'article'}</span>${t?.name || type} <b>${count}</b></span>`;
    }).join('');

  // Result items
  const items = results.map((r, i) => {
    const icon = SEARCH_ICONS[r.type] || 'article';
    const date = r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const snippet = r.snippet ? `<div class="sr-snippet">${esc(r.snippet.slice(0, 80))}</div>` : '';
    return `<div class="search-result ${i === 0 ? 'search-result-active' : ''}" data-idx="${i}" data-url="${esc(r.url)}" onclick="navigateSearchResult(this)">
      <span class="material-symbols-outlined icon-sm sr-icon">${icon}</span>
      <div class="sr-main"><span class="sr-title">${esc(r.title)}</span>${snippet}</div>
      <span class="sr-date">${date}</span>
    </div>`;
  }).join('');

  // "Show all" footer
  const q = $('#persistentSearchInput')?.value || '';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const showAll = hasMore ? `<a class="search-show-all" href="/search?q=${encodeURIComponent(q)}" onclick="closePersistentSearchResults()">
    Show all results (${total}+) <span class="material-symbols-outlined icon-sm">arrow_forward</span>
  </a>` : '';

  target.innerHTML = `<div class="search-type-pills">${pills}</div>${items}${showAll}`;
  searchResultIdx = 0;
}

let searchResultIdx = -1;
function navigateSearchResult(el) {
  window.location.href = el.dataset.url;
  closePersistentSearchResults();
}

// --- Persistent search (unified API) ---
let searchAbortController = null;

async function doPersistentSearch(q) {
  const clearBtn = $('#persistentSearchClear');
  if (!q.trim()) {
    closePersistentSearchResults();
    if (clearBtn) clearBtn.classList.remove('visible');
    return;
  }
  if (clearBtn) clearBtn.classList.add('visible');

  // Cancel in-flight request
  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();

  try {
    const types = getSearchTypes().join(',');
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&types=${types}&limit=5`, {
      signal: searchAbortController.signal,
    });
    const data = await res.json();

    let dropdown = $('.persistent-search-results');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'persistent-search-results';
      const searchEl = $('#persistentSearch');
      (searchEl ? searchEl.parentElement : $('#globalTopbar')).appendChild(dropdown);
    }
    renderSearchDropdown(data, dropdown);
  } catch (err) {
    if (err.name === 'AbortError') return; // cancelled, ignore
  }
}

// st_01b16272 — per-app search behavior. Default is the unified box (chat +
// company + RAG, called "global" here). `config.searchMode === 'conversations'`
// (chat) hands each keystroke to window.doSearch — chat's own conversation-
// thread search — instead of the unified endpoint. `config.localSearchOnly`
// (health) skips binding entirely: the app owns #persistentSearchInput
// itself for a local chart-only filter, and double-binding was the exact
// "two listeners fire on every keystroke" bug this story fixes.
function initPersistentSearch(config = {}) {
  const input = $('#persistentSearchInput');
  if (!input) return;
  if (config.localSearchOnly) return;
  const useConversationSearch = config.searchMode === 'conversations';
  input.addEventListener('input', () => {
    clearTimeout(persistentSearchTimeout);
    persistentSearchTimeout = setTimeout(() => {
      if (useConversationSearch && typeof window.doSearch === 'function') window.doSearch(input.value);
      else doPersistentSearch(input.value);
    }, 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearPersistentSearch(); input.blur(); return; }
    // Arrow key navigation in results
    const results = [...document.querySelectorAll('.persistent-search-results .search-result')];
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchResultIdx = Math.min(searchResultIdx + 1, results.length - 1);
      updateSearchFocus(results);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchResultIdx = Math.max(searchResultIdx - 1, 0);
      updateSearchFocus(results);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        // Cmd+Enter → open search page
        const q = input.value.trim();
        if (q) { window.location.href = '/search?q=' + encodeURIComponent(q); closePersistentSearchResults(); }
      } else {
        // WHY .click() instead of calling navigateSearchResult directly: the
        // active result's own click behavior differs by search mode (global
        // results navigate via data-url; chat's conversation results use a
        // data-action delegated to the app's SPA router). A real click event
        // routes to whichever handler is actually wired, so Enter and mouse
        // click always agree.
        const active = document.querySelector('.persistent-search-results .search-result-active')
          || results[searchResultIdx] || results[0];
        if (active) active.click();
      }
    }
  });
  // Close dropdowns on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.persistent-search, .persistent-search-results, .search-filter-dropdown')) {
      closePersistentSearchResults();
      const fd = $('#searchFilterDropdown');
      if (fd) fd.remove();
    }
    if (!e.target.closest('.notif-menu')) closeNotifPanel();
  });
  updateFilterBadge();
}

function updateSearchFocus(results) {
  results.forEach(r => r.classList.remove('search-result-active'));
  if (searchResultIdx >= 0 && results[searchResultIdx]) {
    results[searchResultIdx].classList.add('search-result-active');
  }
}
