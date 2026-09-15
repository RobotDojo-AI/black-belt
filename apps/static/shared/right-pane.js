// Right Pane — shared two-pane workspace system
// Opens entity detail (person, company, miyagi) in a resizable right pane.

let rightPaneCurrentType = null;
let rightPaneCurrentId = null;

function isRightPaneOpen() {
  return $('#rightPane')?.dataset.visible === 'true';
}

function initRightPane() {
  // Every page load starts fresh. Right pane opens only on user action.
}

async function openInRightPane(type, id) {
  const rp = $('#rightPane');
  if (!rp || isMobile()) return;

  rightPaneCurrentType = type;
  rightPaneCurrentId = id;
  rp.dataset.visible = 'true';

  if (typeof setLayoutView === 'function') setLayoutView('dual');

  const content = $('#rightPaneContent');
  if (content) {
    content.innerHTML = '<div class="llm-empty">Loading...</div>';
    await renderPaneContent(type, id, content);
  }

  // Update action buttons
  const actions = $('#rightPaneActions');
  if (actions) {
    if (type === 'miyagi') {
      actions.innerHTML = '';
    } else {
      actions.innerHTML = `
        <button class="topbar-icon-btn" onclick="openRightPaneInNewTab('${esc(type)}','${esc(id)}')" title="Open in new tab">
          <span class="material-symbols-outlined">open_in_new</span>
        </button>`;
    }
  }
}

function closeRightPane() {
  const rp = $('#rightPane');
  if (!rp) return;
  rightPaneCurrentType = null;
  rightPaneCurrentId = null;
  rp.dataset.visible = 'false';
  if (typeof setLayoutView === 'function') setLayoutView('split');
}

function toggleRightPane() {
  if (isRightPaneOpen()) { closeRightPane(); return; }
  const ctx = window.robotdojoContext;
  if (!ctx?.type || !ctx?.id) return;
  openInRightPane(ctx.type, ctx.id);
}

function openRightPaneInNewTab(type, id) {
  const url = entityUrl(type, id);
  if (url) window.open(url, '_blank');
}
