#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const surfaceIdx = process.argv.indexOf('--surface');
const surfaceArg = surfaceIdx === -1 ? 'all' : (process.argv[surfaceIdx + 1] || 'all');
const surfaces = surfaceArg === 'all' ? [
  'public-entry',
  'installer',
  'handoff',
  'no-setup-surface',
  'readiness',
  'integrations',
  'ollama',
  'imports',
  'faq-chat-tab',
  'remote-access-hidden',
  'historical-screens',
] : [surfaceArg];

function read(path) {
  return readFileSync(path, 'utf8');
}

function fail(message) {
  throw new Error(`[${surfaceArg}] ${message}`);
}

function requireText(path, text) {
  const src = read(path);
  if (!src.includes(text)) fail(`${path} missing ${text}`);
}

function forbid(path, rx, label = rx) {
  const src = read(path);
  if (rx.test(src)) fail(`${path} contains banned ${label}`);
}

function checkPublicEntry() {
  for (const path of ['apps/index.html', 'apps/static/shared/marketing.js', 'README.md']) {
    requireText(path, 'curl -fsSL https://robotdojo.ai/install.sh | bash');
  }
  const combined = ['apps/index.html', 'apps/static/shared/marketing.js', 'apps/static/faq/core.json', 'README.md']
    .filter(existsSync)
    .map(read)
    .join('\n');
  const staleRx = new RegExp(String.raw`2 weeks free|Samurai|Ollama[^\n]*roadmap|not official`, 'i');
  const staleHit = combined.match(staleRx);
  if (staleHit) {
    fail(`public entry/help has stale trial, Samurai, or Ollama roadmap copy: ${staleHit[0]}`);
  }
}

function checkInstaller() {
  const src = read('apps/static/install.sh');
  for (const text of [
    'setup_device_name',
    'scutil --get ComputerName',
    '$ROBOTDOJO_CONFIG/device-name',
    'ROBOTDOJO_AUTH_TOKEN',
    'npm ci --omit=dev',
    'provision_mkcert_local_tls',
    'ensure_ollama_macos',
    'wait_for_health',
    'wait_for_relay_readiness',
    'PRODUCT_ORIGIN="${ROBOTDOJO_PRODUCT_ORIGIN:-https://robotdojo.ai}"',
  ]) {
    if (!src.includes(text)) fail(`installer missing ${text}`);
  }
  // The installer NOW asks for a user-chosen dojo address up front (reversing
  // the earlier "no slug prompt" stance) so the Cloudflare per-hostname edge
  // certificate can warm in the background during install. Assert the validated
  // prompt + slug validator exist, read from a real terminal, and that the
  // device-name auto-derive (setup_device_name, above) remains the
  // non-interactive fallback so curl|bash installs never hang.
  for (const text of ['prompt_dojo_slug', 'validate_slug', 'RESERVED_SLUGS_BASH', '/dev/tty', 'DOJO_SLUG']) {
    if (!src.includes(text)) fail(`installer must prompt for a validated dojo address (${text})`);
  }
  if (!src.includes('/api/server-health?deep=1')) {
    fail('installer must wait on deep server health');
  }
  if (src.includes('wait_for_health || true')) {
    fail('installer must fail loudly when health does not pass');
  }
  if (!/wait_for_health\s+if ! wait_for_relay_readiness; then[\s\S]+?open_browser/.test(src)) {
    fail('installer must open browser after local health with relay as optional setup');
  }
  if (!src.includes('Continuing with local access')) {
    fail('installer must make relay failure non-blocking and explicit');
  }
  if (!src.includes('Service and database healthy')) {
    fail('installer must report deep service/database health before browser handoff');
  }
  if (!/h\.status === "ok" && h\.deep === true && h\.db && h\.db\.ok === true/.test(src)) {
    fail('installer must parse deep health JSON and require db.ok true');
  }
}

