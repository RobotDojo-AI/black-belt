import config from './config.js';

export const SUPPORTED_BACKUP_CHOICES = Object.freeze([
  'gcp',
  'aws',
  'google_drive',
  'time_machine',
  'skip',
]);

const choiceSet = new Set(SUPPORTED_BACKUP_CHOICES);

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!provider) return null;
  if (provider === 'google' || provider === 'gcs' || provider === 'gcloud') return 'gcp';
  if (provider === 'drive') return 'google_drive';
  if (provider === 'timemachine') return 'time_machine';
  return choiceSet.has(provider) ? provider : null;
}

function configuredProvider(overrides) {
  const explicit = normalizeProvider(firstString(
    overrides.provider,
    process.env.ROBOTDOJO_BACKUP_PROVIDER,
    process.env.BACKUP_PROVIDER,
    config.backup?.provider,
    config.backupProvider,
  ));
  if (explicit) return explicit;
  return 'gcp';
}

const GUIDANCE = Object.freeze({
  gcp: {
    coverage: [
      'SQLite databases',
      'identity and configuration files',
      'memory, contexts, and durable product state',
    ],
    restore_limitations: [
      'Requires access to the configured GCP project and bucket.',
      'Does not replace a full-machine backup for OS keychain or app binaries.',
    ],
    instructions: [
      'Set GCS_BUCKET and GCP credentials.',
      'The Robot Dojo backup LaunchAgent will run the automated GCP backup path.',
    ],
  },
  aws: {
    coverage: [
      'Manual export target for Robot Dojo state.',
    ],
    restore_limitations: [
      'Automated AWS backup is not shipped yet.',
      'Use this as an explicit manual stewardship choice, not a background guarantee.',
    ],
    instructions: [
      'Create an encrypted S3 bucket.',
      'Export Robot Dojo state manually until automated AWS dispatch is added.',
    ],
  },
  google_drive: {
    coverage: [
      'Manual archive target for selected Robot Dojo exports.',
    ],
    restore_limitations: [
      'Google Drive sync is not an automated database backup path.',
      'Large or frequently changing SQLite files can restore inconsistently if copied live.',
    ],
    instructions: [
      'Create a private Drive folder for Robot Dojo exports.',
      'Run manual exports before major machine changes.',
    ],
  },
  time_machine: {
    coverage: [
      'Local macOS filesystem history for the Robot Dojo folder.',
    ],
    restore_limitations: [
      'Only protects data included by Time Machine on this Mac.',
      'Does not provide off-machine recovery if the Mac and backup disk are both unavailable.',
    ],
    instructions: [
      'Enable Time Machine for this Mac.',
      'Confirm the Robot Dojo folder is not excluded from backups.',
    ],
  },
  skip: {
    coverage: [],
    restore_limitations: [
      'No Robot Dojo backup path is active.',
      'Data recovery depends on source systems and manual exports.',
    ],
    instructions: [
      'Choose a backup provider when you want Robot Dojo to steward product-state recovery.',
    ],
  },
});

export function getBackupOptions(overrides = {}) {
  const selectedProvider = configuredProvider(overrides);
  const skipped = selectedProvider === 'skip' || truthy(overrides.skipped) || truthy(process.env.ROBOTDOJO_BACKUP_SKIP);
  const provider = skipped ? 'skip' : selectedProvider;
  const gcsBucket = firstString(overrides.gcsBucket, process.env.GCS_BUCKET, config.gcsBucket);
  const configured = !skipped && provider === 'gcp' && !!gcsBucket;
  const lastSuccess = firstString(
    overrides.last_success,
    overrides.lastSuccess,
    process.env.ROBOTDOJO_BACKUP_LAST_SUCCESS,
    config.backup?.last_success,
    config.backup?.lastSuccess,
  );
  const lastError = firstString(
    overrides.last_error,
    overrides.lastError,
    process.env.ROBOTDOJO_BACKUP_LAST_ERROR,
    config.backup?.last_error,
    config.backup?.lastError,
  );
  const guidance = GUIDANCE[provider] || GUIDANCE.skip;

  return {
    provider,
    configured,
    skipped,
    last_success: lastSuccess,
    last_error: lastError,
    coverage: guidance.coverage,
    restore_limitations: guidance.restore_limitations,
    instructions: guidance.instructions,
  };
}
