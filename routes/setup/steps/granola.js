import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeGet } from '../helpers.js';

const STORED_ACCOUNTS_FILE = join(homedir(), 'Library', 'Application Support', 'Granola', 'stored-accounts.json');

function compute() {
  const installed = existsSync(STORED_ACCOUNTS_FILE);
  const row = safeGet("SELECT COUNT(*) AS c FROM transcripts WHERE source = 'granola' AND transcript_text IS NOT NULL AND length(transcript_text) > 0");
  const count = row?.c || 0;
  return {
    complete: count > 0,
    preview: count
      ? `${count.toLocaleString()} meeting transcripts synced`
      : installed
        ? 'Granola detected — click Connect to sync your transcripts'
        : 'Install the free Granola app and sign in, then click Connect',
  };
}

export default {
  id: 'granola',
  title: 'Granola',
  description: 'Meeting transcripts — free Mac app, no API key',
  icon: 'mic',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Walk me through connecting Granola to sync my meeting transcripts.',
  inline: false,
  category: 'data',
  connect_url: '/auth/granola',
};
