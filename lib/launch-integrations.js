/**
 * Account integration card contracts.
 *
 * Important boundary: this module is NOT the source of truth for which
 * accounts are on the user's launch sheet. The Account page payload
 * (`GET /api/accounts/integration-cards`) is the source because it is built
 * from live DB rows, Keychain-backed credentials, local app state, and import
 * history. These static contracts only provide default metadata for known
 * cards: display names, recovery copy, product labels, and allowed status
 * vocabulary.
 *
 * The exported LAUNCH_* names remain as compatibility aliases because older
 * route/tests import them. New QA and product code should read the Account
 * page payload when it needs the actual account set.
 *
 * st_fd14cdd4 AC2: card contracts for data-source integrations (google,
 * microsoft, apple-local, asana, notion, granola, oura, openai) derive from
 * lib/integration-registry.js — declared once on the descriptor, read here.
 * Platform cards (model providers, local health files, repo/backup/relay)
 * are not data-source integrations and stay declared in this module.
 */
import { registryCard } from './integration-registry.js';

export const ACCOUNT_INTEGRATION_STATES = Object.freeze([
  'connected',
  'needs_key',
  'needs_oauth',
  'needs_permission',
  'importing',
  'ready',
  'queued',
  'running',
  'paused',
  'partial',
  'failed',
  'done',
  'error_recoverable',
]);

export const LAUNCH_STATES = ACCOUNT_INTEGRATION_STATES;

const stateSet = new Set(ACCOUNT_INTEGRATION_STATES);

// Platform (non-data-source) card contracts owned by this module. Data-source
// cards come from the registry below — one declaration, all surfaces derive.
const PLATFORM_CONTRACTS = {
  anthropic: {
    id: 'anthropic',
    provider: 'anthropic',
    name: 'Anthropic / Claude',
    section: 'foundation_models',
    substrate_type: 'api_key',
    required: true,
    recovery: 'Paste an Anthropic API key or choose another model provider.',
  },
  'google-ai': {
    id: 'google-ai',
    provider: 'google',
    name: 'Google / Gemini',
    section: 'foundation_models',
    substrate_type: 'api_key',
    required: true,
    recovery: 'Paste a Gemini API key from AI Studio for chat model access. RAG embeddings are local-only.',
  },
  xai: {
    id: 'xai',
    provider: 'xai',
    name: 'xAI',
    section: 'foundation_models',
    substrate_type: 'api_key',
    required: false,
    recovery: 'Deferred for first-run chat. Import a Grok/X export through the imports folder for now.',
  },
  ollama: {
    id: 'ollama',
    provider: 'ollama',
    name: 'Ollama',
    section: 'foundation_models',
    substrate_type: 'local',
    required: true,
    recovery: 'Start Ollama locally. Robot Dojo uses it for setup help before a cloud key exists.',
  },
};

// WHY a resolver instead of inline spreads: a registry card that went missing
// (descriptor edited, id typo) must fail the boot loudly, not render a half
// card. The contract check also asserts every id below resolves.
function requireCard(source, id) {
  const card = source === 'registry' ? registryCard(id) : PLATFORM_CONTRACTS[id];
  if (!card) throw new Error(`launch-integrations: ${source} card '${id}' is missing`);
  return card;
}

export const ACCOUNT_INTEGRATION_CONTRACTS = Object.freeze([
  // Foundation models
  requireCard('platform', 'anthropic'),
  requireCard('registry', 'openai'),
  requireCard('platform', 'google-ai'),
  requireCard('platform', 'xai'),
  requireCard('platform', 'ollama'),

  // Workspace and local data
  requireCard('registry', 'google-workspace'),
  requireCard('registry', 'microsoft'),
  requireCard('registry', 'apple-local'),

  // Productivity context
  requireCard('registry', 'asana'),
  requireCard('registry', 'notion'),
  requireCard('registry', 'granola'),

  // Finances
  requireCard('registry', 'monarch'),

  // Health and personal context
  requireCard('registry', 'oura'),
  {
    id: 'apple-health',
    provider: 'apple-health',
    name: 'Apple Health files',
    section: 'health',
    substrate_type: 'local',
    required: true,
    recovery: 'Export Apple Health or drop health documents into ~/robotdojo/user/inbox; import status and recovery history live in ~/robotdojo/user/imports.',
  },
  {
    id: 'health-labs',
    provider: 'health-labs',
    name: 'Labs',
    section: 'health',
    substrate_type: 'local',
    required: false,
    recovery: 'Drop lab PDFs into ~/robotdojo/user/inbox or keep them in user/databases/health/archive/labs; Robot Dojo extracts lab data points when possible and skips unreadable files.',
  },

  // Product-state truth
  {
    id: 'github',
    provider: 'github',
    name: 'GitHub code',
    section: 'product_state',
    substrate_type: 'local',
    required: false,
    recovery: 'Keep the app in a Git repository so the user can inspect, branch, and restore it.',
  },
  {
    id: 'backup',
    provider: 'backup',
    name: 'Backup',
    section: 'product_state',
    substrate_type: 'local',
    required: false,
    recovery: 'Choose GCP automated backup, guided manual backup, or explicitly skip backup.',
  },
  {
    id: 'remote-access',
    provider: 'remote-access',
    name: 'Remote access relay',
    section: 'product_state',
    substrate_type: 'local',
    required: false,
    recovery: 'Describe this as remote access to the local server, not as data storage on Robot Dojo servers.',
  },
]);

