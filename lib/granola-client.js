/**
 * Granola API client — meeting fetch via the public API, with the legacy
 * desktop-session path kept as a fallback.
 *
 * PRIMARY (current): Granola's documented public API at
 * GRANOLA_PUBLIC_API_URL, authenticated with a workspace API key (grn_…) from
 * Keychain `robotdojo-GRANOLA_API_KEY`. Needs no local Granola session, so it
 * survives app upgrades and works headless. GET /notes (cursor paginated,
 * created_after filter), GET /notes/{id}?include=transcript, with
 * GET /notes/{id}/transcript as the oversized-transcript fallback.
 *
 * WHY it is primary: Granola 7.465 stopped writing storage.dek, so the DEK
 * that decrypts the *.json.enc session files can no longer be unwrapped and
 * the desktop token path returns nothing. The old refresh endpoint also moved.
 * Known limits of the public API: it returns only notes that already have a
 * generated summary and transcript, it exposes no folder/list concept (so
 * folder-driven topic routing is unavailable — see fetchGranolaListMembership),
 * and deep cursor pagination has been observed to 500, which is why the sync
 * bounds listings with created_after and tolerates a mid-walk page failure.
 *
 * FALLBACK (legacy desktop session, retained for installs that can still
 * decrypt it):
 *
 * Token source (preference order, st_fd14cdd4 follow-up):
 *   1. *.json.enc — Granola ≥7.269 encrypts its session files. Scheme
 *      (verified against the live files on this machine):
 *        a. Keychain item "Granola Safe Storage" holds the Electron
 *           safeStorage secret (Chromium macOS os_crypt).
 *        b. storage.dek = 'v10' ‖ AES-128-CBC(ciphertext). Key =
 *           PBKDF2-SHA1(secret, 'saltysalt', 1003 iter, 16 bytes),
 *           IV = 16 spaces — the standard Chromium derivation. Plaintext
 *           is a base64 string decoding to a 32-byte data-encryption key.
 *        c. Each .enc file = IV(12) ‖ AES-256-GCM ciphertext ‖ tag(16),
 *           keyed by that DEK. Plaintext is the same JSON the legacy
 *           plaintext files carried.
 *   2. Legacy plaintext stored-accounts.json / supabase.json — frozen at
 *      the app-version upgrade (May 2026) but kept as fallback for older
 *      installs and for when keychain access is unavailable.
 *   3. robotdojo-token-cache.json — our own refresh cache.
 * WHY graceful degradation: any decrypt failure logs once and falls back to
 * the legacy path — same behavior as before this change, never a crash.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { secret } from './config.js';
import { readKeychainSecret } from './keychain.js';
// st_1169bfc7 — both db-free by contract, so importing them here keeps
// granola-client.js off the direct-db-writers radar (no lib/db.js import).
import { normalizeTopicSlug, primaryWorkTopicSlugs } from './asana-routing-config.js';
import { PERSONAL_TOPIC } from './topic-routing-policy.js';

// st_1169bfc7 decision-table constant (the AC6 rule, not a folder allowlist).
// The AC5 "primary-work topic wins" precedence is config-driven — the set of
// primary-work slugs comes from primaryWorkTopicSlugs() (the non-default Asana
// destinations in the gitignored routing override), never a hardcoded slug.
const AMBIGUOUS_FALLBACK_SLUG = PERSONAL_TOPIC;  // AC6 — 2+ non-work folders → personal

const GRANOLA_DIR = process.env.ROBOTDOJO_GRANOLA_DIR || join(homedir(), 'Library', 'Application Support', 'Granola');
export const STORED_ACCOUNTS_FILE = join(GRANOLA_DIR, 'stored-accounts.json');
export const SUPABASE_FILE = join(GRANOLA_DIR, 'supabase.json');
export const STORED_ACCOUNTS_ENC_FILE = join(GRANOLA_DIR, 'stored-accounts.json.enc');
export const SUPABASE_ENC_FILE = join(GRANOLA_DIR, 'supabase.json.enc');
export const STORAGE_DEK_FILE = join(GRANOLA_DIR, 'storage.dek');
export const TOKEN_CACHE_FILE = join(GRANOLA_DIR, 'robotdojo-token-cache.json');
export const GRANOLA_KEYCHAIN_SERVICE = 'Granola Safe Storage';
export const GRANOLA_CLIENT_ID = 'client_01KKYBWQKWZWPVJ1WW2AHXPSAR';
export const GRANOLA_TOKEN_URL = 'https://mcp-auth.granola.ai/oauth2/token';
export const GRANOLA_REST_URL = 'https://api.granola.ai';
export const GRANOLA_PUBLIC_API_URL = 'https://public-api.granola.ai/v1';
// Client identity the REST API requires. Overridable so a version bump does not
// need a code change; falls back to the last version verified against the API.
export const GRANOLA_CLIENT_VERSION = process.env.GRANOLA_CLIENT_VERSION || '7.465.0';

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Per-tests/dir path resolution. opts.dir overrides only in unit tests; the
// live module always resolves to GRANOLA_DIR.
function granolaPaths(dir = GRANOLA_DIR) {
  return {
    storedAccounts: join(dir, 'stored-accounts.json'),
    storedAccountsEnc: join(dir, 'stored-accounts.json.enc'),
    supabase: join(dir, 'supabase.json'),
    supabaseEnc: join(dir, 'supabase.json.enc'),
    dek: join(dir, 'storage.dek'),
  };
}

/**
 * Unwrap Granola's storage.dek into the 32-byte AES-256 data-encryption key.
 * Pure (bytes + secret in, key out) — exported for unit tests.
 *
 * Format: 'v10' prefix, then AES-128-CBC ciphertext. KEK = PBKDF2-SHA1 over
 * the keychain secret with Chromium's fixed parameters (salt 'saltysalt',
 * 1003 iterations, 16-byte key); IV is 16 ASCII spaces. The CBC plaintext is
 * a base64 string, not raw bytes — decode it to get the DEK.
 */
