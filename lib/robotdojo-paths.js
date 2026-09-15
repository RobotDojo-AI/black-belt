import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  ? resolve(process.env.ROBOTDOJO_REPO_ROOT)
  : resolve(__dirname, '..');

export const CONFIG_ROOT = process.env.ROBOTDOJO_CONFIG_ROOT
  ? resolve(process.env.ROBOTDOJO_CONFIG_ROOT)
  : join(homedir(), '.robotdojo');

export const ARCHITECTURE_ROOT = process.env.ROBOTDOJO_ARCHITECTURE_ROOT
  ? resolve(process.env.ROBOTDOJO_ARCHITECTURE_ROOT)
  : join(REPO_ROOT, 'architecture');

export const ARCHITECTURE_REL_ROOT = 'architecture';
export const ARCHITECTURE_PRODUCT_PATH = join(ARCHITECTURE_ROOT, 'product.md');
export const ARCHITECTURE_ARCHITECTURE_PATH = join(ARCHITECTURE_ROOT, 'architecture.md');
export const ARCHITECTURE_STRUCTURE_PATH = join(ARCHITECTURE_ROOT, 'structure.md');
export const ARCHITECTURE_SITEMAP_PATH = join(ARCHITECTURE_ROOT, 'sitemap.md');
export const ARCHITECTURE_ONTOLOGY_PATH = join(ARCHITECTURE_ROOT, 'ontology.md');
export const ARCHITECTURE_SURFACES_PATH = join(ARCHITECTURE_ROOT, 'surfaces.json');

export const AGENTS_ROOT = process.env.ROBOTDOJO_AGENTS_ROOT
  ? resolve(process.env.ROBOTDOJO_AGENTS_ROOT)
  : join(REPO_ROOT, 'agents');

export const AGENTS_REL_ROOT = 'agents';
export const AGENT_PERSONAS_DIR = join(AGENTS_ROOT, 'personas');
export const AGENT_SKILLS_DIR = join(AGENTS_ROOT, 'skills');
export const AGENT_DIST_DIR = join(AGENTS_ROOT, 'dist');
export const AGENTS_INDEX_PATH = join(AGENTS_ROOT, 'agents.md');
export const AGENT_ROSTER_PATH = AGENTS_INDEX_PATH;
export const AGENT_DEFAULT_QUALITY_PATH = join(AGENTS_ROOT, 'default-quality.md');
export const AGENT_BUILD_CONVENTIONS_PATH = join(AGENTS_ROOT, 'build-conventions.md');

export const USER_ROOT = process.env.ROBOTDOJO_USER_ROOT
  ? resolve(process.env.ROBOTDOJO_USER_ROOT)
  : join(REPO_ROOT, 'user');

export const USER_REL_ROOT = 'user';
export const USER_INBOX_REL = `${USER_REL_ROOT}/inbox`;
export const USER_IMPORTS_REL = `${USER_REL_ROOT}/imports`;
export const USER_FILES_REL = `${USER_REL_ROOT}/files`;
export const USER_CONTEXTS_REL = `${USER_REL_ROOT}/contexts`;
export const USER_WORKBENCHES_REL = `${USER_REL_ROOT}/workbenches`;
export const USER_TRANSCRIPTS_REL = `${USER_REL_ROOT}/transcripts`;
export const USER_MEMORY_REL = `${USER_REL_ROOT}/memory`;
export const USER_DATABASES_REL = `${USER_REL_ROOT}/databases`;
export const USER_LOGS_REL = `${USER_REL_ROOT}/logs`;
export const USER_MEDIA_REL = `${USER_REL_ROOT}/media`;
export const USER_MODELS_REL = `${USER_REL_ROOT}/models`;

export const USER_INBOX_DIR = process.env.ROBOTDOJO_DROP_ROOT
  ? resolve(process.env.ROBOTDOJO_DROP_ROOT)
  : join(USER_ROOT, 'inbox');
