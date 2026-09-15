#!/usr/bin/env node
import { readKeychainSecret, writeKeychainSecret } from '../lib/keychain.js';
import { mintAuthToken } from '../lib/auth.js';

const SERVICE = 'ROBOTDOJO_AUTH_TOKEN';

function usage(code = 0) {
  const out = [
    'Usage: npm run token -- <show|rotate|set|help> [token]',
    '',
    'Commands:',
    '  show            Print the current local login token',
    '  rotate          Generate and save a new token; signs out local sessions',
    '  set <token>     Save a chosen token; signs out local sessions',
    '  help            Show this help',
  ].join('\n');
  console.log(out);
  process.exit(code);
}

function readToken() {
  return readKeychainSecret(SERVICE) || '';
}

function writeToken(token) {
  if (!writeKeychainSecret(SERVICE, token)) throw new Error('Keychain write failed');
}

async function clearLocalSessions() {
  try {
    const mod = await import('../lib/db.js');
    mod.default.prepare('DELETE FROM sessions').run();
    return true;
  } catch {
    return false;
  }
}

function validateToken(token) {
  if (!token || token.length < 24) throw new Error('Token must be at least 24 characters.');
}

const cmd = process.argv[2] || 'help';

try {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') usage(0);
  if (cmd === 'show') {
    const token = readToken();
    if (!token) throw new Error('No ROBOTDOJO_AUTH_TOKEN found in Keychain.');
    console.log(token);
    process.exit(0);
  }
  if (cmd === 'rotate' || cmd === 'set') {
    const token = cmd === 'rotate'
      ? mintAuthToken()
      : String(process.argv[3] || '').trim();
    validateToken(token);
    writeToken(token);
    const cleared = await clearLocalSessions();
    console.log(token);
    console.error(cleared
      ? 'Token saved. All local browser sessions were signed out.'
      : 'Token saved. Restart Robot Dojo if existing sessions remain active.');
    process.exit(0);
  }
  usage(1);
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}