export function unwrapStorageDek(dekFileBytes, keychainSecret) {
  if (!dekFileBytes || dekFileBytes.length < 20) throw new Error('storage.dek too short');
  const prefix = dekFileBytes.subarray(0, 3).toString('utf8');
  if (prefix !== 'v10') throw new Error(`unexpected storage.dek prefix "${prefix}"`);
  if (!keychainSecret) throw new Error('no keychain secret');
  const kek = pbkdf2Sync(Buffer.from(String(keychainSecret), 'utf8'), Buffer.from('saltysalt'), 1003, 16, 'sha1');
  const decipher = createDecipheriv('aes-128-cbc', kek, Buffer.alloc(16, 0x20));
  const dekB64 = Buffer.concat([decipher.update(dekFileBytes.subarray(3)), decipher.final()]).toString('utf8');
  const dek = Buffer.from(dekB64, 'base64');
  if (dek.length !== 32) throw new Error(`unwrapped DEK is ${dek.length} bytes, expected 32`);
  return dek;
}

/**
 * Decrypt one Granola .enc blob with the unwrapped DEK and parse the JSON.
 * Pure — exported for unit tests. Layout: IV(12) ‖ ciphertext ‖ GCM tag(16).
 * GCM authentication means tampering or a wrong key always throws — callers
 * treat any throw as "fall back to plaintext".
 */