export const USER_IMPORTS_DIR = process.env.ROBOTDOJO_USER_IMPORTS_ROOT
  ? resolve(process.env.ROBOTDOJO_USER_IMPORTS_ROOT)
  : join(USER_ROOT, 'imports');
export const USER_FILES_DIR = process.env.ROBOTDOJO_FILES_ROOT
  ? resolve(process.env.ROBOTDOJO_FILES_ROOT)
  : join(USER_ROOT, 'files');
export const USER_CONTEXTS_DIR = join(USER_ROOT, 'contexts');
export const USER_WORKBENCHES_DIR = join(USER_ROOT, 'workbenches');

// wk_user/ — the per-user workbench vessel (st_0c491456 Phase 1).
//
// Identity injection target is `wk_user/context.md` (chat-budget dense
// distillation, ≤4000 chars). The deep IDE/agent companion lives at
// `wk_user/USER.md`. Owner voice samples live in `wk_user/user-voice/`. Raw
// imported substrate lands in `wk_user/substrate/` (rip-prompt importer).
//
// The wk_user/ tree is gitignored user PII — its budgets are enforced by
// runtime constants (USER_CARD_CHAR_BUDGET in lib/identity-card.js), not by
// architecture/surfaces.json. Do not add wk_user/* entries to surfaces.json.
export const WK_USER_DIR = join(USER_WORKBENCHES_DIR, 'user/wk_user');
export const WK_USER_CONTEXT_PATH = join(WK_USER_DIR, 'context.md');
export const WK_USER_DEEP_PATH = join(WK_USER_DIR, 'USER.md');
export const WK_USER_VOICE_DIR = join(WK_USER_DIR, 'user-voice');
export const WK_USER_SUBSTRATE_DIR = join(WK_USER_DIR, 'substrate');

// USER_PROFILE_PATH: deprecated alias kept as a redirect for any callers not
// yet migrated to WK_USER_DEEP_PATH. New code MUST import WK_USER_CONTEXT_PATH
// (chat-injected dense distillation) or WK_USER_DEEP_PATH (deep companion).
// Resolves to WK_USER_DEEP_PATH so a stale read returns the new long-form
// document instead of a missing file. Slated for removal once all callers
// are migrated.
export const USER_PROFILE_PATH = WK_USER_DEEP_PATH;
export const USER_TRANSCRIPTS_DIR = join(USER_ROOT, 'transcripts');
export const USER_MEMORY_DIR = process.env.ROBOTDOJO_MEMORY_DIR
  ? resolve(process.env.ROBOTDOJO_MEMORY_DIR)
  : join(USER_ROOT, 'memory');
export const USER_DATABASES_DIR = process.env.ROBOTDOJO_DATABASES_ROOT
  ? resolve(process.env.ROBOTDOJO_DATABASES_ROOT)
  : join(USER_ROOT, 'databases');
export const USER_LOGS_DIR = process.env.ROBOTDOJO_LOGS_ROOT
  ? resolve(process.env.ROBOTDOJO_LOGS_ROOT)
  : join(USER_ROOT, 'logs');
export const USER_MEDIA_DIR = process.env.ROBOTDOJO_MEDIA_ROOT
  ? resolve(process.env.ROBOTDOJO_MEDIA_ROOT)
  : join(USER_ROOT, 'media');
export const USER_MODELS_DIR = process.env.ROBOTDOJO_MODELS_ROOT
  ? resolve(process.env.ROBOTDOJO_MODELS_ROOT)
  : join(USER_ROOT, 'models');

export const PIPELINE_ROOT = process.env.ROBOTDOJO_PIPELINE_ROOT
  ? resolve(process.env.ROBOTDOJO_PIPELINE_ROOT)
  : join(USER_WORKBENCHES_DIR, 'topics/work/robot-dojo/wk_robot_dojo');