export const LAUNCH_INTEGRATIONS = ACCOUNT_INTEGRATION_CONTRACTS;

// df_ac0dd301 Fix A — the launch short-list for the integrations *page catalog*
// (the keychain_integrations table). A provider is allowed a page card iff it is
// in this Set. Derived from the launch contract so the page set is single-sourced
// — a future launch-list edit flows through automatically — plus the two carve-
// outs the contract does not name: 'asana_secondary' (renders as a sub-account under
// the Asana card, kept for catalog consistency) and 'mistral' (an open-weight
// launch model with a catalog row but no contract entry; its DISPLAY is runnable-
// gated in routes/accounts.js, its ROW survives the prune). Contract providers
// with no catalog row (microsoft, granola, github, …) are harmless members: they
// match no catalog row, so the prune ignores them. This is the ONLY launch-set
// literal — the reconciler gates and the prune both key off it.
export const PAGE_CATALOG_ALLOWLIST = new Set([
  ...ACCOUNT_INTEGRATION_CONTRACTS.map((c) => c.provider),
  'asana_secondary',
  'mistral',
]);

// Providers built but HIDDEN from the friends-and-family launch surface.
//
// st_fcdbe84f AC11 originally hid Microsoft (tenant-admin Graph app credentials
// strand enterprise users on an admin-consent wall; Google covered email/calendar
// for the beta). st_fd14cdd4 UNHID Microsoft per owner directive: the Microsoft
// card now appears on the accounts page (the live integration-cards path never
// filtered it; emptying this set makes the fallback path consistent). The set +
// isLaunchHiddenProvider mechanism is kept intact (empty) so any future provider
// can be hidden by adding it here — the filter wiring in routes/accounts.js stays.
export const LAUNCH_HIDDEN_PROVIDERS = new Set();

export function isLaunchHiddenProvider(provider) {
  return LAUNCH_HIDDEN_PROVIDERS.has(provider);
}

export function requiredAccountIntegrationContracts() {
  return ACCOUNT_INTEGRATION_CONTRACTS.filter(
    (item) => item.required && !LAUNCH_HIDDEN_PROVIDERS.has(item.provider),
  );
}

export function requiredLaunchIntegrations() {
  return requiredAccountIntegrationContracts();
}

export function findAccountIntegrationContract(provider, section = null) {
  return ACCOUNT_INTEGRATION_CONTRACTS.find((item) => (
    item.provider === provider && (!section || item.section === section)
  )) || null;
}

export function findLaunchIntegration(provider, section = null) {
  return findAccountIntegrationContract(provider, section);
}

export function inferLaunchState(card) {
  if (card.launch_state && stateSet.has(card.launch_state)) return card.launch_state;
  if (card.integration_error || card.last_error) {
    const error = String(card.integration_error || card.last_error);
    if (/permission|Full Disk Access|TCC|Privacy/i.test(error)) return 'needs_permission';
    if (/oauth|reauth|invalid_grant|scope|consent|unauthorized/i.test(error)) return 'needs_oauth';
    return 'error_recoverable';
  }
  if (card.status && stateSet.has(card.status)) return card.status;
  if (card.connected) return 'connected';
  const substrate = card.substrate_type || card.auth;
  if (substrate === 'api_key') return 'needs_key';
  if (substrate === 'oauth') return 'needs_oauth';
  if (substrate === 'app_credentials') return 'needs_key';
  if (substrate === 'local') return 'needs_permission';
  return 'ready';
}

export function applyAccountIntegrationContract(card, contract = null) {
  const item = contract || findAccountIntegrationContract(card.provider, card.section);
  if (!item) {
    const launchState = inferLaunchState(card);
    return { ...card, launch_state: launchState, status: card.status || launchState };
  }
  const launchState = inferLaunchState({
    ...card,
    substrate_type: card.substrate_type || item.substrate_type,
  });
  return {
    ...card,
    name: card.name || item.name,
    launch_id: item.id,
    launch_required: !!item.required,
    launch_state: launchState,
    status: launchState,
    substrate_type: card.substrate_type || item.substrate_type,
    recovery: card.recovery || item.recovery,
    products_supported: card.products_supported || item.products || null,
  };
}

