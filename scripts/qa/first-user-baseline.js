#!/usr/bin/env node
/**
 * first-user-baseline.js — the no-regression proof for the first-user
 * productization (st_e36f5f2b AC3).
 *
 * The productization replaced the hardcoded employer slug with a config-driven
 * read (lib/granola-client.js primaryWorkTopicSlugs) and genericized the second
 * work-account descriptor. The risk (failure manifest): productizing the routing
 * silently changes the owner's live Granola folder-membership resolution or Asana
 * destination routing. This harness captures the owner's routing DECISIONS to a
 * gitignored artifact and re-checks them after, so "no regression" is a
 * documented before/after match, not an eyeballed "looks fine".
 *
 * DETERMINISTIC (Tier 0): every captured decision is a pure function of the
 * routing config (config/*.json + the gitignored config/*.user.json overrides).
 * NO live DB, NO LLM, NO network — so --capture and --check are reproducible and
 * isolate the CODE behavior (what productization touched) from config drift by
 * pinning the inputs in the artifact and re-running the SAME inputs on --check.
 *
 *   --capture   record the current routing decisions to the baseline artifact.
 *   --check     re-run the pinned inputs and assert an exact match; exit 1 on any
 *               drift, printing the diff.
 *
 * Artifact: ~/.robotdojo/first-user-baseline.json (gitignored).
 * On a fresh clone with no owner override the input set is empty and the harness
 * is a trivial no-op — AC3 is an owner-box proof.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const ARTIFACT = join(homedir(), '.robotdojo', 'first-user-baseline.json');

const {
  loadAsanaRoutingConfig,
  primaryWorkTopicSlugs,
  destinationKeyForTopic,
  topicForEmailDomain,
} = await import(join(REPO_ROOT, 'lib', 'asana-routing-config.js'));
const { resolveDocSlugs, buildListMembership } = await import(join(REPO_ROOT, 'lib', 'granola-client.js'));
const { topicForSourceAccount, loadSourceTopicRoutingConfig } = await import(
  join(REPO_ROOT, 'lib', 'topic-source-routing.js')
);
const { INTEGRATIONS } = await import(join(REPO_ROOT, 'lib', 'integration-registry.js'));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The pinned input set, derived deterministically from the routing config so the
 * inputs are stable across --capture and --check (the config does not change
 * between them). Stored in the artifact so a later config edit cannot silently
 * move the goalposts — --check always re-runs the ORIGINAL captured inputs.
 */
function deriveInputs() {
  const asana = loadAsanaRoutingConfig();
  const primary = [...primaryWorkTopicSlugs(asana)].sort();

  // Topics to route: every configured destination key + a fixed generic control
  // set. destinationKeyForTopic is the Asana-routing decision the productization
  // could have moved.
  const topics = [
    ...new Set([
      ...Object.keys(asana.destinations || {}),
      ...Object.keys(asana.topicAliases || {}),
      'personal',
      'networking',
      'career',
      'unknown-topic-xyz',
    ]),
  ].sort();

  // Asana routed domains (owner professional graph) → topicForEmailDomain.
  const asanaDomains = Object.keys(asana.domains || {}).sort();

  // Source-topic routed domains (from the source-topic override) → source router.
  const srcCfg = loadSourceTopicRoutingConfig();
  const sourceDomains = Object.keys(srcCfg.domains || {}).sort();

  // Granola folder-membership precedence cases (the resolveDocSlugs behavior the
  // productization changed from a hardcoded slug to a config-driven set). Built
  // with the REAL primary-work slug so the "work wins" case exercises the owner's
  // actual routing; degrades to generic slugs on a fresh clone.
  const work = primary[0] || 'work';
  const docCases = {
    'work-plus-career': [work, 'career'],
    'work-plus-two': [work, 'career', 'health'],
    'lone-career': ['career'],
    'two-nonwork': ['career', 'health'],
    empty: [],
  };

  return { primary, topics, asanaDomains, sourceDomains, docCases };
}

