// Shell notifications — INERT after st_4e7e3aaf AC2.
//
// The notifications bell was removed from the global topbar, so there is no
// panel to render and no SSE channel to maintain. The file stays loaded
// because shell-search.js calls closeNotifPanel() on outside-click; removing
// the symbol would throw a ReferenceError and silently break search.
//
// Function signatures are preserved as no-ops so any cached HTML or stale
// inline onclick that still references toggleNotifPanel() does not throw.
// /api/notifications routes remain on the server — only the UI is gone.

function initNotifications() {
  // no-op: notifications panel removed from topbar
}

function toggleNotifPanel() {
  // no-op: the dropdown DOM no longer exists
}

function closeNotifPanel() {
  // no-op: kept for shell-search.js's outside-click handler
}
