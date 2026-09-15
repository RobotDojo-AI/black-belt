#!/usr/bin/env node
/**
 * Keychain migration: normalize all robotdojo-* entries to account "robotdojo".
 *
 * Background: keys were originally written under account "miyagi". A new Stripe key
 * added under account "robotdojo" created duplicates. This script migrates everything
 * to "robotdojo" so config.js secret() always finds the right entry.
 *
 * Also handles legacy miyagi-{NAME} service names: if no robotdojo- equivalent exists,
 * creates one under account "robotdojo", then deletes the old miyagi- entry.
 *
 * Run with --dry-run to preview without making changes.
 * Run with --skip-confirm to suppress interactive prompts (CI/automation).
 */

import { execSync } from 'child_process';
import { createInterface } from 'readline';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_CONFIRM = process.argv.includes('--skip-confirm');

// All known key names used in lib/config.js via secret()
const KNOWN_KEYS = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'GROK_API_KEY',
  'OLLAMA_HOST',
  'ROBOTDOJO_AUTH_TOKEN',
  'MIYAGI_AUTH_TOKEN',
  'SESSION_SECRET',
  'RESEND_API_KEY',
  'APP_BASE_URL',
  'USDC_RECEIVING_WALLET',
  'ALCHEMY_API_KEY',
  'ALCHEMY_BASE_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  'STRIPE_PUBLISHABLE_KEY',
  'GATEWAY_URL',
  'GATEWAY_INTERNAL_SECRET',
  'TUNNEL_JWT_SECRET',
  'MODULES_URL',
  'ROBOTDOJO_DEVICE_SLUG',
  'ROBOTDOJO_DEVICE_SECRET',
  'ROBOTDOJO_TUNNEL_URL',
  'GCS_BUCKET',
  'CLARITY_API_TOKEN',
  'OURA_PAT',
];

// Legacy miyagi-{NAME} entries to delete after migrating (service prefix, not account)
const LEGACY_MIYAGI_SERVICE_ENTRIES = [
  'miyagi-ROBOTDOJO_DEVICE_SECRET',
  'miyagi-ROBOTDOJO_DEVICE_SLUG',
];

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function readSecret(service, account) {
  const accountFlag = account ? `-a "${account}"` : '';
  return run(`security find-generic-password -s "${service}" ${accountFlag} -w 2>/dev/null`);
}

function writeSecret(service, account, value) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] would write: service="${service}" account="${account}"`);
    return true;
  }
  // -U: update if exists, add if not
  const result = run(
    `security add-generic-password -s "${service}" -a "${account}" -w ${shellQuote(value)} -U 2>/dev/null`
  );
  return result !== null || true; // add-generic-password returns empty string on success
}

function deleteSecret(service, account) {
  if (DRY_RUN) {
    const acctDesc = account ? ` account="${account}"` : '';
    console.log(`  [DRY RUN] would delete: service="${service}"${acctDesc}`);
    return true;
  }
  const accountFlag = account ? `-a "${account}"` : '';
  const result = run(`security delete-generic-password -s "${service}" ${accountFlag} 2>/dev/null`);
  return result !== null || true;
}

function shellQuote(val) {
  // Wrap value in single quotes, escape any single quotes within
  return `'${val.replace(/'/g, "'\\''")}'`;
}

