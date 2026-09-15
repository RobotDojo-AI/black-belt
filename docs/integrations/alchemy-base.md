# Alchemy (Base Mainnet RPC) Integration Spec

**Source docs:**
- https://www.alchemy.com/docs/reference/eth-getlogs
- https://www.alchemy.com/docs/reference/base-api-quickstart
- https://www.alchemy.com/docs/reference/api-overview
- https://www.alchemy.com/pricing
- https://docs.base.org/base-chain/quickstart/connecting-to-base (for Base chain facts)

**Fetched:** 2026-04-16
**For:** Robot Dojo — watch USDC Transfer events on Base mainnet for inbound payments to our receiving wallet. Confirm after N blocks, match to pending Stripe-alternative payment flow.

---

## Authentication

**API key embedded in the URL path.** No header auth.

- HTTPS: `https://base-mainnet.g.alchemy.com/v2/<API_KEY>`
- WSS: `wss://base-mainnet.g.alchemy.com/v2/<API_KEY>`
- Testnet: `https://base-sepolia.g.alchemy.com/v2/<API_KEY>` (and `wss://...`)

Store in Keychain: `ALCHEMY_BASE_API_KEY`. Rotate via the Alchemy dashboard (instant; no SDK redeploy needed if we inject at startup).

Optional: IP allowlist per app in the Alchemy dashboard for extra lockdown on the Fargate task's egress IP(s).

---

## Endpoints we use

All JSON-RPC 2.0 over HTTPS POST to the same URL. Every request:
```
POST https://base-mainnet.g.alchemy.com/v2/<API_KEY>
Content-Type: application/json
```

Body: `{ "jsonrpc": "2.0", "id": <int>, "method": "<method>", "params": [...] }`

### eth_getLogs — USDC transfer scan

**Purpose:** scan a block range for `Transfer(address,address,uint256)` events on the USDC contract, filtered by our receiving wallet as the `to` topic.

**Request body:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_getLogs",
  "params": [
    {
      "fromBlock": "0x...",
      "toBlock": "latest",
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "topics": [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        null,
        "0x000000000000000000000000<OUR_WALLET_NO_0x>"
      ]
    }
  ]
}
```

**Filter object fields:**
- `fromBlock` (hex string | `"latest"` | `"earliest"` | `"pending"` | `"safe"` | `"finalized"`)
- `toBlock` (same set)
- `address` (string | string[]) — contract(s) to match
- `topics` (array, max 4 entries)
  - Position 0: event signature hash
  - Position 1: first indexed param (`from` for Transfer)
  - Position 2: second indexed param (`to`)
  - Position 3: third indexed param (Transfer has only 2 indexed, so position 3 unused)
  - **`null` = wildcard** at that position
  - **Array at a position = OR** (e.g. `[hash1, hash2]` matches either)
  - **Positional across array = AND** (topic[0] AND topic[1] AND topic[2])
- `blockHash` — alternative to `from/toBlock` for a single block (mutually exclusive with the range).

**Transfer event signature hash** (keccak256 of `"Transfer(address,address,uint256)"`):
```
0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
```

**Indexed address encoding:** left-pad the 20-byte address with 12 zero bytes → 32-byte topic. Example: wallet `0xabcdef...1234` becomes `0x000000000000000000000000abcdef...1234`.

**Success response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": [
    {
      "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "topics": [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x000000000000000000000000<from_address_padded>",
        "0x000000000000000000000000<to_address_padded>"
      ],
      "data": "0x000000000000000000000000000000000000000000000000000000000bebc200",
      "blockNumber": "0x1234567",
      "blockHash": "0x...",
      "transactionHash": "0x...",
      "transactionIndex": "0x0",
      "logIndex": "0x3",
      "removed": false
    }
  ]
}
```

- `data` for Transfer contains the non-indexed `uint256 value` (the amount). Decode as a 32-byte big-endian integer. USDC has **6 decimals**, so `$199.00` = `199_000_000` = `0x0BEBC200`.
- `removed: true` means the log was unmounted by a chain reorg. **Ignore matches with `removed=true`**; re-scan.

