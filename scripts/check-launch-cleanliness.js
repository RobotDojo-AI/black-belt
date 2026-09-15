#!/usr/bin/env node
/**
 * Launch cleanliness gate.
 *
 * Fails on unclassified stale product baggage. Allowed residue must stay
 * narrow and named here, so a broad grep hit cannot quietly pass as "known".
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROFILE = (process.argv.find((arg) => arg.startsWith('--profile=')) || '--profile=all').split('=')[1];

const PROFILES = {
  'stale-baggage': [
    'samurai',
    'fine-tuning',
    'faq-bot',
    'waitlist',
    'old-cta',
    'hidden-billing-link',
  ],
  'faq-truth': ['faq-bot', 'legacy-faq-json', 'fine-tuning', 'waitlist', 'samurai'],
  'model-visible': ['samurai', 'fine-tuning', 'waitlist', 'hidden-billing-link'],
  'public-chat-boundary': ['private-public-claim', 'legacy-faq-json'],
  'product-coherence': ['old-cta', 'samurai', 'fine-tuning', 'waitlist', 'hidden-billing-link'],
  'agent-facing': ['samurai', 'fine-tuning', 'faq-bot', 'waitlist'],
  'refactor-decisions': ['frontend-billing-remnant'],
};
PROFILES.all = [...new Set(Object.values(PROFILES).flat())];

const CHECKS = {
  samurai: /\bSamurai\b|\bsamurai\b/,
  'fine-tuning': /fine[- ]?tuning|finetun/i,
  'legacy-faq-route': /\/faq\b|robotdojo\.ai\/faq/i,
  'faq-bot': /FAQ bot|FAQ-bot|FAQ assistant/i,
  waitlist: /\bwaitlist\b/i,
  'old-cta': /Get Started Free/i,
  'hidden-billing-link': /account#billing/i,
  'legacy-faq-json': /apps\/static\/faq\/|FAQ assistant|fine[- ]?tuning|waitlist/i,
  'private-public-claim': /public chat (?:can|does) (?:see|access) (?:my|your) local data/i,
  'frontend-billing-remnant': /renderBilling|billingPollTimer|billingWallet|stripeCardMount|billingStripeCard|beltPaymentForm/i,
};

const PROFILE_SCOPES = {
  'model-visible': /^(lib\/chat|lib\/chat-tools|routes\/chat\.js|apps\/chat\/)/,
  'public-chat-boundary': /^(lib\/public-chat|routes\/public-chat\.js|api\/public-chat\.js|apps\/chat\/public-app\.js|apps\/static\/public-truth\.json|apps\/static\/llms)/,
  'agent-facing': /^(docs\/|architecture\/(?:sitemap|ontology)\.md|scripts\/generate-.*|config\/ontology\.json|config\/structure\.json)/,
  'product-coherence': /^(apps\/|architecture\/(?:product|architecture)\.md|README\.md|docs\/onboarding-flow\.md|docs\/faq-sync\.md)/,
  'faq-truth': /^(apps\/static\/faq|apps\/static\/faq-data\.json|apps\/static\/public-truth\.json|lib\/public-chat|scripts\/generate-public-truth\.js|docs\/faq-sync\.md|apps\/index\.html)/,
  'refactor-decisions': /^(apps\/account\/|apps\/chat\/)/,
};

const ALLOW = [
  { path: /^lib\/migrations\//, reason: 'historical migration residue' },
  { path: /^docs\/integrations\//, check: /hidden-billing-link|frontend-billing-remnant|old-cta|old-access-copy|faq-bot|legacy-faq-route/, reason: 'integration research doc' },
  { path: /^(routes\/billing|lib\/billing|lib\/stripe\.js|lib\/subscriptions\.js|lib\/usdc-watcher\.js|lib\/key-issuance\.js|lib\/bb-session\.js)/, check: /hidden-billing-link|frontend-billing-remnant|old-cta|old-access-copy|faq-bot|legacy-faq-route|waitlist/, reason: 'inert billing backend architecture' },
  { path: /^tests\/specs\/billing/, check: /hidden-billing-link|frontend-billing-remnant|old-cta|old-access-copy|faq-bot|legacy-faq-route|waitlist/, reason: 'billing backend tests' },
  { path: /^tests\/accounts-page-cleanup-lib\.test\.js$/, check: /hidden-billing-link|frontend-billing-remnant|old-cta|old-access-copy|faq-bot|legacy-faq-route|waitlist/, reason: 'billing backend tests' },
  { path: /^apps\/account\/subscription\.html$/, check: /hidden-billing-link|frontend-billing-remnant|old-cta|old-access-copy|faq-bot|legacy-faq-route|waitlist/, reason: 'retired subscription page outside launch nav' },
  { path: /^apps\/chat\/app\.js$/, check: /legacy-faq-route/, reason: 'generated setup-context compatibility path' },
  { path: /^(?:lib\/app-registry\.js|apps\/static\/shared\/app-registry\.js)$/, check: /legacy-faq-route/, reason: 'legacy URL alias route inventory' },
  { path: /^(?:apps\/static\/shared\/sw-register\.js|apps\/static\/sw\.js)$/, check: /legacy-faq-route/, reason: 'offline warmup route inventory' },
  { path: /^config\/app-inventory\.json$/, check: /legacy-faq-route/, reason: 'app route inventory compatibility path' },
  { path: /^config\/publication-permitted\.json$/, check: /legacy-faq-json/, reason: 'publication permitted-list entry naming the de-tax-regenerated FAQ context file that carries the public support address' },
  { path: /^scripts\/qa\/commit-posture-proof\.js$/, check: /legacy-faq-json/, reason: 'stages the de-tax-regenerated FAQ context file by name to prove the promoted address class does not fail every commit' },
  { path: /^docs\/faq-sync\.md$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'generated public-docs compatibility notes' },
  { path: /^lib\/server\.js$/, check: /legacy-faq-route/, reason: 'legacy URL redirect to /ask' },
  { path: /^scripts\/check-app-precache-contract\.js$/, check: /legacy-faq-route/, reason: 'precache route contract fixture' },
  { path: /^scripts\/check-literals\.js$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'literal gate allowlist docs' },
  { path: /^scripts\/gate-pii\.sh$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'generated public-docs compatibility allowlist' },
  { path: /^scripts\/pre-commit\.sh$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'generated public-docs compatibility build step' },
  { path: /^scripts\/detax\.sh$/, check: /legacy-faq-json/, reason: 'deterministic public-truth restaging contract' },
  { path: /^scripts\/gsc-poll\.js$/, check: /legacy-faq-route/, reason: 'legacy URL search-console remediation context' },
  { path: /^architecture\/sitemap\.md$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'generated inventory path' },
  { path: /^tests\/_public-truth-helpers\.js$/, reason: 'negative test pattern list' },
  { path: /^tests\/gsc-heal\.test\.js$/, check: /legacy-faq-route/, reason: 'legacy URL remediation test fixture' },
  { path: /^tests\/integrations-dashboard\.test\.js$/, check: /legacy-faq-json/, reason: 'reads apps/static/faq canonical-profile-seed fixture (live You-tab profile seed, also consumed by apps/account/app.js)' },
  { path: /^tests\/launch-tier-language\.test\.js$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'generated public-docs compatibility test' },
  { path: /^tests\/marketing-faq-truth\.test\.js$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'generated public-docs compatibility test' },
  { path: /^tests\/pre-commit-check-first\.test\.js$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'pre-commit compatibility test' },
  { path: /^tests\/public-ask-route\.test\.js$/, check: /legacy-faq-route/, reason: 'legacy URL redirect regression test' },
  { path: /^tests\/public-truth-consumers\.test\.js$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'generated public-docs compatibility test' },
  { path: /^tests\/public-truth\.test\.js$/, check: /legacy-faq-route|legacy-faq-json/, reason: 'generated public-docs compatibility test' },
  { path: /^tests\/detax-public-truth\.test\.js$/, check: /samurai|legacy-faq-json/, reason: 'deterministic public-truth restaging regression test' },
  { path: /^tests\/specs\/public-waitlist\.test\.js$/, check: /waitlist|samurai|legacy-faq-json/, reason: 'removed-route regression test' },
  { path: /^tests\/specs\/st_1c4baf8f\.test\.js$/, check: /samurai|waitlist|fine-tuning|legacy-faq-route|legacy-faq-json/, reason: 'removed-route regression test' },
  { path: /^scripts\/check-installer-self-serve\.js$/, reason: 'negative checker pattern list' },
  { path: /^scripts\/check-launch-cleanliness\.js$/, reason: 'negative checker pattern list' },
  { path: /^scripts\/qa\/launch-surface-smoke\.js$/, reason: 'negative browser assertion list' },
  { path: /^scripts\/qa\/tests\/frontend-workbench-routes\.spec\.js$/, check: /legacy-faq-route/, reason: 'legacy URL route regression test' },
  { path: /^scripts\/generate-public-truth\.js$/, reason: 'public-copy sanitizer pattern list' },
  { path: /^scripts\/qa\/tests\/marketing-cull\.spec\.js$/, reason: 'negative browser assertion list' },
  { path: /^vercel\.json$/, check: /fine-tuning|legacy-faq-route|legacy-faq-json/, reason: 'legacy URL redirect away from deleted page' },
  { path: /^apps\/static\/install\.sh$/, check: /legacy-faq-route/, reason: 'reserved slug safety list' },
  { path: /^lib\/reserved-slugs\.js$/, check: /legacy-faq-route/, reason: 'reserved slug safety list' },
];

function trackedFiles() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))];
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function allowed(path, check) {
  return ALLOW.find((entry) => entry.path.test(path) && (!entry.check || entry.check.test(check)));
}

function selectedChecks() {
  const keys = PROFILES[PROFILE];
  if (!keys) {
    console.error(`unknown profile: ${PROFILE}`);
    console.error(`profiles: ${Object.keys(PROFILES).sort().join(', ')}`);
    process.exit(2);
  }
  return keys;
}

const checks = selectedChecks();
const scope = PROFILE_SCOPES[PROFILE] || null;
const violations = [];
let classified = 0;
let scanned = 0;

for (const path of trackedFiles()) {
  if (scope && !scope.test(path)) continue;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  for (const key of checks) {
    const re = new RegExp(CHECKS[key].source, CHECKS[key].flags.includes('g') ? CHECKS[key].flags : `${CHECKS[key].flags}g`);
    for (const match of text.matchAll(re)) {
      const hit = match[0];
      const rule = allowed(path, key);
      if (rule) {
        classified += 1;
        continue;
      }
      violations.push({
        path,
        line: lineNumber(text, match.index || 0),
        check: key,
        hit,
      });
    }
  }
}

if (violations.length) {
  console.error(`launch cleanliness FAIL profile=${PROFILE} scanned=${scanned} classified=${classified} unclassified=${violations.length}`);
  for (const v of violations.slice(0, 80)) {
    console.error(`${v.path}:${v.line} [${v.check}] ${JSON.stringify(v.hit)}`);
  }
  if (violations.length > 80) console.error(`... ${violations.length - 80} more`);
  process.exit(1);
}

console.log(`launch cleanliness PASS profile=${PROFILE} scanned=${scanned} classified=${classified} unclassified=0`);
