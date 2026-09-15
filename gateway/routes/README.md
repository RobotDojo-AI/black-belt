# routes/

HTTP + WebSocket entry points. All request handling starts here and
delegates into `lib/` for the real work.

- `tunnel.js` — `/tunnel` WebSocket upgrade; verifies token, registers connection, runs heartbeat
- `proxy.js` — `/me/:slug/*` public HTTP proxy
- `control.js` — `/internal/push-key`, `/internal/revoke-key` (shared-secret auth, backend-only)
