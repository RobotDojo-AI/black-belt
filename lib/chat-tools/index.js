/**
 * Chat-as-IDE: Tool registry with belt gating.
 *
 * White Belt tools live in lib/chat-tools/white/*.js. Black Belt tools live
 * in lib/chat-tools/black/*.js and are runtime-gated by cohort entitlement.
 *
 * Belt ordering: white < black. Black includes White tools.
 */
import db from '../db.js';
import config from '../config.js';
import { getLoadedBelt, getLoadedTools } from '../module-loader.js';
import { TOOLS, defineTool, slugify, ok, err } from './registry.js';

// Re-export helpers so tool files and existing callers keep working.
export { defineTool, slugify, ok, err };

// ─── White tool imports (explicit, no glob — no bundler) ───
//
// Each import triggers a defineTool() call against the shared registry.
import './white/list-topics.js';
import './white/create-topic.js';
import './white/update-topic.js';
import './white/delete-topic.js';
import './white/get-preferences.js';
import './white/set-preference.js';
import './white/update-profile.js';
import './white/update-soul.js';
import './white/update-context.js';
import './white/save-snapshot.js';
import './white/add-fact.js';
import './white/search-memory.js';
import './white/search-people.js';
import './white/add-person.js';
import './white/update-person.js';
import './white/set-relation-tag.js';
import './white/set-owner-identity.js';
import './white/log-metric.js';
import './white/log-medication.js';
import './white/log-health-note.js';
import './white/get-health-summary.js';
import './white/list-integrations.js';
import './white/run-import.js';
// Identity log — per-card read / append-with-supersede / history.
// Powers the chat-as-config experience for the 5 timeless cards + any
// custom cards the user creates. Replaces the old update-soul / update-profile
// flow for identity editing (those tools still exist for back-compat).
import './white/read-identity-section.js';
import './white/update-identity-section.js';
import './white/section-history.js';
import './white/list-export-targets.js';
import './white/set-export-target.js';
import './white/run-identity-export.js';
import './white/distill-identity.js';
import './white/rename-device.js';
import './white/get-device-name.js';
import './white/confirm-device-name.js';
// Account preferences / lifecycle — parity with /apps/account UI.
// See routes/account-prefs.js + routes/admin.js for the HTTP twins; each tool
// calls the same DAL (lib/account-prefs.js, lib/account-deletion.js,
// lib/key-issuance.js) directly — no HTTP self-calls.
import './white/set-release-channel.js';
import './white/check-for-updates.js';
import './white/set-beta-opt-in.js';
import './white/list-beta-opt-ins.js';
import './white/set-telemetry.js';
import './white/get-telemetry.js';
import './white/submit-feature-request.js';
import './white/list-my-feature-requests.js';
import './white/delete-my-data.js';
import './white/delete-my-account.js';
import './white/list-voices.js';
import './white/apply-voice.js';
import './white/enrich-from-linkedin.js';

// ─── Black Belt tool imports ───
// BB tools are normal source files. The runtime gate is `isBBActive()` at
// the route boundary; tools are present in code, never executed without
// cohort entitlement.
import './black/create-google-doc.js';
import './black/create-google-sheet.js';
import './black/create-google-slides.js';
import './black/extract_entities.js';
import './black/query_network.js';
import './black/query_family.js';
import './black/merge_people.js';
import './black/generate_context.js';
import './black/review-digest.js';

// ═══════════════════════════════════════════════════════════════════
// Belt-aware registry
// ═══════════════════════════════════════════════════════════════════

const BELT_RANK = { white: 0, demo: 0, black: 1 };

function resolveBelt(explicit) {
  const b = explicit ?? getLoadedBelt();
  return BELT_RANK[b] != null ? b : 'white';
}

function toolAvailable(toolBelt, activeBelt) {
  return BELT_RANK[activeBelt] >= (BELT_RANK[toolBelt] ?? 0);
}

/**
 * Build the merged tool table: registered tools plus legacy module-loader
 * tools, if any. Loaded module tools win on name conflict.
 */
function mergedTools() {
  const merged = { ...TOOLS };
  for (const t of getLoadedTools()) {
    if (!t || !t.schema?.name) continue;
    merged[t.schema.name] = {
      belt: t.belt || 'black',
      schema: t.schema,
      execute: t.execute,
    };
  }
  return merged;
}

/**
 * Services injected into every tool's ctx. Most tools close over direct
 * imports, but ctx.services preserves the legacy execution contract.
 */
const SERVICES = { db, config };

/**
 * Get tool schemas for the active belt. No args ⇒ read from module loader.
 */
export function getToolSchemas(belt) {
  const active = resolveBelt(belt);
  return Object.values(mergedTools())
    .filter(t => toolAvailable(t.belt, active))
    .map(t => t.schema);
}

/**
 * Execute a tool by name. Belt defaults to module-loader state.
 *
 * Accepts either a belt string (legacy) or a context object with `belt`
 * and optional fields like `sessionId`. The context object is forwarded as
 * the second argument to the tool's `execute(args, ctx)` function so tools
 * can read auth context without reaching for globals.
 */
export async function executeTool(name, args, beltOrCtx) {
  const ctx = typeof beltOrCtx === 'string' || beltOrCtx == null
    ? { belt: beltOrCtx }
    : { ...beltOrCtx };
  ctx.services = { ...SERVICES, ...(ctx.services || {}) };
  const active = resolveBelt(ctx.belt);
  const table = mergedTools();
  const tool = table[name];
  if (!tool) return err(`Unknown tool: ${name}`);
  if (!toolAvailable(tool.belt, active)) {
    return err(`${name} is a ${tool.belt} belt feature. Upgrade to access it.`);
  }

  try {
    return await tool.execute(args, ctx);
  } catch (e) {
    console.error(`[chat-tools] ${name} failed:`, e.message);
    return err(`Tool execution failed: ${e.message}`);
  }
}

/**
 * Count tools available at the given belt. Defaults to module-loader state.
 */
export function getToolCount(belt) {
  const active = resolveBelt(belt);
  return Object.values(mergedTools()).filter(t => toolAvailable(t.belt, active)).length;
}