**Error cases:**
- `-32602` Invalid params (malformed filter)
- `-32000` Server error / range too large
- `-32005` Limit exceeded (block range over free-tier cap)
- HTTP 429 — rate-limited (Alchemy throws 429 before RPC error for raw rate caps)

**Max block range on Alchemy (from docs, Ethereum; Base applies similar tiers):**
- Free tier: **10 blocks** per eth_getLogs call (explicitly documented for Ethereum; Base has historically been more generous — **verify empirically per environment**).
- Pay-as-you-go: unlimited per call (still subject to 150 MB response cap and CU cost).

**Our strategy:** scan in sliding 500-block windows (~17 minutes of Base blocks), bump via checkpoint in our DB. If free-tier limits bite, upgrade or reduce window.

### eth_blockNumber — latest block

**Purpose:** get the current head to compute confirmation depth.

```json
{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}
```
Response:
```json
{"jsonrpc":"2.0","id":1,"result":"0x1234567"}
```

### eth_getTransactionReceipt — final check

**Purpose:** once a Transfer log is seen, fetch the receipt to confirm the tx succeeded (`status == "0x1"`) and was included in a canonical block.

```json
{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x<txHash>"]}
```

Key response fields: `status` (`"0x1"` success, `"0x0"` revert), `blockNumber`, `logs[]`.

### eth_subscribe (WebSocket) — real-time

**Purpose:** skip polling, get push notifications of new logs matching our filter.

Connection: `wss://base-mainnet.g.alchemy.com/v2/<API_KEY>`

