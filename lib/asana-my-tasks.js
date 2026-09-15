/**
 * Personal Asana My Tasks: workspace + assignee me + due_on, no project.
 */
import { readKeychainSecret } from './keychain.js';
import { loadAsanaRoutingConfig } from './asana-routing-config.js';

const ASANA_BASE = 'https://app.asana.com/api/1.0';

function getPat() {
  if (process.env.ASANA_PAT) return process.env.ASANA_PAT;
  try {
    return readKeychainSecret('ASANA_PAT');
  } catch {
    return null;
  }
}

export function nyDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const by = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${by.year}-${by.month}-${by.day}`;
}

export async function createPersonalDueTask({
  name,
  notes,
  htmlNotes,
  dueOn,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const pat = getPat();
  if (!pat) {
    console.error('[asana] personal task failed: no PAT available');
    return null;
  }
  const cfg = loadAsanaRoutingConfig();
  const workspace = cfg.destinations?.default?.workspace;
  if (!workspace) {
    console.error('[asana] personal task failed: workspace not configured');
    return null;
  }
  const due_on = dueOn || nyDate(now);
  const data = {
    name: name || 'Weekly Portfolio Review',
    workspace,
    assignee: 'me',
    due_on,
  };
  if (htmlNotes) data.html_notes = htmlNotes;
  else data.notes = notes || '';
  const body = { data };
  try {
    const res = await fetchImpl(`${ASANA_BASE}/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const json = await res.json();
        const msg = json?.errors?.[0]?.message;
        if (msg) detail += ` — ${msg}`;
      } catch { /* ignore */ }
      console.error(`[asana] personal task failed: ${detail}`);
      return null;
    }
    const json = await res.json();
    return json?.data?.gid ?? null;
  } catch (e) {
    console.error(`[asana] personal task failed: ${e.message}`);
    return null;
  }
}
