/**
 * Web Crypto SHA-256 — works in both Edge and Node runtimes.
 *
 * Both environments expose `globalThis.crypto.subtle` (Node since v16,
 * Edge natively). Using the Web API means the public-chat core never has
 * to branch on runtime and there's exactly one IP-hashing implementation.
 *
 * The raw IP never leaves this function. The returned hex digest is what
 * gets stored in `public_chat_rate` / `public_chats.ip_hash`.
 */

/**
 * SHA-256 the given IP (or the string `'unknown'` if empty) and return a
 * lowercase hex digest.
 *
 * @param {string | null | undefined} ip
 * @returns {Promise<string>} 64-char hex digest
 */
export async function hashIp(ip) {
  const data = new TextEncoder().encode(String(ip || 'unknown'));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  // Buffer isn't available in Edge; do the hex conversion manually.
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