/** Run every pinned input through the routing functions → the decision record. */
function computeDecisions(inputs) {
  const asana = loadAsanaRoutingConfig();
  const primarySet = primaryWorkTopicSlugs(asana);

  const destinationKeys = {};
  for (const t of inputs.topics) destinationKeys[t] = destinationKeyForTopic(t, asana);

  const asanaDomainRouting = {};
  for (const d of inputs.asanaDomains) {
    asanaDomainRouting[d] = topicForEmailDomain(`someone@${d}`, asana);
  }

  const sourceDomainRouting = {};
  for (const d of inputs.sourceDomains) {
    // A non-owner sender at the routed domain → the source router's topic.
    sourceDomainRouting[d] = topicForSourceAccount({ senderEmail: `person@${d}`, accountEmail: `owner@${d}` });
  }

  const docResolution = {};
  for (const [name, slugs] of Object.entries(inputs.docCases)) {
    const map = resolveDocSlugs(new Map([['d', new Set(slugs)]]), primarySet);
    docResolution[name] = map.get('d') ?? null;
  }

  // buildListMembership uses the config-driven default primary set — proves the
  // live fetch path resolves identically to the pure resolveDocSlugs path.
  const work = inputs.primary[0] || 'work';
  const listMembership = buildListMembership([
    { slug: work, ids: ['a'] },
    { slug: 'career', ids: ['a', 'b'] },
  ]);

  return {
    primary_work_slugs: [...primarySet].sort(),
    destination_keys: destinationKeys,
    asana_domain_routing: asanaDomainRouting,
    source_domain_routing: sourceDomainRouting,
    doc_slug_resolution: docResolution,
    list_membership: { a: listMembership.get('a') ?? null, b: listMembership.get('b') ?? null },
    integration_ids: INTEGRATIONS.map((d) => d.id).sort(),
  };
}

function capture() {
  const inputs = deriveInputs();
  const decisions = computeDecisions(inputs);
  const artifact = { captured_at: new Date().toISOString(), inputs, decisions };
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2));
  process.stdout.write(
    `first-user-baseline: captured ${Object.keys(decisions.destination_keys).length} destination decisions, ` +
      `${Object.keys(decisions.doc_slug_resolution).length} folder-precedence cases, ` +
      `${decisions.integration_ids.length} integrations → ${ARTIFACT}\n`
  );
  return 0;
}

function diffLines(expected, actual, path, out) {
  const ek = expected && typeof expected === 'object';
  const ak = actual && typeof actual === 'object';
  if (ek && ak && !Array.isArray(expected) && !Array.isArray(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) diffLines(expected[k], actual[k], `${path}.${k}`, out);
    return;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out.push(`  ${path}: baseline=${JSON.stringify(expected)} now=${JSON.stringify(actual)}`);
  }
}

function check() {
  const artifact = readJson(ARTIFACT);
  if (!artifact || !artifact.inputs || !artifact.decisions) {
    process.stderr.write(
      `first-user-baseline: no baseline at ${ARTIFACT} — run \`node scripts/qa/first-user-baseline.js --capture\` first.\n`
    );
    return 1;
  }
  // Re-run the ORIGINAL pinned inputs (not freshly-derived ones) so a config edit
  // cannot move the goalposts — this isolates code behavior.
  const now = computeDecisions(artifact.inputs);
  const diff = [];
  diffLines(artifact.decisions, now, 'decisions', diff);
  if (diff.length > 0) {
    process.stderr.write('first-user-baseline: REGRESSION — routing decisions changed vs the captured baseline:\n');
    for (const line of diff) process.stderr.write(`${line}\n`);
    return 1;
  }
  process.stdout.write(
    `first-user-baseline: no regression — ${Object.keys(now.destination_keys).length} destination decisions, ` +
      `${Object.keys(now.doc_slug_resolution).length} folder-precedence cases, and ${now.integration_ids.length} ` +
      `integrations reproduce the captured baseline exactly.\n`
  );
  return 0;
}

const arg = process.argv[2];
if (arg === '--capture') process.exit(capture());
if (arg === '--check') process.exit(check());
process.stderr.write('first-user-baseline: usage — --capture | --check\n');
process.exit(2);
