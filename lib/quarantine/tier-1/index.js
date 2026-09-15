/**
 * tier-1/index.js — Haiku classifier.
 *
 * WHY Haiku: per Compute Tier Protocol, we go to Haiku ONLY when Tier 0 didn't
 * short-circuit. Haiku at strict tool-use mode costs ~$0.001/file. The schema
 * (with strict + enum on action) is Layer 1 of the two-layer enforcement;
 * the executor's allowlist is Layer 2.
 *
 * Tests inject a stub client to avoid live API calls.
 */

// INTELLIGENCE_TIER: extraction — a strict-schema Haiku classifier (per the
// module's own WHY comment); a closed structured decision, not prose.
export const INTELLIGENCE_TIER = 'extraction';

import { schema } from './llm-schema.js';
import { validateDecision } from '../schema.js';
import { buildIntentContext } from './intent-context.js';
import { llmCreate } from '../../llm-gateway.js';
import { modelFor } from '../../../model-lane.js';

const HAIKU_MODEL = modelFor('fast');
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are the smart-quarantine classifier for the Robot Dojo repo. \
Your job: decide where a misplaced file belongs and whether to fix the writer's path string in source. \
You MUST use the classify_misplaced_file tool. NEVER respond in plain text. \

Rules:
- action MUST be one of: fix-code, move-to-canonical, quarantine. No other values are allowed.
- destination MUST be either: a path matching a canonical-paths registry entry, a path under quarantine/, or a path under pipeline/archive/.
- If a canonical home is known (registry entry, header directive, or unambiguous codebase reference), prefer move-to-canonical.
- If a writer in source can be located AND patched safely, propose fix-code (the executor will run a verification cascade and revert on failure).
- If no canonical home is knowable, propose quarantine to a clear quarantine/<subdir>/ path.
- NEVER propose delete, gitignore, regenerate, merge, ignore, or any other action — those are not allowed.
- confidence: 0.85+ means auto-apply; 0.6–0.84 means surface to human; <0.6 means ambiguous.`;

/**
 * classifyWithHaiku — call Haiku with the tool schema and return a decision.
 *
 * Args:
 *   { absPath, relPath, signals, registry, repoRoot } — context for the prompt
 */
export async function classifyWithHaiku({ absPath, relPath, signals, registry, repoRoot } = {}) {
  const userPrompt = buildIntentContext({ absPath, relPath, signals, registry, repoRoot });

  const response = await llmCreate({
    model: HAIKU_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [schema],
    tool_choice: { type: 'tool', name: schema.name },
    messages: [{ role: 'user', content: userPrompt }],
  }, 'quarantine-classify');

  // Find the first tool_use block.
  const toolUse = (response.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) {
    throw new Error('Haiku did not return a tool_use block');
  }
  const decision = { ...toolUse.input, file: relPath || absPath };

  // Defense in depth: validate the decision shape before passing to the executor.
  const v = validateDecision(decision);
  if (!v.ok) {
    throw new Error(`Haiku returned invalid decision: ${v.error}`);
  }

  return { ...decision, tier: 1 };
}