async function confirm(msg) {
  if (SKIP_CONFIRM) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${msg} [y/N] `, ans => {
      rl.close();
      resolve(ans.toLowerCase() === 'y');
    });
  });
}

async function main() {
  console.log(`Keychain migration — ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}\n`);

  const actions = [];
  const skipped = [];
  const notFound = [];

  // Phase 1: migrate robotdojo-* entries stored under account "miyagi" → account "robotdojo"
  console.log('=== Phase 1: robotdojo-* services with account "miyagi" ===');
  for (const key of KNOWN_KEYS) {
    const service = `robotdojo-${key}`;
    const oldValue = readSecret(service, 'miyagi');
    if (oldValue === null) {
      // Not under miyagi account — check if it exists under robotdojo already
      const existingValue = readSecret(service, 'robotdojo');
      if (existingValue !== null) {
        console.log(`  SKIP  ${service} — already under account "robotdojo"`);
        skipped.push(service);
      } else {
        // Also try without account filter (catch entries with other accounts or no account)
        const anyValue = readSecret(service, null);
        if (anyValue !== null) {
          console.log(`  FOUND ${service} — stored under other account, migrating`);
          actions.push({ service, account: 'robotdojo', value: anyValue, deleteService: service, deleteAccount: null });
        } else {
          notFound.push(service);
        }
      }
      continue;
    }

    // Check if robotdojo account already has this key (from the duplicate situation)
    const existingRobotdojoValue = readSecret(service, 'robotdojo');
    if (existingRobotdojoValue !== null) {
      // Duplicate exists. The robotdojo-account entry is the new correct one.
      // Just need to delete the miyagi-account entry.
      console.log(`  DEDUP ${service} — robotdojo account exists, will delete miyagi duplicate`);
      actions.push({ service, account: 'robotdojo', value: existingRobotdojoValue, deleteService: service, deleteAccount: 'miyagi', skipWrite: true });
    } else {
      console.log(`  MIGRATE ${service} — miyagi → robotdojo`);
      actions.push({ service, account: 'robotdojo', value: oldValue, deleteService: service, deleteAccount: 'miyagi' });
    }
  }

  // Phase 2: migrate miyagi-{NAME} service entries → robotdojo-{NAME} under account "robotdojo"
  console.log('\n=== Phase 2: miyagi-* service prefix entries ===');
  for (const key of KNOWN_KEYS) {
    const miyagiService = `miyagi-${key}`;
    const robotdojoService = `robotdojo-${key}`;
    const miyagiValue = readSecret(miyagiService, null); // any account
    if (miyagiValue === null) continue;

    const robotdojoValue = readSecret(robotdojoService, null);
    if (robotdojoValue !== null) {
      // robotdojo version exists — just delete the legacy miyagi service entry
      console.log(`  CLEANUP miyagi-${key} → robotdojo-${key} already exists, will delete legacy`);
      actions.push({ service: null, account: null, value: null, deleteService: miyagiService, deleteAccount: null, skipWrite: true });
    } else {
      console.log(`  MIGRATE miyagi-${key} → robotdojo-${key} under account "robotdojo"`);
      actions.push({ service: robotdojoService, account: 'robotdojo', value: miyagiValue, deleteService: miyagiService, deleteAccount: null });
    }
  }

  // Phase 3: delete explicit legacy miyagi- service entries
  console.log('\n=== Phase 3: explicit legacy miyagi- service deletions ===');
  for (const service of LEGACY_MIYAGI_SERVICE_ENTRIES) {
    const val = readSecret(service, null);
    if (val !== null) {
      console.log(`  DELETE ${service} (robotdojo-* equivalent confirmed to exist)`);
      actions.push({ service: null, account: null, value: null, deleteService: service, deleteAccount: null, skipWrite: true });
    } else {
      console.log(`  SKIP   ${service} — not found (already gone)`);
    }
  }

  if (notFound.length > 0) {
    console.log(`\nNot found (no action needed): ${notFound.length} keys`);
    notFound.forEach(s => console.log(`  ${s}`));
  }

  if (actions.length === 0) {
    console.log('\nNothing to migrate. All keys already normalized.');
    return;
  }

  console.log(`\n${actions.length} action(s) queued.`);

  if (!DRY_RUN) {
    const ok = await confirm('\nProceed with migration?');
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  console.log('\nExecuting...');
  let succeeded = 0;
  let failed = 0;

  for (const action of actions) {
    // Write new entry
    if (!action.skipWrite && action.service && action.value) {
      const written = writeSecret(action.service, action.account, action.value);
      if (!DRY_RUN) {
        // Verify read-back
        const readback = readSecret(action.service, action.account);
        if (readback !== action.value) {
          console.error(`  FAIL  write+verify ${action.service} (${action.account})`);
          failed++;
          continue;
        }
        console.log(`  OK    wrote ${action.service} (${action.account})`);
      }
    }

    // Delete old entry
    if (action.deleteService) {
      const accountDesc = action.deleteAccount ? ` account="${action.deleteAccount}"` : '';
      if (!DRY_RUN) {
        deleteSecret(action.deleteService, action.deleteAccount || '');
        console.log(`  OK    deleted ${action.deleteService}${accountDesc}`);
      }
    }

    succeeded++;
  }

  console.log(`\nDone: ${succeeded} succeeded, ${failed} failed.`);

  if (!DRY_RUN && failed === 0) {
    // Verify the key that started all this
    const stripeCheck = readSecret('robotdojo-STRIPE_SECRET_KEY', 'miyagi');
    if (stripeCheck === null) {
      console.log('\nVerification: robotdojo-STRIPE_SECRET_KEY has no miyagi-account entry — migration clean.');
    } else {
      console.log('\nWARNING: robotdojo-STRIPE_SECRET_KEY still has a miyagi-account entry. Check manually.');
    }
  }
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
