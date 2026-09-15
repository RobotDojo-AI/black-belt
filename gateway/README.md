# Robot Dojo Gateway — Trust Model

This document is for security auditors. It explains what the relay can and cannot see, and how to verify the claims by reading the code.

## Source and Deploy Boundary

`gateway/` is the only Robot Dojo gateway folder and source authority. Gateway application code, deploy source, and the production deploy entry point live here. Filled Terraform vars, Terraform state, plans, generated `.terraform/` data, and installed dependencies are local deploy state and are ignored.

The old ignored `code/gateway/` deploy workspace is retired. Do not recreate it as a source mirror or deploy workspace.

## The claim

**The relay is structurally blind to all user traffic.** TLS terminates on the user's Mac. The relay has no TLS session key and cannot decrypt traffic, even under legal compulsion.

## How to verify

### 1. The relay does no TLS termination

Search the entire gateway tree:

```sh
grep -r "tls\.\|createServer\|https\." gateway/lib/ gateway/routes/
```

You will find nothing that loads a certificate or establishes a TLS session. The only TLS in this codebase is the relay's own HTTPS listener (for the control plane and internal APIs) — it holds no user cert, no user key.

### 2. The SNI passthrough is raw TCP splicing

`routes/tcp-tunnel.js` — WebSocket endpoint where the user's Mac connects. Incoming connections are piped as raw bytes:

```
lib/sni-router.js     — reads ClientHello SNI to route by hostname (no decryption)
lib/tcp-registry.js   — maps slug → active Mac WebSocket connection
routes/tcp-tunnel.js  — accepts the Mac's outbound tunnel, registers it
lib/sni.js            — parses TLS ClientHello to extract ServerName only
```

The SNI parser (`lib/sni.js`) reads exactly one field from the ClientHello: the ServerName extension. It does not decrypt. After routing, raw bytes flow in both directions unchanged.

### 3. The relay's knowledge boundary

What the relay **does** know:
- Which slug a connection is for — read from the cleartext SNI field, which TLS
  sends unencrypted by design (RFC 8446). It never learns an email address: the
  device secret hash is the only credential it stores (st_63b59bda AC-5).
- That a device tunnel is active (presence, not content)
- Rough timing (connection open/close events)

What the relay **does not** know:
- Request bodies, response bodies, cookie values
- Chat messages, user data, health data, any application content
- TLS session keys (never transmitted to the relay)

### 4. Control-plane traffic (tunnel-agent)

A separate WebSocket tunnel (`routes/tunnel.js`) carries control-plane events only:
- `key_issued` / `key_revoked` — Black Belt license events from the billing backend
- Nothing else routes through this path after the 2026-04-21 migration

Prior to that migration, all user HTTP traffic was proxied through this path (relay could read it). The migration removed the proxy; `gateway/routes/proxy.js` now issues 302 redirects to `{slug}.robotdojo.ai` for any cached `/me/` URLs.

### 5. Audit checklist

- [ ] `grep -r "privateKey\|readFileSync.*key\|tls\.connect" gateway/` → no results
- [ ] `grep -r "createServer\|https\." gateway/lib/ gateway/routes/` → no results (only relay's own HTTPS listener in index.js)
- [ ] `cat gateway/lib/sni.js` → SNI parse only, no decrypt
- [ ] `cat gateway/routes/tcp-tunnel.js` → raw pipe, no HTTP decode
- [ ] `cat gateway/routes/proxy.js` → 302 redirect only, no proxy