export function applyLaunchContract(card, contract = null) {
  return applyAccountIntegrationContract(card, contract);
}

export function normalizeArtifactCounts(card) {
  const counts = {};
  const add = (key, value) => {
    const n = Number(value) || 0;
    if (n > 0) counts[key] = (counts[key] || 0) + n;
  };

  for (const [key, value] of Object.entries(card.artifact_counts_by_type || {})) {
    add(key, value);
  }

  for (const account of card.accounts || []) {
    const products = account.products || {};
    add('email', products.gmail || products.email || products.mail);
    add('calendar', products.calendar);
    add('contacts', products.contacts);
    add('documents', products.drive || products.docs || products.documents);
    add('sheets', products.sheets);
    add('slides', products.slides);
    add('photos', products.photos || products.photos_metadata);
    add('search_console', products.search_console);
  }

  const docs = card.doc_counts || {};
  add('messages', docs.imessage || docs.messages);
  add('contacts', docs.contacts);
  add('calendar', docs.calendar);
  add('photos', docs.photos || docs.photos_metadata);
  add('documents', docs.files || docs.documents);

  if (card.doc_count) {
    const key = card.provider === 'granola' ? 'transcripts'
      : card.provider === 'asana' ? 'tasks'
        : card.provider === 'apple-health' || card.provider === 'health-labs' || card.provider === 'oura' ? 'health'
          : 'documents';
    add(key, card.doc_count);
  }

  return counts;
}

export function credentialStateFor(card) {
  const status = card.launch_state || card.status || inferLaunchState(card);
  const substrate = card.substrate_type || card.auth;
  if (substrate === 'api_key') return card.credential || card.connected ? 'stored' : 'missing';
  if (substrate === 'oauth') return card.connected ? 'signed_in' : 'not_connected';
  if (substrate === 'app_credentials') return card.connected || card.credential ? 'configured' : 'missing';
  if (substrate === 'local') {
    if (status === 'needs_permission') return 'needs_permission';
    return card.connected ? 'available' : 'ready';
  }
  return card.connected ? 'available' : 'not_configured';
}

export function primaryActionFor(card) {
  const status = card.launch_state || card.status || inferLaunchState(card);
  const provider = card.provider || '';
  const substrate = card.substrate_type || card.auth;
  if (substrate === 'oauth' && ['needs_oauth', 'failed', 'error_recoverable'].includes(status)) {
    return {
      kind: 'oauth',
      label: 'Connect',
      href: provider === 'google' ? '/api/auth/google/start?account=personal'
        : `/oauth/connect?vendor=${encodeURIComponent(provider)}`,
    };
  }
  if (substrate === 'app_credentials' && provider === 'microsoft') {
    return card.connected
      ? { kind: 'add_account', label: 'Add Account' }
      : { kind: 'add_account', label: 'Add Account' };
  }
  if (substrate === 'api_key') {
    return card.connected
      ? { kind: 'disconnect_key', label: 'Remove key' }
      : { kind: 'add_key', label: 'Add key' };
  }
  if (status === 'needs_permission') return { kind: 'permission', label: 'Open recovery' };
  if (status === 'importing' || status === 'queued' || status === 'running') return { kind: 'wait', label: 'In progress' };
  return { kind: 'none', label: card.connected ? 'Connected' : 'Ready' };
}

export function normalizeAccountIntegrationCard(card) {
  const launchState = card.launch_state || card.status || inferLaunchState(card);
  const artifactCounts = normalizeArtifactCounts(card);
  const artifactTotal = Object.values(artifactCounts).reduce((sum, n) => sum + n, 0);
  const primaryAccount = Array.isArray(card.accounts) && card.accounts.length === 1 ? card.accounts[0] : null;
  return {
    provider_identity: {
      provider: card.provider || null,
      name: card.name || card.provider || 'Integration',
      account: primaryAccount?.email || card.email || null,
    },
    connection_status: launchState,
    artifact_counts_by_type: artifactCounts,
    artifact_total: artifactTotal,
    last_seen_at: card.last_sync_at || card.last_sync || card.last_success || null,
    credential_state: credentialStateFor({ ...card, launch_state: launchState }),
    primary_action: primaryActionFor({ ...card, launch_state: launchState }),
    recovery_guidance: card.recovery || card.recovery_guidance || '',
  };
}

export function normalizeLaunchCard(card) {
  return normalizeAccountIntegrationCard(card);
}

export function missingRequiredAccountContracts(cards) {
  const present = new Set(cards.map((card) => card.launch_id || card.provider));
  return requiredAccountIntegrationContracts()
    .filter((item) => !present.has(item.id) && !present.has(item.provider))
    .map((item) => item.id);
}

export function missingRequiredProviders(cards) {
  return missingRequiredAccountContracts(cards);
}
