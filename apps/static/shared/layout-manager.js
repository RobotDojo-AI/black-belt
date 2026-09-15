// Layout Manager — shared by all apps.
// All apps use data-view attribute (CSS-driven). JS sets the attribute, CSS handles visibility.

let layoutState = { view: 'split' };
let layoutConfig = null;
let layoutInnerSplit = null;

function normalizeLayoutViewForViewport(view) {
  const chatShell = document.body?.dataset?.app === 'chat' && location.pathname.startsWith('/chat');
  if (chatShell && (view === 'split' || view === 'dual' || view === 'list')) return 'focus';
  return view;
}

function initLayout(config) {
  if (!config || !config.list || !config.detail) return;
  layoutConfig = config;
  layoutState.view = 'split'; // No session restoration. App controls initial state.
  if (!config.deferApply) applyLayout();
}

function setLayoutView(view) {
  if (!['list', 'split', 'dual', 'focus'].includes(view)) return;
  view = normalizeLayoutViewForViewport(view);

  destroyInnerSplit();
  const prevView = layoutState.view;
  layoutState.view = view;
  layoutState.prevView = prevView;
  localStorage.setItem('layout-view', view);
  applyLayout();
  if (view === 'split' || view === 'dual') createInnerSplit();
}

function getLayoutState() {
  const mainArea = document.querySelector('#mainArea');
  const view = mainArea?.dataset.view || layoutState.view;
  return { view, rightPane: false, focus: view === 'focus' };
}

function isViewSplit() {
  const mainArea = document.querySelector('#mainArea');
  const view = mainArea ? mainArea.dataset.view : layoutState.view;
  return view === 'split' || view === 'dual';
}

function isLayoutManaged() { return layoutConfig !== null; }

// ===== Apply DOM — sets data-view, CSS handles visibility =====

function applyLayout() {
  if (!layoutConfig) return;
  const body = document.querySelector('.app-body');
  if (!body) return;

  const view = layoutState.view;
  const mainArea = document.querySelector('#mainArea');

  body.dataset.view = view;
  if (mainArea) mainArea.dataset.view = view;

  // Dynamic sizing for focus mode — CSS handles visibility, this handles flex weight
  const detail = document.querySelector(layoutConfig.detail);
  if (detail) detail.style.flex = (view === 'focus') ? '1' : '';

  if (typeof updateViewToggle === 'function') updateViewToggle();
  document.dispatchEvent(new CustomEvent('layout-view-changed', { detail: { view } }));
}

// ===== Inner Split (list | detail) =====

function createInnerSplit() {
  if (layoutInnerSplit || typeof Split === 'undefined' || !layoutConfig) return;
  const list = document.querySelector(layoutConfig.list);
  const detail = document.querySelector(layoutConfig.detail);
  if (!list || !detail) return;

  // Always start at 25/75 — don't persist drag position across page loads
  layoutInnerSplit = Split([layoutConfig.list, layoutConfig.detail], {
    sizes: [25, 75], minSize: [180, 300], gutterSize: 8,
    cursor: 'col-resize', direction: 'horizontal',
  });
}

function destroyInnerSplit() {
  if (layoutInnerSplit) { layoutInnerSplit.destroy(); layoutInnerSplit = null; }
  if (layoutConfig) {
    [layoutConfig.list, layoutConfig.detail].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) { el.style.width = ''; el.style.height = ''; el.style.flex = ''; el.style.flexBasis = ''; }
    });
  }
  document.querySelector('#mainArea')?.querySelectorAll(':scope > .gutter').forEach(g => g.remove());
}