export const PIPELINE_STORIES_DIR = process.env.ROBOTDOJO_STORIES_DIR
  ? resolve(process.env.ROBOTDOJO_STORIES_DIR)
  : join(PIPELINE_ROOT, 'stories');

export const PIPELINE_KANBAN_PATH = process.env.ROBOTDOJO_KANBAN_PATH
  ? resolve(process.env.ROBOTDOJO_KANBAN_PATH)
  : join(PIPELINE_ROOT, 'kanban.md');

export const PIPELINE_SCHEMA_PATH = process.env.ROBOTDOJO_SCHEMA_PATH
  ? resolve(process.env.ROBOTDOJO_SCHEMA_PATH)
  : join(PIPELINE_ROOT, 'STORY_SCHEMA.json');

export const PIPELINE_FALLBACK_SCHEMA_PATH = join(REPO_ROOT, 'config/story-schema.json');

export const PIPELINE_INDEX_PATH = process.env.ROBOTDOJO_INDEX_PATH
  ? resolve(process.env.ROBOTDOJO_INDEX_PATH)
  : join(PIPELINE_ROOT, 'story-index.json');

// st_34daf3fd — semantic history-retrieval index (related-context.js).
//
// A JSON sidecar holding one embedding per story/defect/work record AND one per
// distilled memory-log entry, brute-force cosine-scanned at research/plan/build
// to ground each stage in relevant prior decisions and lessons. Lives under
// CONFIG_ROOT (~/.robotdojo/) because it is DERIVED user substrate: gitignored,
// beside embeddings.db, plaintext-allowed per the security model, and outside
// the repo tree so no repo root-lock / workbench-clean gate touches it. It lives
// under CONFIG_ROOT/state/ — an already-whitelisted dotdir entry (check-structure
// zone 4 whitelists top-level `~/.robotdojo/` entries via root-allowlist.lock.json;
// `state` is listed, so a derived sidecar under it needs no protected lock edit).
// Shared across worktrees by absolute path — the retriever never opens robotdojo.db,
// so the worktree+live-DB trap does not apply. Env override lets tests point at a
// temp file. The filename keeps `story-retrieval-index` even though it now also
// holds memory vectors — a filename is not worth a coordination cost.
export const PIPELINE_RETRIEVAL_INDEX_PATH = process.env.ROBOTDOJO_RETRIEVAL_INDEX_PATH
  ? resolve(process.env.ROBOTDOJO_RETRIEVAL_INDEX_PATH)
  : join(CONFIG_ROOT, 'state', 'story-retrieval-index.json');

export const PIPELINE_ACTIVE_BUILDS_PATH = process.env.ROBOTDOJO_ACTIVE_BUILDS_PATH
  ? resolve(process.env.ROBOTDOJO_ACTIVE_BUILDS_PATH)
  : join(PIPELINE_ROOT, 'active-builds.jsonl');

// st_8745309c — session-coordination registry.
//
// One JSON object keyed on Claude Code session_id, written atomically via
// tmp+rename, pruned of dead entries on every write. Lives under the pipeline
// root so all worktrees share the same absolute path — this is the desired
// behavior; the registry is the one intentionally cross-worktree surface.
//
// Override via ROBOTDOJO_SESSIONS_PATH for tests/fixtures. The override path
// is resolved against the current working directory (matching how the other
// PIPELINE_*_PATH overrides in this module behave).
export const PIPELINE_SESSIONS_PATH = process.env.ROBOTDOJO_SESSIONS_PATH
  ? resolve(process.env.ROBOTDOJO_SESSIONS_PATH)
  : join(PIPELINE_ROOT, 'sessions.json');

export function repoPath(...parts) {
  return join(REPO_ROOT, ...parts);
}

export function agentsPath(...parts) {
  return join(AGENTS_ROOT, ...parts);
}

export function architecturePath(...parts) {
  return join(ARCHITECTURE_ROOT, ...parts);
}

export function userPath(...parts) {
  return join(USER_ROOT, ...parts);
}
