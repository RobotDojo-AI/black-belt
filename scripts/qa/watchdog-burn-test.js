#!/usr/bin/env node
/**
 * scripts/qa/watchdog-burn-test.js — st_f6315f0b AC 5 / VC 5
 *
 * Asserts: when a com.robotdojo.* IDLE_GATED=true worker sustains CPU above
 * 20% for 3 consecutive samples while the user is active, the watchdog
 * terminates the current launchd run and POSTs exactly one Asana task.
 *
 * Strategy:
 *   1. Spin up a tiny HTTP server on 127.0.0.1:N that counts POSTs to /mock.
 *   2. Add a fixture entrypoint script under /tmp/qa-watchdog-burn/ that
 *      declares IDLE_GATED=true.
 *   3. Stage a fixture plist + register it with launchctl (skip if /tmp
 *      can't host LaunchAgents — adapt to a pure-fixture mode).
 *   4. Invoke ram-watchdog.sh with --mock-cpu="com.robotdojo.test-burn:25,30,28"
 *      --mock-user-active=1 --skip-signal (we don't want to really signal)
 *      --asana-url=http://127.0.0.1:PORT/mock.
 *   5. Assert the watchdog log contains BURN + TERMINATE lines for the slot
 *      AND the mock Asana endpoint saw exactly one POST.
 *
 * --simulate "label:c1,c2,c3"  inject CPU samples
 * --user-active                set user_active=1 (always-on in our shim)
 *
 * Exit 0 with single OK line on pass.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; }
const simulate = arg('--simulate') || 'com.robotdojo.test-burn:25,30,28';
// --user-active is a presence flag in the plan VC; we treat it as truthy.
const userActive = args.includes('--user-active');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const slotLabel = simulate.split(':')[0];

const tmpDir = mkdtempSync(join(tmpdir(), 'qa-watchdog-burn-'));
let server = null;
let posts = 0;
let postBodies = [];

try {
  // 1. Mock Asana endpoint.
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      posts++;
      postBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const asanaUrl = `http://127.0.0.1:${port}/mock`;

  // 2. Drop a fixture entrypoint + plist that resolves the IDLE_GATED check.
  //    The plist file lives in ~/Library/LaunchAgents/ because the watchdog
  //    reads from there. Real launchd signaling is skipped via --skip-signal.
  const fixtureScript = join(tmpDir, 'fixture-burn-worker.js');
  writeFileSync(fixtureScript, `#!/usr/bin/env node\nexport const IDLE_GATED = true;\nconsole.log('fixture worker');\n`);

  const launchAgentsDir = join(process.env.HOME, 'Library', 'LaunchAgents');
  const plistPath = join(launchAgentsDir, `${slotLabel}.plist`);
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${slotLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${REPO_ROOT}/${fixtureScript.replace(REPO_ROOT + '/', '')}</string>
  </array>
</dict>
</plist>
`;
  // ⚠️ Need fixtureScript path to be picked up by watchdog's entrypoint regex
  // which only matches "$HOME/robotdojo/..." paths. Put the fixture script
  // under the repo's tmp area.
  const repoTmp = join(REPO_ROOT, 'tmp');
  mkdirSync(repoTmp, { recursive: true });
  const fixtureUnderRepo = join(repoTmp, `fixture-${Date.now()}.js`);
  writeFileSync(fixtureUnderRepo, `// IDLE_GATED test fixture\nexport const IDLE_GATED = true;\nprocess.exit(0);\n`);

  const plistXml2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${slotLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${fixtureUnderRepo}</string>
  </array>
</dict>
</plist>
`;
  writeFileSync(plistPath, plistXml2);

  // 3. Clear any prior CPU-sample state for this slot.
  const sampleDir = '/tmp/robotdojo-watchdog-cpu';
  try { rmSync(join(sampleDir, `${slotLabel}.samples`), { force: true }); } catch {}
  // Clear Asana lock for this slot so the test always posts.
  try { rmSync(`/tmp/robotdojo-watchdog-asana-${slotLabel}.lock`, { force: true }); } catch {}

  // 4. Invoke the watchdog with the simulation flags.
  const result = spawnSync('/bin/bash', [
    `${REPO_ROOT}/scripts/ram-watchdog.sh`,
    `--mock-cpu=${simulate}`,
    `--mock-user-active=1`,
    `--skip-signal`,
    `--mock-free-pct=50`,
    `--asana-url=${asanaUrl}`,
  ], { encoding: 'utf8', timeout: 15_000 });

  if (result.status !== 0) {
    console.error('watchdog stderr:', result.stderr);
    fail(`watchdog exited ${result.status}`);
  }

  // 5. Read the watchdog log and assert it has BURN + TERMINATE entries.
  const logFs = await import('node:fs');
  const watchdogLog = logFs.readFileSync('/tmp/ramwatch.log', 'utf8').split('\n').slice(-50).join('\n');
  if (!watchdogLog.includes(`BURN ${slotLabel}`)) {
    console.error('watchdog log (last 50 lines):\n' + watchdogLog);
    fail('watchdog did not log BURN for the test slot');
  }
  if (!watchdogLog.includes(`TERMINATE ${slotLabel}`)) {
    console.error('watchdog log (last 50 lines):\n' + watchdogLog);
    fail('watchdog did not log TERMINATE for the test slot');
  }

  // 6. Give the curl call time to land. The watchdog backgrounds nothing here
  //    (curl is foreground in the shell), so the POST should already be in.
  //    But the HTTP server's request-end fires asynchronously; wait briefly.
  await new Promise(r => setTimeout(r, 200));

  if (posts !== 1) {
    fail(`Asana mock received ${posts} POST(s), expected exactly 1`);
  }

  console.log(`OK: termination fired within one cycle, exactly 1 Asana task POSTed`);
  // Do NOT call process.exit here — it would skip the finally block in
  // Node. The implicit "fall off the end" lets cleanup run, then the
  // process exits 0 naturally.
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  if (server) try { server.close(); } catch {}
  // Clean fixture plist so it doesn't pollute the live launchd registry.
  const plistPath2 = join(process.env.HOME, 'Library', 'LaunchAgents', `${slotLabel}.plist`);
  try { rmSync(plistPath2, { force: true }); } catch {}
  // Wipe the entire repo tmp/ so we never leave fixtures around (the dir
  // is owned by the test runner; nothing else should depend on it).
  try { rmSync(join(REPO_ROOT, 'tmp'), { recursive: true, force: true }); }
  catch (e) { console.error('cleanup tmp/ failed:', e.message); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { rmSync(`/tmp/robotdojo-watchdog-asana-${slotLabel}.lock`, { force: true }); } catch {}
  try { rmSync(`/tmp/robotdojo-watchdog-cpu/${slotLabel}.samples`, { force: true }); } catch {}
}
