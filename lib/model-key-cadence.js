/**
 * In-process foundation-model key cadence.
 *
 * The LaunchAgent integration-monitor is an external DB writer. On the founder
 * Mac it is often unloaded, and when loaded it skips because the server holds
 * the writer lock. Without a stamp inside this process, idle-but-working API
 * keys go red after 60 minutes even though chat and /v1/models both work.
 *
 * This loop is the server-side 15-minute handshake: zero-cost /v1/models for
 * Anthropic, OpenAI, Google, and xAI, then recordLiveVerification on 200.
 * Never on the request path. Yields when chat is active.
 */
import { secret } from './config.js';
import db from './db.js';
import { probeApiKeyLive } from './api-key-probe.js';
import { recordLiveVerification } from './integration-status.js';
import { activityPauseDecision, getActivitySignal } from './request-observer.js';

const CADENCE_MS = Number(process.env.ROBOTDOJO_MODEL_KEY_CADENCE_MS || 15 * 60 * 1000);
const BOOT_DELAY_MS = Number(process.env.ROBOTDOJO_MODEL_KEY_CADENCE_BOOT_MS || 8_000);

function cadenceEnabled() {
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.ROBOTDOJO_MODEL_KEY_CADENCE === '0') return false;
  return true;
}

async function keyFor(provider) {
  if (provider === 'anthropic') return secret('ANTHROPIC_API_KEY');
  if (provider === 'openai') return secret('OPENAI_API_KEY');
  if (provider === 'google') return secret('GOOGLE_AI_API_KEY') || secret('GEMINI_API_KEY') || secret('GOOGLE_API_KEY');
  if (provider === 'xai') {
    try {
      const { resolveXaiApiKey } = await import('./xai-keys.js');
      return resolveXaiApiKey().key || secret('XAI_API_KEY') || secret('GROK_API_KEY');
    } catch {
      return secret('XAI_API_KEY') || secret('GROK_API_KEY');
    }
  }
  return null;
}

export async function handshakeFoundationKeys() {
  const providers = ['anthropic', 'openai', 'google', 'xai'];
  const stamped = [];
  for (const provider of providers) {
    const key = await keyFor(provider);
    if (!key) continue;
    const { status } = await probeApiKeyLive(provider, key, { timeoutMs: 8000 });
    if (status === 'valid') {
      recordLiveVerification(db, provider);
      stamped.push(provider);
    }
  }
  return stamped;
}

export function startModelKeyCadence() {
  if (!cadenceEnabled()) return { started: false };
  const tick = async (reason) => {
    if (activityPauseDecision(getActivitySignal(db))?.pause) return;
    try {
      const stamped = await handshakeFoundationKeys();
      if (stamped.length) {
        console.info(`[model-key-cadence] ${reason}: stamped ${stamped.join(',')}`);
      }
    } catch (err) {
      console.warn('[model-key-cadence] handshake failed:', err?.message || err);
    }
  };
  const boot = setTimeout(() => { tick('boot'); }, BOOT_DELAY_MS);
  boot.unref?.();
  const timer = setInterval(() => { tick('cadence'); }, CADENCE_MS);
  timer.unref?.();
  return { started: true, cadenceMs: CADENCE_MS };
}
