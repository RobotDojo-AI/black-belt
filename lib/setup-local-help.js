/**
 * Setup help before cloud keys.
 *
 * First try local Ollama with the same FAQ/setup corpus that powers public
 * chat. If Ollama is not reachable, return a deterministic local answer from
 * the bundled FAQ context so a new user is never blocked on a cloud API key.
 */

import config from './config.js';
import { buildSystemPrompt, loadContext } from './public-chat/core.js';

// The installer pulls ONE local model by machine RAM (qwen2.5:7b at ≥16GB, else
// gemma3:4b) — see apps/static/install.sh. Setup help must use whichever was
// actually pulled, not a hard-coded model that may not be installed.
// st_fcdbe84f AC8 / WS5.
const INSTALLER_MODEL_PRIORITY = ['qwen2.5:7b', 'gemma3:4b'];
const LEGACY_FALLBACK_MODEL = 'llama3.2';

async function listInstalledOllamaModels(host) {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Pick the local model for setup help: an explicit override wins, then the
 * RAM-pulled installer models in priority order, then any installed model, then
 * the legacy default. Pure — unit-testable without Ollama. st_fcdbe84f AC8.
 */
export function selectSetupModel(installedModels = [], requestedModel = null) {
  const requested = String(requestedModel || process.env.OLLAMA_SETUP_MODEL || '').trim();
  if (requested) return requested;
  for (const model of INSTALLER_MODEL_PRIORITY) {
    if (installedModels.includes(model)) return model;
  }
  return installedModels[0] || LEGACY_FALLBACK_MODEL;
}

function staticAnswer(question) {
  const q = String(question || '').toLowerCase();
  const ctx = loadContext(q.includes('install') ? 'install-guide' : 'setup-guide');
  const compact = ctx.context
    .split('\n')
    .filter((line) => /^Q:|^A:/.test(line))
    .slice(0, 10)
    .join('\n')
    .slice(0, 1600);
  return [
    'I can help with setup locally before you add a cloud API key.',
    '',
    compact || 'Open Account Integrations, grant local permissions, connect Google if you want workspace context, then add a model key when you are ready.',
  ].join('\n');
}

function shouldUseStaticAnswer(question, answer) {
  const q = String(question || '').toLowerCase();
  const a = String(answer || '').trim();
  if (!a) return true;
  if (/not covered|not.*public docs|outside.*docs/i.test(a)) return true;
  const setupQuestion = /\b(setup|install|connect|data|integration|import|permission)\b/.test(q);
  return setupQuestion && !/\b(setup|install|connect|integration|import|permission|account)\b/i.test(a);
}

export async function answerSetupHelp({ question, context = 'setup-guide', model = null } = {}) {
  const host = config.ollamaHost || 'http://localhost:11434';
  const prompt = String(question || '').trim() || 'How do I finish Robot Dojo setup?';
  const system = buildSystemPrompt(loadContext(context));

  try {
    const selectedModel = selectSetupModel(await listInstalledOllamaModels(host), model);
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: selectedModel,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const body = await res.json();
    const answer = body?.message?.content || body?.response || '';
    if (shouldUseStaticAnswer(prompt, answer)) {
      return {
        ok: true,
        provider: 'local-faq',
        model: null,
        answer: staticAnswer(prompt),
        note: 'Local model did not return setup guidance. Showing bundled setup help instead.',
      };
    }
    return { ok: true, provider: 'ollama', model: selectedModel, answer };
  } catch (err) {
    return {
      ok: true,
      provider: 'local-faq',
      model: null,
      answer: staticAnswer(prompt),
      note: `Ollama was not reachable (${err.message}). Showing bundled setup help instead.`,
    };
  }
}
