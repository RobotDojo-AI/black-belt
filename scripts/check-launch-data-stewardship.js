#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function must(path, pattern, message) {
  const text = read(path);
  if (pattern instanceof RegExp ? !pattern.test(text) : !text.includes(pattern)) {
    failures.push(`${path}: ${message}`);
  }
}

function mustNot(path, pattern, message) {
  const text = read(path);
  if (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)) {
    failures.push(`${path}: ${message}`);
  }
}

function mustExist(path) {
  if (!existsSync(join(root, path))) failures.push(`${path}: missing`);
}

must('lib/drop-folder/paths.js', 'USERFILES_ROOT', 'user-facing files must use USERFILES_ROOT');
must('lib/drop-folder/paths.js', 'USER_FILES_DIR', 'default user files root must be ~/robotdojo/user/files');

must('routes/files.js', 'USERFILES_ROOT', 'reclassify/download must know the durable userfiles root');
must('routes/files.js', 'destination resolves outside user files root', 'reclassify destination must be user files-specific');
mustNot('routes/files.js', 'destination resolves outside drop root', 'reclassify must not reject userfiles destinations as outside drop root');

must('routes/setup/steps/drop-folder.js', 'drop_folder_files', 'setup must read the live drop-folder table');
must('routes/setup/steps/drop-folder.js', '~/robotdojo/user/inbox', 'setup must point to the single import path');
mustNot('routes/setup/steps/drop-folder.js', 'imports/' + 'Inbox', 'setup must not resurrect the retired import Inbox');
mustNot('routes/setup/steps/drop-folder.js', 'FROM files', 'setup must not query the legacy files table');

mustNot('scripts/init-drop-folder.sh', /mkdir_secure "\$ROOT\/(Inbox|Processing|Processed|Errors)"/, 'init script must not create old staging folders');
must('scripts/init-drop-folder.sh', 'USERFILES_ROOT', 'init script must create the user-facing document root');
must('scripts/init-drop-folder.sh', 'user/files', 'init script must default durable docs to ~/robotdojo/user/files');
mustNot('apps/chat/components/drop-events.js', 'imports/' + 'Inbox', 'chat copy must not mention the old Inbox path');

must('lib/imports-envelope.js', 'dropFolderRows', 'imports API envelope must include drop-folder rows');
must('routes/accounts.js', 'buildImportsEnvelope', 'accounts imports route must return the stable envelope');
must('routes/accounts.js', 'listDropFolderImportRows', 'accounts imports route must include drop-folder history');
must('apps/account/app.js', 'Files in import history', 'account UI must render drop-folder history');
must('apps/account/app.js', 'imports:          renderImports', 'account UI must expose import history through the imports deep link');
must('apps/account/app.js', '<code>~/robotdojo/user/inbox</code>', 'empty imports state must show the drop path');

must('lib/backup-options.js', 'SUPPORTED_BACKUP_CHOICES', 'backup choices must be centralized');
for (const choice of ['gcp', 'aws', 'google_drive', 'time_machine', 'skip']) {
  must('lib/backup-options.js', `'${choice}'`, `backup choice missing: ${choice}`);
}
must('scripts/backup-dispatcher.js', 'export const IDLE_GATED = true', 'backup dispatcher must declare the idle gate');
must('scripts/backup-dispatcher.js', 'action: \'backup_noop\'', 'backup dispatcher must visibly noop when skipped/unconfigured');
mustNot('scripts/backup-dispatcher.js', 'force-from-nightly', 'backup dispatcher must not preserve nightly backup ownership aliases');
mustNot('scripts/maintenance-phases.js', 'backup-dispatcher.js', 'maintenance phases must not own backup; dedicated backup LaunchAgent is the single owner');
// df_3df1f108 — the staleness alarm, the catch-up trigger, and the auto-push
// must never be hosted on the thing they watch. In this defect's scenario the
// machine is off and the backup does not run; a monitor riding the backup would
// not run either and the owner would never be told. These two lines lock the
// carrier in place so the fix cannot acquire the silent-failure property of the
// bug it fixed.
must('lib/passive-supervisor.js', 'backup-guardian', 'backup guardian must be wired into the always-on server supervisor');
for (const carrier of ['scripts/backup-to-gcp.js', 'scripts/backup-dispatcher.js', 'apps/static/launch-agents/com.robotdojo.backup.plist.template']) {
  mustNot(carrier, 'backup-guardian', 'backup guardian must not be hosted on the backup job it watches');
}
must('config/launch-agents.json', 'com.robotdojo.backup', 'product backup LaunchAgent must be packaged');
mustExist('apps/static/launch-agents/com.robotdojo.backup.plist.template');
must('apps/static/launch-agents/com.robotdojo.backup.plist.template', '__ROBOTDOJO_HOME__/scripts/backup-dispatcher.js', 'backup LaunchAgent must call the dispatcher through installer placeholders');
must('apps/static/launch-agents/com.robotdojo.backup.plist.template', '--strict', 'backup LaunchAgent must run strict backup');
must('apps/static/launch-agents/com.robotdojo.backup.plist.template', '--force-scheduled', 'backup LaunchAgent must make a real scheduled attempt instead of idle-gate skipping');
mustNot('apps/static/launch-agents/com.robotdojo.backup.plist.template', '/Users/miyagi', 'LaunchAgent template must not hardcode owner paths');

must('lib/launch-integrations.js', "id: 'backup'", 'launch product-state contract must be generic backup');
mustNot('lib/launch-integrations.js', 'gcp-backup', 'launch contract must not expose GCP as the whole product truth');
mustNot('routes/accounts.js', "provider: 'gcp-backup'", 'account card must use generic backup provider');
must('apps/privacy.html', 'you own, control, and pay for', 'privacy copy must name a user-owned/-controlled/-paid backup destination');
must('apps/privacy.html', 'Robot Dojo has no server-side copy', 'privacy copy must distinguish Robot Dojo servers from user backup');

must('scripts/import-oura-json.js', 'await wasIngested', 'Oura importer must await the duplicate guard');
must('scripts/import-oura-json.js', 'await recordIngestion', 'Oura importer must await ingestion recording');
mustNot('scripts/import-oura-json.js', 'prior instanceof Promise', 'Oura importer must not special-case an un-awaited Promise');

if (existsSync(join(root, 'lib/drop-folder/reclassify-nightly.js'))) {
  failures.push('lib/drop-folder/reclassify-nightly.js: stale unwired reclassifier should be deleted');
}

if (failures.length) {
  console.error('[check-launch-data-stewardship] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[check-launch-data-stewardship] ok');