export function decryptGranolaJson(blob, dek) {
  if (!blob || blob.length < 29) throw new Error('.enc blob too short'); // 12 IV + ≥1 ct + 16 tag
  const decipher = createDecipheriv('aes-256-gcm', dek, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  const plain = Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// WHY warn-once: integration-health probes call these readers every few
// minutes; a persistent decrypt failure must be visible in the log exactly
// once, not as a scroll of repeats.
const decryptWarned = new Set();
function warnOnce(key, message) {
  if (decryptWarned.has(key)) return;
  decryptWarned.add(key);
  console.warn(message);
}

// DEK cache keyed on storage.dek mtime: the keychain subprocess costs
// ~50-100ms per call and the DEK only changes when Granola re-keys (which
// also rewrites storage.dek, changing its mtime and invalidating this cache).
let dekCache = { mtimeMs: 0, dek: null };

function loadDek(dekFile, opts = {}) {
  try {
    if (!existsSync(dekFile)) return null;
    // Tests inject keychainSecret and their own dekFile; never cache those.
    const cacheable = dekFile === STORAGE_DEK_FILE && !('keychainSecret' in opts);
    const mtimeMs = statSync(dekFile).mtimeMs;
    if (cacheable && dekCache.dek && dekCache.mtimeMs === mtimeMs) return dekCache.dek;
    const keychainSecret = 'keychainSecret' in opts
      ? opts.keychainSecret
      : readKeychainSecret(GRANOLA_KEYCHAIN_SERVICE, { rawService: true });
    if (!keychainSecret) {
      warnOnce('keychain', `[granola-client] keychain secret "${GRANOLA_KEYCHAIN_SERVICE}" unavailable — falling back to plaintext session files`);
      return null;
    }
    const dek = unwrapStorageDek(readFileSync(dekFile), keychainSecret);
    if (cacheable) dekCache = { mtimeMs, dek };
    return dek;
  } catch (e) {
    warnOnce(`dek:${dekFile}`, `[granola-client] failed to unwrap ${dekFile}: ${e.message} — falling back to plaintext session files`);
    return null;
  }
}

// Decrypt-and-parse one .enc file; null on any failure (missing file, no
// keychain, bad tag, bad JSON) so callers always have the plaintext fallback.
function readEncryptedJson(file, dekFile, opts = {}) {
  try {
    if (!existsSync(file)) return null;
    const dek = loadDek(dekFile, opts);
    if (!dek) return null;
    return decryptGranolaJson(readFileSync(file), dek);
  } catch (e) {
    warnOnce(`enc:${file}`, `[granola-client] failed to decrypt ${file}: ${e.message} — falling back to plaintext session files`);
    return null;
  }
}

function readPlainJson(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch { return null; }
}

// Read credentials from stored-accounts.json[.enc] (double-nested JSON) or cache.
// .enc preferred: the running app only updates the encrypted variant now.
function readStoredAccounts(opts = {}) {
  const paths = granolaPaths(opts.dir);
  const outer = readEncryptedJson(paths.storedAccountsEnc, paths.dek, opts)
    ?? readPlainJson(paths.storedAccounts);
  if (!outer) return null;
  const accounts = parseMaybeJson(outer.accounts);
  const acct = Array.isArray(accounts) ? accounts[0] : accounts;
  if (!acct?.tokens) return null;
  return parseMaybeJson(acct.tokens) || null;
}

function readSupabaseSession(opts = {}) {
  const paths = granolaPaths(opts.dir);
  const raw = readEncryptedJson(paths.supabaseEnc, paths.dek, opts)
    ?? readPlainJson(paths.supabase);
  if (!raw) return null;
  const tokens = parseMaybeJson(raw.workos_tokens);
  const userInfo = parseMaybeJson(raw.user_info);
  return {
    tokens: tokens && typeof tokens === 'object' ? tokens : null,
    userInfo: userInfo && typeof userInfo === 'object' ? userInfo : null,
    sessionId: raw.session_id || tokens?.session_id || null,
  };
}

function readTokenCache() {
  try {
    return existsSync(TOKEN_CACHE_FILE)
      ? JSON.parse(readFileSync(TOKEN_CACHE_FILE, 'utf8'))
      : null;
  } catch { return null; }
}

export function getGranolaLocalSession(opts = {}) {
  const paths = granolaPaths(opts.dir);
  const session = readSupabaseSession(opts);
  const email = session?.userInfo?.email || null;
  const signedIn = Boolean(session?.sessionId && (email || session?.tokens?.access_token || session?.tokens?.refresh_token));
  return {
    installed: existsSync(opts.dir || GRANOLA_DIR),
    // *File keys keep their original plaintext-only meaning (consumers gate
    // copy on them); the *EncFile keys report the encrypted variants.
    storedAccountsFile: existsSync(paths.storedAccounts),
    supabaseFile: existsSync(paths.supabase),
    storedAccountsEncFile: existsSync(paths.storedAccountsEnc),
    supabaseEncFile: existsSync(paths.supabaseEnc),
    signedIn,
    email,
    hasTokens: Boolean(session?.tokens?.access_token || session?.tokens?.refresh_token),
  };
}

// WHY ms÷1000: stored-accounts.json stores obtained_at in milliseconds;
// the previous code treated it as seconds, making every token appear expired.
export function isTokenExpired(tokens) {
  if (!tokens?.obtained_at || !tokens?.expires_in) return true;
  const obtainedSec = tokens.obtained_at > 1e10
    ? Math.floor(tokens.obtained_at / 1000)
    : tokens.obtained_at;
  return Math.floor(Date.now() / 1000) >= obtainedSec + tokens.expires_in - 300;
}

export async function refreshGranolaToken() {
  // Try cache first, then stored-accounts, for the refresh_token
  const tokens = readTokenCache() || readStoredAccounts() || readSupabaseSession()?.tokens;
  if (!tokens?.refresh_token) throw new Error('No Granola refresh_token available');

  const res = await fetch(GRANOLA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GRANOLA_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Granola token refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const fresh = await res.json();
  fresh.obtained_at = Date.now(); // store in ms to match stored-accounts.json format
  if (!fresh.refresh_token) fresh.refresh_token = tokens.refresh_token;
  try {
    writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(fresh, null, 2));
  } catch { /* non-fatal — cache write failure */ }
  return fresh;
}

export async function getGranolaToken() {
  // Read order: cache (our most recent refresh) → stored-accounts →
  // supabase session. The latter two prefer the .enc variants, which the
  // running app rewrites on every internal refresh — so a signed-in app
  // means a fresh access token here without us calling the refresh
  // endpoint (whose rotating refresh tokens we must not consume from the
  // app's own session, or the app's next refresh would fail).
  const cache = readTokenCache();
  if (cache?.access_token && !isTokenExpired(cache)) return cache.access_token;

  const stored = readStoredAccounts();
  if (stored?.access_token && !isTokenExpired(stored)) return stored.access_token;

  const supabase = readSupabaseSession()?.tokens;
  if (supabase?.access_token && !isTokenExpired(supabase)) return supabase.access_token;

  // Both are expired — attempt refresh
  try {
    const fresh = await refreshGranolaToken();
    if (fresh?.access_token) return fresh.access_token;
  } catch { /* fall through to Keychain fallback */ }

  return secret('GRANOLA_TOKEN') || secret('GRANOLA_API_KEY') || null;
}

// Granola's REST API rejects unidentified callers with {"message":"Unsupported
// client"}, so every request carries the desktop client identity headers the
// app itself sends. GRANOLA_CLIENT_VERSION tracks the installed app version.
async function restPost(accessToken, path, body) {
  const res = await fetch(`${GRANOLA_REST_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': `Granola/${GRANOLA_CLIENT_VERSION} Electron/33.4.11`,
      'X-Client-Version': GRANOLA_CLIENT_VERSION,
      'X-Client-Type': 'electron',
      'X-Client-Platform': 'darwin',
      'X-App-Version': GRANOLA_CLIENT_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Granola REST ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  // Node fetch handles gzip decompression automatically when Accept-Encoding is set
  return res.json();
}

function assembleTranscript(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  return segments
    .map(s => `${s.detected_speaker_name || s.speaker || 'Speaker'}: ${s.text || ''}`.trim())
    .filter(Boolean)
    .join('\n');
}

// Parse an ISO timestamp to epoch ms; null on anything unparseable. WHY ms (not
// seconds): transcript_segments.start_ms/end_ms are epoch ms and talk-share
// subtracts them directly.
function tsToMs(ts) {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Capture the structured per-turn shape Granola returns, BEFORE
 * assembleTranscript flattens it away (st_8a841c68 Phase 1). Each kept turn
 * carries the load-bearing `source` (microphone | system — Granola's Me/Them)
 * and start/end timestamps; turn_index is the conversational order.
 *
 * WHY filter on source: a turn with neither a microphone nor system source is
 * unusable for the mic anchor and talk-share, so it is dropped here rather than
 * stored as a half-row. Empty-text turns are also dropped (no content to
 * attribute). Pure — exported for unit tests.
 *
 * @param {Array} segments  — raw /v1/get-document-transcript segments
 * @returns {Array<{turnIndex:number,startMs:number|null,endMs:number|null,source:string,text:string}>}
 */
export function captureSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  let turnIndex = 0;
  for (const s of segments) {
    const source = String(s?.source || '').toLowerCase();
    if (source !== 'microphone' && source !== 'system') continue;
    const text = String(s?.text || '').trim();
    if (!text) continue;
    out.push({
      turnIndex: turnIndex++,
      startMs: tsToMs(s.start_timestamp),
      endMs: tsToMs(s.end_timestamp),
      source,
      text,
    });
  }
  return out;
}

/**
 * Extract attendee {email, name} pairs from a Granola document payload
 * (st_fd14cdd4 AC6 — replaces the hardcoded `attendees: []`).
 *
 * WHY defensive across shapes: the live payload could not be probed at build
 * time (all local Granola tokens expired and the refresh endpoint rejects the
 * stored refresh token), so every people-bearing field the API is known to
 * carry is handled: `people` (object with creator/attendees/others, or a
 * plain array), `attendees`, and the embedded `google_calendar_event`
 * (Google event resource — attendees[].email/displayName). Unknown shapes
 * yield [] and the caller falls back to the deterministic calendar join in
 * lib/granola-sync.js — never a crash, never fake data.
 *
 * Deduped by lowercased email. Pure — exported for unit tests.
 */
export function extractAttendeeEmails(doc) {
  const found = new Map();
  const add = (email, name) => {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized.includes('@')) return;
    if (!found.has(normalized) || (name && !found.get(normalized))) {
      found.set(normalized, String(name || '').trim());
    }
  };
  const addEntry = (entry) => {
    if (!entry) return;
    if (typeof entry === 'string') { add(entry, ''); return; }
    add(entry.email || entry.address || entry.emailAddress, entry.name || entry.displayName || entry.display_name);
  };

  const people = doc?.people;
  if (Array.isArray(people)) {
    for (const entry of people) addEntry(entry);
  } else if (people && typeof people === 'object') {
    addEntry(people.creator);
    for (const key of ['attendees', 'others', 'participants']) {
      for (const entry of people[key] || []) addEntry(entry);
    }
  }

  for (const entry of doc?.attendees || []) addEntry(entry);
  for (const entry of doc?.google_calendar_event?.attendees || []) addEntry(entry);

  return [...found.entries()].map(([email, name]) => ({ email, name }));
}

/**
 * st_1169bfc7 — registry-driven folder recognizer (replaces the hardcoded
 * 3-folder routedGranolaListSlug). Slugify the folder title, apply the alias
 * layer, and return the slug IFF the topic registry recognizes it — so a new
 * folder named like any existing Robot Dojo topic maps with zero code change
 * (AC2), and a name that matches no topic returns null → the caller's personal
 * fail-safe (AC3).
 *
 * db-free: the registry (`topicSlugs`, a Set) and `aliases` (topicAliases) are
 * threaded in as data by the two db-holding callers; this module never opens
 * the DB. Pure — exported for unit tests.
 *
 * @param {string} title      — the Granola folder title
 * @param {Set<string>} topicSlugs — classifiable user_topics slugs (see topics.js)
 * @param {Object} aliases    — topicAliases map (slug → canonical slug)
 * @returns {string|null} the registry-validated topic slug, or null on no match
 */
export function registrySlugForFolderTitle(title, topicSlugs, aliases = {}) {
  if (!topicSlugs || topicSlugs.size === 0) return null; // empty registry → recognize nothing (safe, AC3)
  const slug = normalizeTopicSlug(title);                // reuse the shared slugifier; "Career" → "career"
  if (!slug) return null;                                // emoji/blank title → no match
  const resolved = aliases[slug] || slug;                // apply topicAliases AFTER slugify (near-miss guard)
  return topicSlugs.has(resolved) ? resolved : null;     // registry-validated
}

/**
 * st_1169bfc7 — collapse each doc's set of matched folder slugs to ONE slug via
 * the MECE decision table, evaluated in precedence order. This single map value
 * is both the topic stamp and the Asana routing key, so both axes agree by
 * construction. Shared by the local-cache and REST membership paths so they can
 * never diverge. Pure — exported for unit tests.
 *
 *   primary-work slug ∈ set → that slug  (AC5, top precedence, incl. cross-filed)
 *   exactly one slug        → that slug   (AC1)
 *   2+ non-work slugs       → 'personal'  (AC6)
 *
 * The primary-work slug set is config-driven (primaryWorkTopicSlugs), so no
 * employer slug is hardcoded here. A doc absent from the input map stays absent
 * from the output → the caller's personal default (AC3).
 *
 * @param {Map<string, Set<string>>} docSlugs — docId → set of matched slugs
 * @param {Set<string>} [primarySlugs] — the primary-work topic slugs (config-derived)
 * @returns {Map<string, string>} docId → resolved slug
 */
export function resolveDocSlugs(docSlugs, primarySlugs = primaryWorkTopicSlugs()) {
  const membership = new Map();
  for (const [docId, slugs] of docSlugs) {
    const primaryHit = [...slugs].find((s) => primarySlugs.has(s));
    if (primaryHit) membership.set(docId, primaryHit);              // AC5 — work wins
    else if (slugs.size === 1) membership.set(docId, [...slugs][0]);                 // AC1
    else membership.set(docId, AMBIGUOUS_FALLBACK_SLUG);                             // AC6
  }
  return membership;
}

/**
 * Build the Map<meetingId, topicSlug> from per-list doc-id sets, in fetch
 * order. Pure — exported for unit tests.
 *
 * df_e1dcf732 AC1 broken-feed guard: when ≥2 routed lists were fetched and
 * every fetched set is pairwise identical, Granola is not telling calls apart
 * (the live 2026-07 failure: /v1/get-documents ignores document_list_id and
 * returns the identical 466-doc corpus for every list). A folder mark that
 * appears on every call carries zero routing information — discard the whole
 * map (the existing empty-map degradation) so the calendar signal decides.
 * When Granola fixes the feed the sets diverge and the folder layer resumes
 * with zero further change.
 *
 * st_1169bfc7: the discriminating case now runs through resolveDocSlugs (the
 * MECE decision table) instead of first-list-wins, so a doc cross-filed into a
 * primary-work folder + another folder resolves to the work slug (AC5) and a doc
 * in 2+ non-work folders resolves to personal (AC6) — the same tiebreak the
 * local-cache path uses, so the two paths cannot diverge.
 */
export function buildListMembership(fetchedLists) {
  const withIds = (fetchedLists || []).filter((l) => l && Array.isArray(l.ids));
  if (withIds.length >= 2) {
    const sets = withIds.map((l) => new Set(l.ids));
    const [first] = sets;
    const allIdentical = sets.every((s) => s.size === first.size && [...s].every((id) => first.has(id)));
    if (allIdentical) {
      console.warn(`[granola-client] broken-feed guard: ${withIds.length} routed lists returned identical ${first.size}-doc sets — folder marks carry no routing signal, discarding membership map`);
      return new Map();
    }
  }
  const docSlugs = new Map();
  for (const { slug, ids } of withIds) {
    for (const id of ids) {
      if (!id) continue;
      if (!docSlugs.has(id)) docSlugs.set(id, new Set());
      docSlugs.get(id).add(slug);
    }
  }
  return resolveDocSlugs(docSlugs);
}

/**
 * Build a Map<meetingId, topicSlug> by fetching Granola document-list
 * membership for the user-managed call folders that affect routing.
 * Falls back to empty Map on any API error so callers degrade to the
 * calendar-signal layer (lib/call-routing.js resolveCallTopic).
 */
/**
 * df_33f550b7 — folder membership from Granola's LOCAL encrypted cache
 * (cache-v6.json.enc), which the desktop app uses as its own source of truth for
 * what call sits in what folder. This is the authoritative doc→folder mapping.
 *
 * WHY local-first: the REST path (get-documents by document_list_id) is broken —
 * Granola's API ignores the list filter and returns the identical full corpus for
 * every folder (the df_e1dcf732 broken-feed guard exists exactly because of this),
 * which disarms the whole tag layer and forces everything onto the calendar
 * backup. The local cache carries real per-folder membership (a work folder
 * and Personal hold different document-id sets), so reading it restores the folder
 * tag as the PRIMARY routing signal, with calendar as the backup. Same decrypt
 * mechanism the client already uses for stored-accounts.json.enc / supabase.json.enc.
 *
 * Returns Map<granolaDocId, topicSlug> for routed folders only; empty Map when the
 * cache is unreadable (missing keychain/DEK/file) so the caller falls back to the API.
 */
export function readGranolaLocalListMembership(opts = {}) {
  try {
    const dir = opts.dir || GRANOLA_DIR;
    const cacheEnc = join(dir, 'cache-v6.json.enc');
    if (!existsSync(cacheEnc)) return new Map();
    const dek = loadDek(join(dir, 'storage.dek'), opts);
    if (!dek) return new Map();
    const data = decryptGranolaJson(readFileSync(cacheEnc), dek);
    const state = data?.cache?.state || data?.state || data || {};
    const documentLists = state.documentLists || {};
    const metadata = state.documentListsMetadata || {};
    // st_1169bfc7 — collect the distinct registry-matched slugs each doc is
    // filed under, then collapse to one slug via resolveDocSlugs (the MECE
    // decision table): a primary-work slug present wins (AC5), a lone folder sets
    // that topic (AC1), 2+ non-work folders resolve to personal (AC6). A doc in no
    // matched folder is simply absent → the caller's personal default (AC3).
    const docSlugs = new Map();
    for (const folderId of Object.keys(documentLists)) {
      const title = metadata[folderId]?.title || metadata[folderId]?.name || '';
      const slug = registrySlugForFolderTitle(title, opts.topicSlugs, opts.aliases);
      if (!slug) continue;
      for (const docId of documentLists[folderId] || []) {
        if (!docId) continue;
        if (!docSlugs.has(docId)) docSlugs.set(docId, new Set());
        docSlugs.get(docId).add(slug);
      }
    }
    return resolveDocSlugs(docSlugs);
  } catch (err) {
    warnOnce('local-list-membership', `[granola-client] local list membership read failed: ${err.message} — falling back to API`);
    return new Map();
  }
}

export async function fetchGranolaListMembership(opts = {}) {
  // df_33f550b7 — local cache is the authoritative primary (the API list filter is
  // broken). Only fall back to the REST path + broken-feed guard when the local
  // cache can't be read (no keychain/DEK, e.g. a headless/CI context).
  // st_1169bfc7 — opts carries the registry: { topicSlugs, aliases }, threaded
  // through both membership paths so recognition is registry-driven.
  const local = readGranolaLocalListMembership(opts);
  if (local.size > 0) return local;
  // On the API-key path there is no desktop session, so the REST fallback below
  // can only 401. Skip it rather than warn on every sync. Consequence: folder
  // membership is unavailable, so topic routing uses the personal fail-safe.
  const apiKey = secret('GRANOLA_API_KEY');
  if (apiKey && String(apiKey).startsWith('grn_')) {
    warnOnce('list-membership:api-key', '[granola-client] folder membership unavailable on the API-key path — new calls fall back to the personal topic until a desktop session is readable');
    return new Map();
  }
  try {
    const token = await getGranolaToken();
    if (!token) return new Map();
    const meta = await restPost(token, '/v1/get-document-lists-metadata', {});
    const lists = Object.values(meta?.lists || {});
    const slots = lists
      .map((list) => [list.id, registrySlugForFolderTitle(list.title, opts.topicSlugs, opts.aliases)])
      .filter(([id, slug]) => id && slug);
    const fetched = [];
    for (const [listId, slug] of slots) {
      const docs = await restPost(token, '/v1/get-documents', { document_list_id: listId });
      const arr = Array.isArray(docs) ? docs : (docs?.documents || []);
      fetched.push({ slug, ids: arr.map((doc) => doc.id || doc.document_id).filter(Boolean) });
    }
    return buildListMembership(fetched);
  } catch (err) {
    console.warn(`[granola-client] fetchGranolaListMembership error: ${err.message}`);
    return new Map();
  }
}

/**
 * Fetch meetings over Granola's documented public API using a workspace API
 * key. Shape of the returned objects matches the desktop-session path exactly,
 * so granola-sync stays unchanged.
 * Docs: https://docs.granola.ai — GET /notes, GET /notes/{id}/transcript.
 * Only notes with a generated summary and transcript are returned by Granola.
 */
async function publicApiGet(apiKey, path) {
  const res = await fetch(`${GRANOLA_PUBLIC_API_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Granola public API ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchGranolaMeetingsViaPublicApi(apiKey, existingIds, createdAfter = null) {
  const notes = [];
  let cursor = null;
  // Sustained rate limit is 5 req/s; one list page per loop is well inside it.
  // A page failure breaks the loop rather than aborting the sync — deep cursors
  // have been observed to 500 server-side, and a partial pull beats none.
  do {
    const params = new URLSearchParams();
    if (createdAfter) params.set('created_after', createdAfter);
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    let page;
    try {
      page = await publicApiGet(apiKey, `/notes${qs ? `?${qs}` : ''}`);
    } catch (e) {
      console.warn(`[granola-client] note listing stopped early: ${e.message}`);
      break;
    }
    const batch = page.notes || page.data || (Array.isArray(page) ? page : []);
    notes.push(...batch);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);

  const results = [];
  for (let note of notes) {
    const meetingId = note.id || note.note_id;
    if (!meetingId || existingIds.has(meetingId)) continue;
    try {
      // Inline retrieval is the documented primary path; the dedicated
      // transcript endpoint is the fallback for oversized transcripts (413).
      let full = note;
      let segments = [];
      try {
        full = await publicApiGet(apiKey, `/notes/${meetingId}?include=transcript`);
        const inline = full?.transcript ?? full?.note?.transcript;
        segments = Array.isArray(inline) ? inline : (inline?.segments || []);
      } catch (inlineErr) {
        console.warn(`[granola-client] inline transcript failed for ${meetingId}: ${inlineErr.message}`);
      }
      if (!segments.length) {
        const t = await publicApiGet(apiKey, `/notes/${meetingId}/transcript`);
        segments = Array.isArray(t) ? t : (t?.segments || t?.transcript?.segments || []);
      }
      note = full?.note || full || note;
      const attendeeDetails = extractAttendeeEmails(note);
      const cal = note.google_calendar_event || note.calendar_event || {};
      results.push({
        id: meetingId,
        title: note.title || note.name || 'Untitled',
        date: note.created_at || note.date || new Date().toISOString().slice(0, 10),
        transcript: assembleTranscript(segments),
        segments: captureSegments(segments),
        calendarEventId: cal.id || null,
        icalUid: cal.iCalUID || cal.ical_uid || null,
        durationMinutes: note.duration_minutes || null,
        callNotes: note.summary_markdown || note.notes_markdown || note.summary || null,
        attendees: attendeeDetails.map((a) => a.email),
        attendeeDetails,
      });
    } catch (e) {
      console.warn(`[granola-client] skipping note ${meetingId}: ${e.message}`);
    }
  }
  return results;
}

export async function fetchGranolaMeetings(opts = {}) {
  const { existingIds = new Set(), createdAfter = null } = opts;

  // Public API first (df: desktop-session path broke when Granola 7.465 moved
  // the storage DEK, so the .enc session files can no longer be decrypted).
  // A workspace API key (grn_…) reaches the same notes over the documented
  // public API and needs no local session at all.
  const apiKey = secret('GRANOLA_API_KEY');
  if (apiKey && String(apiKey).startsWith('grn_')) {
    return fetchGranolaMeetingsViaPublicApi(apiKey, existingIds, createdAfter);
  }

  const token = await getGranolaToken();
  if (!token) throw new Error('No Granola token available');

  const docs = await restPost(token, '/v1/get-documents', {});
  if (!Array.isArray(docs) && !Array.isArray(docs?.documents)) {
    throw new Error(`Unexpected get-documents response: ${JSON.stringify(docs).slice(0, 200)}`);
  }
  const meetings = Array.isArray(docs) ? docs : (docs.documents || []);

  const results = [];
  for (const doc of meetings) {
    const meetingId = doc.id || doc.document_id;
    if (!meetingId) continue;
    if (existingIds.has(meetingId)) continue; // already stored — skip

    try {
      const data = await restPost(token, '/v1/get-document-transcript', { document_id: meetingId });
      const segments = Array.isArray(data) ? data : (data?.segments || data?.transcript?.segments || []);
      const transcriptText = assembleTranscript(segments);

      const attendeeDetails = extractAttendeeEmails(doc);
      // st_8a841c68 Phase 1: keep the structured per-turn segments + the
      // calendar-event keys (the Google roster join key + the cross-provider
      // iCalUID bridge) that assembleTranscript and the old push discarded.
      const cal = doc.google_calendar_event || {};
      results.push({
        id: meetingId,
        title: doc.title || doc.name || 'Untitled',
        date: doc.created_at || doc.date || new Date().toISOString().slice(0, 10),
        transcript: transcriptText,
        segments: captureSegments(segments),
        calendarEventId: cal.id || null,
        icalUid: cal.iCalUID || cal.ical_uid || null,
        durationMinutes: doc.duration_minutes || null,
        callNotes: doc.notes_markdown || doc.notes_plain || null,
        // attendees stays an email array (back-compat with granola-sync's
        // CSV column); attendeeDetails carries names for seeding.
        attendees: attendeeDetails.map((a) => a.email),
        attendeeDetails,
      });
    } catch (e) {
      console.warn(`[granola-client] skipping meeting ${meetingId}: ${e.message}`);
    }
  }

  return results;
}
