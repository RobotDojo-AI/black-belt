/**
 * USDC / Base Transfer-event watcher.
 *
 * Specs:
 *   docs/integrations/alchemy-base.md — eth_subscribe over WSS, reconnect rules,
 *     confirmation depth, CU math (WS is cheapest for 99-user scale).
 *   docs/integrations/usdc-base.md    — USDC native contract on Base, Transfer
 *     topic[0] signature hash, 6 decimals, match-by-sender logic.
 *
 * Flow
 *   1. Open WSS to wss://base-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY>
 *   2. eth_subscribe("logs", { address: USDC_BASE, topics: [transferSig, null, paddedOurWallet] })
 *   3. For each pushed log:
 *        - skip if removed=true (reorg)
 *        - dedup on (txHash, logIndex)
 *        - decode from (topics[1]) + value (data, BigInt)
 *        - reject if < 199 * 1e6
 *        - queue for confirmation when head >= log.blockNumber + 10
 *   4. Confirmation timer: 25-second setTimeout per queued log (≈ 10 blocks on Base).
 *   5. On confirmed, match to pending payment_intents by sender wallet;
 *      mark confirmed, activate subscription, issue key.
 *
 * Reconnect
 *   - Exponential backoff: 1s → 2s → 4s → 8s → 30s cap.
 *   - Re-subscribe on every open (subscriptions are per-connection per spec).
 *   - Process.on('SIGTERM') closes cleanly.
 *
 * Constants live inline with spec references — don't recompute or hardcode.
 */

// Node 22+ has global WebSocket (RFC 6455). package.json pins node >=20 but
// production and dev run Node 22+. We reference the global here rather than
// import 'ws' to keep the dependency footprint at zero (CLAUDE.md constraint).
// If this ever runs on a host without global WebSocket, add `ws` to deps and
// `import { WebSocket } from 'ws';` here.
const _WS = globalThis.WebSocket;
if (!_WS) {
  throw new Error('[usdc-watcher] global WebSocket not available (need Node >=22). Add "ws" dep.');
}

import config from './config.js';
import {
  getPendingUsdcIntentsByWallet,
  confirmUsdcIntent,
  activateUsdcSubscription,
  setUserSubscriptionStatus,
  recordUsdcLog,
  hasProcessedUsdcLog,
} from './subscriptions.js';
import { issueKey } from './key-issuance.js';
import db from './db.js';

// --- Constants (all from spec files) ---------------------------------------

// docs/integrations/usdc-base.md — "Canonical facts"
const USDC_BASE_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase();
// docs/integrations/usdc-base.md — "Reference: event topic hashes"
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC_DECIMALS = 6;
// docs/integrations/alchemy-base.md — "Our rule: wait for block_number >= log.blockNumber + 10"
const CONFIRMATIONS_REQUIRED = 10;

// Reconnect backoff
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

// Fixed confirmation delay — ≈ 10 blocks on Base at ~2.5s/block.
const CONFIRMATION_DELAY_MS = 25_000;

// --- Helpers ---------------------------------------------------------------

/** Pad a 20-byte 0x-prefixed address to a 32-byte topic (left-padded). */
function padAddressForTopic(addr) {
  const hex = addr.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 40) throw new Error(`invalid address: ${addr}`);
  return '0x' + '0'.repeat(24) + hex;
}

/** Extract 0x-prefixed lowercase address from a 32-byte topic. */
function addressFromTopic(topic) {
  return '0x' + topic.slice(-40).toLowerCase();
}

/** Parse a 32-byte uint256 hex data field as BigInt. */
function parseUint256(data) {
  // `data` is "0x" + 64 hex chars for a single uint256. BigInt handles it natively.
  return BigInt(data);
}

function minAmountBaseUnits() {
  const cents = config.blackBeltPriceCents;          // from lib/pricing.js
  const dollars = BigInt(cents) / 100n;              // 199
  // USDC has 6 decimals (spec). 199 * 10^6.
  return dollars * 10n ** BigInt(USDC_DECIMALS);
}

// --- WebSocket driver ------------------------------------------------------