Subscribe message:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_subscribe",
  "params": [
    "logs",
    {
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "topics": [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        null,
        "0x000000000000000000000000<OUR_WALLET_NO_0x>"
      ]
    }
  ]
}
```

Returns a subscription ID. Subsequent push messages arrive as `eth_subscription` notifications with the same log object as `eth_getLogs` returns.

**For launch: poll with `eth_getLogs` every 2 seconds.** Simpler, resilient, within free-tier CU budget for 99 users. WebSocket is an optimization we revisit if we add many watch addresses.

---

## Confirmation depth for Base

- Base is an **OP-Stack optimistic rollup** with **2-second block times**.
- Sequencer produces "soft" (pre-finality) blocks near-instantly. L1 finality (challenge window) is ~7 days — **not what we wait for**.
- For economic security on L2-only assets like USDC on Base, **10–20 confirmations (~20–40 seconds)** is the common exchange practice. Coinbase currently uses around 200 confirmations for larger amounts; our $199 threshold is well below that.
- **Our rule: wait for `block_number >= log.blockNumber + 10`** before crediting a Black Belt subscription. ~20 seconds of delay, negligible UX cost, enough to survive any realistic sequencer-level reorg (extremely rare on Base; L2 reorgs are mostly theoretical absent a sequencer failure).

Adjust upward only if we ever see chain reorganizations that invalidate a credited payment; log `removed=true` events and backfill a monitor.

---

## Rate limits / compute units

- **Free tier: 30M CU/month, 500 CU/s throughput, ~25 rps.**
- Pay-as-you-go: no monthly cap, 10,000 CU/s (300 rps), $0.45/1M CU up to 300M then $0.40/1M.
- Enterprise: 1000+ rps, increased eth_getLogs ranges.

**CU costs (approximate, Alchemy's published table):**
- `eth_blockNumber`: 10 CU
- `eth_getLogs`: 75 CU (flat, does not scale with range — confirm for Base)
- `eth_getTransactionReceipt`: 15 CU
- `eth_subscribe` (logs): WS subscriptions billed as events delivered; ~50 CU per received log

**Our budget math:**
- Poll `eth_getLogs` every 2s → 43,200 calls/day → 3.24M CU/day → 97M CU/month.
- **Exceeds free tier (30M CU).** Options:
  - Poll every 6s instead (fine for 10-confirmation wait): 32M CU/month — still just over. Try every 10s: 19M CU/month (safe in free).
  - Upgrade to PAYG: ~$30/month for the 97M baseline. Acceptable.
  - Switch to `eth_subscribe`: only billed on matches → ~$0 at 99-user scale.
- **Launch plan: `eth_subscribe` over WebSocket.** Cheapest and real-time. Fall back to 10s polling if WS becomes unstable.

429 handling: exponential backoff 1s→30s, max 5 retries. Rotate to a secondary API key if one key is throttled.

---

## Pricing at our scale

- **Free tier:** 30M CU/month, enough if we use `eth_subscribe` (subscribe once, near-zero CU between matches).
- **Upgrade cost if we need it:** $49/mo (Growth plan) buys 400M CU/month and higher block-range limits.
- For 99 users receiving at most a few hundred payments/mo: **free tier is sufficient** with WS subscription.

---

## Gotchas / footguns

1. **Transfer topic ordering matters.** The signature hash goes in `topics[0]`, not anywhere else. Our filter is `[sig, null, paddedTo]` — positions 1 (from) and 2 (to) are the two indexed params in Solidity order.
2. **Left-pad indexed addresses to 32 bytes.** 20-byte addresses in topics → server accepts silently, returns zero matches. Must be 32-byte padded.
3. **Case-insensitive but checksum-sensitive elsewhere.** Topics match raw bytes; contract `address` field on Alchemy is returned lowercased. Normalize both sides to lowercase before comparing.
4. **`removed: true`** logs exist after reorgs. Always check and skip.
5. **`data` is hex big-endian uint256.** Parse with `BigInt('0x' + data.slice(2))`, divide by `10^6` for USDC units. Using `parseInt` silently overflows past ~9M USDC.
6. **Block range limit varies by chain and tier.** The eth_getLogs doc quotes "10 blocks" for Ethereum free; Base historically has been more permissive but **test before production** and chunk accordingly.
7. **`eth_subscribe` only works over WebSocket.** Don't call it via HTTP.
8. **Alchemy URL requires `/v2/` path prefix.** `https://base-mainnet.g.alchemy.com/<API_KEY>` without `/v2/` returns 404.
9. **WebSocket reconnect: re-subscribe on every reconnect.** Subscriptions are per-connection. Keep a local list of active subs and replay on `open`.
10. **Chain reorg depth on Base is typically 0** (sequencer-driven). The ~10-confirmation rule is belt-and-suspenders, not a response to observed reorgs.
11. **"latest" means sequencer tip.** For stronger guarantees, query against `"safe"` or `"finalized"` block tags — but these may be minutes behind on OP-stack chains. Ten confirmations of `"latest"` is our sweet spot.
12. **Matching payments to users:** the `from` address in the Transfer is the payer's wallet. Users tell us which wallet they'll send from when they click "Pay with USDC"; we record that and match by `(from, value≥199e6, to=ourWallet)`. If users pay from an exchange hot wallet, matching breaks — either require self-custody or pre-issue per-user receiving subaddresses (future work).

---

## What we DON'T use

- **Alchemy Enhanced APIs** (`alchemy_getAssetTransfers`, `alchemy_getTokenBalances`) — vendor lock-in and higher CU cost. Native `eth_getLogs` is portable to any RPC provider.
- **Alchemy Webhooks / Notify** — we run our own watcher. Revisit if we want to eliminate the persistent WS connection from Fargate.
- **Alchemy Account Abstraction / Gas Manager** — no meta-transactions at launch.
- **NFT APIs / Token APIs** — we only care about USDC Transfer events.
- **Alchemy SDK (`alchemy-sdk` npm package)** — we call JSON-RPC with `fetch` / native `ws` to stay provider-agnostic. Swapping to Infura/QuickNode should be a URL change.
- **Mempool / pending tx streams** — we only act on mined logs.
