# lib/

Core gateway logic. One responsibility per file, under 150 LOC each.

- `auth.js` — HS256 JWT verification for tunnel-agent handshake; constant-time compare for internal REST
- `ws-registry.js` — in-memory map `email ↔ slug ↔ Connection`; supersedes old entry on reconnect
- `connection.js` — wraps one WebSocket with request/response multiplexing (UUID-keyed), heartbeat state, and control-event send
- `proxy.js` — Hono handler that turns an inbound HTTP request into a tunneled request and reconstructs the response
- `control.js` — thin wrapper around the registry for pushing key_issued / key_revoked events