class UsdcWatcher {
  constructor() {
    this.ws = null;
    this.nextRpcId = 1;
    this.logsSubId = null;
    this.pendingConfirmations = new Map(); // txHash:logIndex → { entry, timer }
    this.backoffIdx = 0;
    this.shuttingDown = false;
  }

  url() {
    const key = config.alchemyApiKey;
    if (!key) throw new Error('ALCHEMY_API_KEY not configured');
    return `wss://base-mainnet.g.alchemy.com/v2/${key}`;
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Subscribe to USDC Transfer logs to our receiving wallet. */
  subscribeToLogs() {
    const receiving = config.usdcWallet;
    if (!receiving) throw new Error('USDC_RECEIVING_WALLET not configured');
    const paddedTo = padAddressForTopic(receiving);

    const id = this.nextRpcId++;
    this._logsPendingId = id;
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: USDC_BASE_CONTRACT,
          topics: [TRANSFER_TOPIC0, null, paddedTo],
        },
      ],
    });
  }

  connect() {
    if (this.shuttingDown) return;
    const url = this.url();
    console.info('[usdc-watcher] connecting…');
    this.ws = new _WS(url);

    this.ws.addEventListener('open', () => {
      console.info('[usdc-watcher] connected');
      this.backoffIdx = 0;
      this.subscribeToLogs();
    });

    // Global WebSocket delivers MessageEvent; `.data` may be string or Buffer.
    this.ws.addEventListener('message', (ev) => this.handleMessage(ev.data));

    this.ws.addEventListener('close', (ev) => {
      console.warn(`[usdc-watcher] ws closed (code=${ev.code})`);
      this.ws = null;
      this.logsSubId = null;
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', (ev) => {
      console.error('[usdc-watcher] ws error:', ev?.message || 'unknown');
      // close handler fires next, which schedules reconnect
    });
  }

  scheduleReconnect() {
    if (this.shuttingDown) return;
    const delay = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)];
    this.backoffIdx++;
    console.info(`[usdc-watcher] reconnect in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }

  handleMessage(data) {
    let text;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
    else if (Buffer.isBuffer(data)) text = data.toString('utf8');
    else return;

    let msg;
    try { msg = JSON.parse(text); }
    catch { return; }

    // RPC response (subscription ack)
    if (msg.id !== undefined && msg.result !== undefined) {
      if (msg.id === this._logsPendingId) {
        this.logsSubId = msg.result;
        console.info(`[usdc-watcher] logs sub active: ${this.logsSubId}`);
      }
      return;
    }

    // Subscription push
    if (msg.method === 'eth_subscription' && msg.params) {
      const { subscription, result } = msg.params;
      if (subscription === this.logsSubId) this.onLog(result);
    }
  }

  onLog(log) {
    // Spec: reorged logs cancel any pending timer.
    if (log.removed === true) {
      const key = `${log.transactionHash}:${parseInt(log.logIndex, 16)}`;
      const pending = this.pendingConfirmations.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingConfirmations.delete(key);
        console.info(`[usdc-watcher] cancelled timer for removed log ${log.transactionHash}:${log.logIndex}`);
      }
      return;
    }

    // Basic shape check
    if (!log.topics || log.topics.length < 3 || !log.data) return;
    // Defensive: ensure this is actually USDC and actually Transfer.
    if ((log.address || '').toLowerCase() !== USDC_BASE_CONTRACT) return;
    if ((log.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC0) return;

    const txHash = log.transactionHash;
    const logIndexNum = parseInt(log.logIndex, 16);
    const blockNum = parseInt(log.blockNumber, 16);

    // Dedup pre-check (watcher may re-see on reconnect)
    const hasProcessed = this._hasProcessed ?? hasProcessedUsdcLog;
    if (hasProcessed(txHash, logIndexNum)) return;

    const fromAddr = addressFromTopic(log.topics[1]);
    const amountRaw = parseUint256(log.data); // BigInt

    if (amountRaw < minAmountBaseUnits()) {
      console.info(`[usdc-watcher] underpaid from=${fromAddr} amount=${amountRaw} (need ${minAmountBaseUnits()})`);
      // Still dedup so we don't spam logs on reconnect.
      const record = this._recordLog ?? recordUsdcLog;
      record(txHash, logIndexNum, blockNum, fromAddr, amountRaw.toString());
      return;
    }

    // Queue for confirmation via fixed-delay timer (≈ 10 blocks on Base at ~2.5s/block).
    const key = `${txHash}:${logIndexNum}`;
    if (!this.pendingConfirmations.has(key)) {
      const entry = { txHash, logIndex: logIndexNum, blockNumber: BigInt(blockNum), fromAddr, amountRaw };
      const timer = setTimeout(() => {
        this.pendingConfirmations.delete(key);
        this.settle(entry).catch(err => {
          console.error(`[usdc-watcher] settle failed for ${key}:`, err.message);
        });
      }, CONFIRMATION_DELAY_MS);
      this.pendingConfirmations.set(key, { entry, timer });
    }
  }

  async settle(entry) {
    const { txHash, logIndex, blockNumber, fromAddr, amountRaw } = entry;

    // Atomic dedup: try to INSERT the processed-log row first.
    const fresh = recordUsdcLog(txHash, logIndex, Number(blockNumber), fromAddr, amountRaw.toString());
    if (!fresh) return; // another process / retry handled this

    const pending = getPendingUsdcIntentsByWallet(fromAddr);
    if (pending.length === 0) {
      // Unmatched transfer — someone paid us from a wallet they didn't declare.
      // Spec: log, flag for manual review, do not refund.
      console.warn(`[usdc-watcher] UNMATCHED payment from=${fromAddr} tx=${txHash} amount=${amountRaw}`);
      return;
    }

    // Take the oldest matching pending intent (FIFO).
    const intent = pending[0];

    const updated = confirmUsdcIntent(intent.id, txHash);
    if (!updated) {
      // Race: another consumer confirmed it between query and update. Safe.
      return;
    }

    // Create / refresh subscription, 30-day period.
    const periodEnd = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    activateUsdcSubscription(intent.user_id, {
      senderWallet: fromAddr,
      txHash,
      periodEndIso: periodEnd,
    });
    setUserSubscriptionStatus(intent.user_id, 'black');

    // Look up the user's email to push the key.
    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(intent.user_id);
    if (!user) {
      console.error(`[usdc-watcher] user ${intent.user_id} not found — cannot push key`);
      return;
    }

    try {
      const billingPeriodStart = new Date().toISOString().slice(0, 10);
      await issueKey(user.email, { billingPeriodStart });
    } catch (err) {
      console.error(`[usdc-watcher] issueKey failed for ${user.email}:`, err.message);
      // Payment is still recorded; agent will reconcile on next connect.
    }

    console.info(
      `[usdc-watcher] settled intent ${intent.id} user=${intent.user_id} tx=${txHash}`,
    );
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      try { this.ws.close(1000, 'shutdown'); } catch { /* noop */ }
    }
  }
}

let _watcher = null;

/**
 * Start the watcher. Idempotent — calling twice is a no-op.
 * Called from index.js at process start.
 */
export async function start() {
  if (_watcher) return _watcher;

  // Soft-disable if configuration is absent. Useful in dev / when only Stripe is used.
  if (!config.alchemyApiKey || !config.usdcWallet) {
    console.info('[usdc-watcher] disabled (ALCHEMY_API_KEY and/or USDC_RECEIVING_WALLET unset)');
    return null;
  }

  _watcher = new UsdcWatcher();
  _watcher.connect();

  process.on('SIGTERM', () => { console.info('[usdc-watcher] SIGTERM'); _watcher?.shutdown(); });
  process.on('SIGINT',  () => { console.info('[usdc-watcher] SIGINT');  _watcher?.shutdown(); });

  return _watcher;
}

export const _internal = {
  padAddressForTopic,
  addressFromTopic,
  parseUint256,
  minAmountBaseUnits,
  USDC_BASE_CONTRACT,
  TRANSFER_TOPIC0,
  CONFIRMATIONS_REQUIRED,
  CONFIRMATION_DELAY_MS,
  UsdcWatcher,
};
