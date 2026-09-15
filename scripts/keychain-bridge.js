#!/usr/bin/env node
/**
 * Keychain bridge — Aqua launchd process that decrypts Keychain items for
 * hardened coding-agent hosts. Grok's Developer ID binary uses hardened
 * runtime without Keychain entitlements, so `security -w` returns status 36
 * (errSecInteractionNotAllowed) in that process tree. A gui-domain LaunchAgent
 * is not that tree and can read.
 *
 * Serves only robotdojo-LOCAL_DB_KEY. Provider keys stay dark.
 *
 *   --serve (default)  listen on the unix socket
 *   --get SERVICE      client: print the secret and exit (used by lib/keychain.js)
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { dirname } from 'node:path';
import {
  KEYCHAIN_BRIDGE_SERVICE,
  isKeychainBridgeService,
  keychainAccounts,
  keychainBridgeSocketPath,
  keychainService,
} from '../lib/keychain.js';

const socketPath = keychainBridgeSocketPath();

function readDirect(service) {
  for (const account of keychainAccounts()) {
    const r = spawnSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf8', timeout: 5000 },
    );
    const value = r.status === 0 ? String(r.stdout || '').trim() : '';
    if (value) return value;
  }
  const fallback = spawnSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-w'],
    { encoding: 'utf8', timeout: 5000 },
  );
  return fallback.status === 0 ? String(fallback.stdout || '').trim() : '';
}

function handleRequest(line) {
  const match = String(line || '').trim().match(/^GET\s+(\S+)\s*$/);
  if (!match) return 'ERR bad-request';
  let service;
  try {
    service = keychainService(match[1]);
  } catch {
    return 'ERR bad-service';
  }
  if (!isKeychainBridgeService(service)) return 'ERR denied';
  const value = readDirect(service);
  if (!value) return 'ERR missing';
  if (value.includes('\n')) return 'ERR malformed';
  return `OK ${value}`;
}

function serve() {
  mkdirSync(dirname(socketPath), { recursive: true });
  try { unlinkSync(socketPath); } catch { /* no stale socket */ }

  const server = createServer((conn) => {
    let buf = '';
    const finish = (reply) => {
      try { conn.end(`${reply}\n`); } catch { /* closed */ }
    };
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) {
        if (buf.length > 256) finish('ERR too-long');
        return;
      }
      finish(handleRequest(buf.slice(0, nl)));
    });
    conn.on('error', () => { try { conn.destroy(); } catch { /* closed */ } });
  });

  server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
    process.stderr.write(`[keychain-bridge] listening (${KEYCHAIN_BRIDGE_SERVICE} only)\n`);
  });

  const shutdown = () => {
    server.close(() => {
      try { unlinkSync(socketPath); } catch { /* gone */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function getSecret(serviceArg) {
  let service;
  try {
    service = keychainService(serviceArg);
  } catch {
    process.stderr.write('keychain-bridge: service required\n');
    process.exit(2);
  }
  if (!isKeychainBridgeService(service)) {
    process.stderr.write('keychain-bridge: service is not bridged\n');
    process.exit(2);
  }
  if (!existsSync(socketPath)) {
    process.stderr.write('keychain-bridge: socket missing\n');
    process.exit(1);
  }

  const sock = connect(socketPath);
  let buf = '';
  const timer = setTimeout(() => {
    sock.destroy();
    process.exit(1);
  }, 2000);

  sock.setEncoding('utf8');
  sock.on('connect', () => sock.write(`GET ${service}\n`));
  sock.on('data', (chunk) => {
    buf += chunk;
    if (buf.includes('\n')) sock.end();
  });
  sock.on('end', () => {
    clearTimeout(timer);
    const line = buf.trim();
    if (line.startsWith('OK ')) {
      process.stdout.write(`${line.slice(3)}\n`);
      process.exit(0);
    }
    process.exit(1);
  });
  sock.on('error', () => {
    clearTimeout(timer);
    process.exit(1);
  });
}

const argv = process.argv.slice(2);
if (argv[0] === '--get') getSecret(argv[1]);
else serve();
