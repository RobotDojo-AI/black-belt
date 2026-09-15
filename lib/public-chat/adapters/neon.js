/**
 * Neon HTTP adapter for public chat — replaces the Supabase PostgREST adapter.
 *
 * Same exported interface as supabase.js so callers need only change the import
 * and the config function name:
 *   supabaseConfig → neonConfig
 *   checkAndIncrementRate (same signature)
 *   logTranscript (same signature)
 *
 * Uses the Neon HTTP SQL API directly — no SDK, no cold-start overhead.
 */

import { DAILY_LIMIT } from '../core.js';

const NEON_HOST = 'ep-polished-math-a4p01zbw-pooler.us-east-1.aws.neon.tech';

/**
 * Read Neon config from an env-like object.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ connectionString: string } | null}
 */
export function neonConfig(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return null;
  return { connectionString };
}

async function neonQuery(cfg, query, params = []) {
  const res = await fetch(`https://${NEON_HOST}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': cfg.connectionString,
    },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`neon ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Atomic-ish rate check + increment for (ip_hash, date_utc).
 *
 * Reads current count; if at or over DAILY_LIMIT returns false. Otherwise
 * upserts with count+1. Returns true when the request is allowed.
 *
 * Under high concurrency a single IP could slip past by a handful of requests
 * — acceptable for a 50/day ceiling and avoids a Postgres function.
 */
export async function checkAndIncrementRate(cfg, ipHash, dayUtc) {
  const result = await neonQuery(
    cfg,
    `SELECT count FROM public_chat_rate WHERE ip_hash = $1 AND date_utc = $2 LIMIT 1`,
    [ipHash, dayUtc],
  );
  const current = result?.rows?.[0]?.count ?? 0;
  if (Number(current) >= DAILY_LIMIT) return false;

  await neonQuery(
    cfg,
    `INSERT INTO public_chat_rate (ip_hash, date_utc, count, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (ip_hash, date_utc)
     DO UPDATE SET count = $3, updated_at = NOW()`,
    [ipHash, dayUtc, Number(current) + 1],
  );
  return true;
}

/**
 * Upsert a transcript row keyed on (session_id, source). Matches the unique
 * index in the migration. Called twice per stream: once with the incoming
 * prompt (so nothing is lost on LLM error) and once with the final reply.
 */
export async function logTranscript(cfg, { sessionId, ipHash, userAgent, referrer, messages, source }) {
  await neonQuery(
    cfg,
    `INSERT INTO public_chats (session_id, ip_hash, user_agent, referrer, messages_json, source, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (session_id, source)
     DO UPDATE SET
       messages_json = EXCLUDED.messages_json,
       updated_at    = NOW()`,
    [
      sessionId,
      ipHash ?? null,
      userAgent ?? null,
      referrer ?? null,
      JSON.stringify(messages),
      source,
    ],
  );
}