function checkHandoff() {
  const install = read('apps/static/install.sh');
  const page = read('apps/install-success.html');
  if (!install.includes('INTEGRATIONS_HANDOFF_URL="${local_origin}/account/integrations"')) {
    fail('installer must open local Account Integrations');
  }
  if (!install.includes('CHAT_HANDOFF_URL="${local_origin}/chat?context=setup-guide')) {
    fail('installer must open local setup-aware chat help');
  }
  if (!install.includes('https://${slug}.robotdojo.ai/api/server-health?deep=1')) {
    fail('installer must verify relay readiness through the plumbing URL when remote access is configured');
  }
  if (/\/setup\/start|localhost:[^"'\s]*\/setup|127\.0\.0\.1:[^"'\s]*\/setup/.test(install)) {
    fail('installer still opens the deleted setup route');
  }
  requireText('apps/static/install.sh', 'https://localhost:${APP_PORT}/account/integrations');
  requireText('apps/static/install.sh', 'https://localhost:${APP_PORT}/chat?context=setup-guide');
  // AC6 (st_96bb626f) — install-success CTAs open the LOCAL dojo, not the apex.
  // After install the local server is running on https://localhost:4338, so the
  // welcome page hands off to the running product directly. Guard against the
  // deleted /setup surface, but localhost is the intended target here.
  if (/\/setup\/start|localhost:[^"'\s]*\/setup|127\.0\.0\.1:[^"'\s]*\/setup/.test(page)) { // check-literals:ignore-line
    fail('install-success still opens the deleted setup route');
  }
  requireText('apps/install-success.html', 'https://localhost:4338/account/integrations'); // check-literals:ignore-line — AC6 local-dojo CTA
  requireText('apps/install-success.html', 'https://localhost:4338/chat?context=setup-guide'); // check-literals:ignore-line — AC6 local-dojo CTA
  requireText('apps/install-success.html', 'Open Integrations');
  requireText('apps/install-success.html', 'Open chat help');
}

function checkNoSetupSurface() {
  for (const path of ['apps/setup/index.html', 'apps/setup/app.js', 'apps/setup/style.css']) {
    if (existsSync(path)) fail(`${path} must not exist`);
  }
  const server = read('lib/server.js');
  if (/app\.(get|use)\('\/setup/.test(server) || /app\.route\('\/setup/.test(read('index.js'))) {
    fail('server still registers a /setup product route');
  }
}

function checkReadiness() {
  requireText('lib/setup-readiness.js', 'ready_to_chat');
  requireText('routes/setup/onboarding.js', 'computeSetupReadiness');
  requireText('apps/account/app.js', '/api/setup/progress');
}

function checkIntegrations() {
  requireText('lib/launch-integrations.js', 'Remote access relay');
  // st_fd14cdd4 — Microsoft was UNHIDDEN per owner directive. The launch-hidden
  // MECHANISM stays (an empty Set + isLaunchHiddenProvider) so a future provider
  // can be hidden without re-plumbing; assert the mechanism still exists and that
  // Microsoft is no longer in it. The email/calendar picker must still not carry a
  // hard-coded ['microsoft','email'] launch tuple (the surface comes from the card
  // contract, not a literal picker entry).
  requireText('lib/launch-integrations.js', 'LAUNCH_HIDDEN_PROVIDERS = new Set()');
  forbid('lib/launch-integrations.js', /LAUNCH_HIDDEN_PROVIDERS = new Set\(\[[^\]]*'microsoft'/, 'microsoft re-added to the launch-hidden set');
  forbid('apps/account/app.js', /\['microsoft','(email|calendar)'\]/, 'microsoft in the launch email/calendar picker');
  requireText('apps/account/app-config.js', "'remote-access': 'general'");
  requireText('apps/account/app.js', 'Login token');
}

function checkOllama() {
  const combined = ['apps/static/faq/core.json', 'routes/api.js', 'lib/setup-local-help.js'].map(read).join('\n');
  if (/Ollama.*roadmap|not official|disableAndRemove/.test(combined)) {
    fail('Ollama still described as roadmap-only or removed after cloud key');
  }
  requireText('lib/setup-local-help.js', 'Ollama');
}

function checkImports() {
  forbid('apps/account/app-config.js', /imports:\s*['"]integrations['"]/, 'imports-to-integrations alias');
  requireText('apps/account/app.js', 'HIDDEN_ROUTABLE_SECTIONS');
  requireText('apps/account/app.js', "'imports'");
  requireText('apps/account/app.js', 'renderImports');
}

function checkFaqChatTab() {
  requireText('apps/static/install.sh', 'CHAT_HANDOFF_URL');
  requireText('apps/static/install.sh', 'context=setup-guide');
  requireText('apps/chat/public-app.js', 'setup-guide');
}

function checkRemoteAccessHidden() {
  requireText('apps/account/app.js', "data-card=\"remote-access\"");
  requireText('apps/account/app.js', 'Login token');
}

function checkHistoricalScreens() {
  checkHandoff();
  checkNoSetupSurface();
  checkPublicEntry();
}

// Verify the installer's target repo is ANONYMOUSLY clonable. The one-line
// `curl … | bash` install runs `git clone` with no credentials and no TTY, so a
// private repo turns the auth prompt into an immediate failure ("fatal:
// Authentication failed") and every cohort user's install dies at the clone.
// A string match on the marketing copy can't catch this — only an actual
// unauthenticated reachability probe can (st_fcdbe84f AC18 / B1a).
//
// OPT-IN surface: deliberately NOT in the default `all` set, because the public
// repo is created as the LAST launch step — running it before cutover would
// (correctly) fail on the still-private repo and block every commit. Run it at
// cutover and in launch CI, or point it at a public test remote early to prove
// the install mechanism:
//   node scripts/check-installer-self-serve.js --surface repo-reachability
//   ROBOTDOJO_REPO=https://github.com/you/public-test.git node scripts/check-installer-self-serve.js --surface repo-reachability
function checkRepoReachability() {
  const src = read('apps/static/install.sh');
  const m = src.match(/ROBOTDOJO_REPO="\$\{ROBOTDOJO_REPO:-([^}"]+)\}"/);
  if (!m) fail('cannot find ROBOTDOJO_REPO default in apps/static/install.sh');
  const url = process.env.ROBOTDOJO_REPO || m[1];
  try {
    // GIT_TERMINAL_PROMPT=0 + a no-op GIT_ASKPASS make a private repo's
    // git-upload-pack (info/refs) fail fast instead of hanging on a prompt —
    // exactly what happens in the headless installer pipe.
    const out = execFileSync('git', ['ls-remote', '--heads', url], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!out.trim()) {
      fail(`installer repo ${url} reachable but exposes no branches (info/refs empty)`);
    }
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).split('\n')[0];
    fail(`installer repo ${url} is not anonymously clonable (git ls-remote / git-upload-pack failed): ${detail}`);
  }
}

const checks = {
  'public-entry': checkPublicEntry,
  installer: checkInstaller,
  handoff: checkHandoff,
  'no-setup-surface': checkNoSetupSurface,
  readiness: checkReadiness,
  integrations: checkIntegrations,
  ollama: checkOllama,
  imports: checkImports,
  'faq-chat-tab': checkFaqChatTab,
  'remote-access-hidden': checkRemoteAccessHidden,
  'historical-screens': checkHistoricalScreens,
  // Opt-in (network) — intentionally excluded from the default `all` surfaces
  // above; run at cutover. See checkRepoReachability().
  'repo-reachability': checkRepoReachability,
};

for (const surface of surfaces) {
  const fn = checks[surface];
  if (!fn) fail(`unknown surface ${surface}`);
  fn();
}

process.stdout.write(`[check-installer-self-serve] ${surfaceArg} ok\n`);
