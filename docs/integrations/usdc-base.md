# USDC on Base Integration Spec

**Source docs:**
- https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (contract confirmation)
- https://developers.circle.com/stablecoins/usdc-contract-addresses (contract registry)
- https://www.circle.com/blog/bridged-usdc-standard (native vs bridged distinction)
- https://docs.base.org/base-chain/quickstart/connecting-to-base (Base chain facts)
- ERC-20 standard (EIP-20) and ERC-20 Transfer event signature

**Fetched:** 2026-04-16
**For:** Robot Dojo — parse ERC-20 `Transfer` events on the USDC/Base contract where `to == OUR_WALLET` and `value >= 199 * 10^6`. Match to pending payments by sender wallet.

---

## Canonical facts

| Field | Value |
|---|---|
| Token name | USD Coin |
| Symbol | USDC |
| Decimals | **6** |
| Standard | ERC-20 (EIP-20) |
| Issuer | Circle |
| Network | Base mainnet (chain ID 8453) |
| **Native USDC contract on Base** | **`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`** |
| Native USDC contract on Base Sepolia (testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Native USDC on Ethereum mainnet | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (cross-reference only) |
| Contract architecture | Proxy pattern — proxy at the above address, implementation at `0x2Ce6311ddAe708829bc0784C967b7d77D19FD779` (subject to upgrade by Circle) |
| Supports | `EIP-2612` permit (gasless approve), standard `transfer` / `transferFrom` |

**Always reference the proxy address** (`0x833589...2913`) — the implementation can be upgraded by Circle and the proxy address stays stable. Callers never need to know the impl.

### Native vs bridged USDC on Base

- `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` is **native USDC**, issued directly by Circle on Base. Backed 1:1 by USD reserves. Eligible for CCTP (Cross-Chain Transfer Protocol).
- `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` (symbol **USDbC**) is the **bridged** version — the legacy "USD Base Coin" that predates native USDC on Base. It's a wrapped representation of Ethereum USDC locked in the canonical bridge. **We DO NOT accept USDbC.**
- Circle explicitly warns that bridged variants "can result in a fragmented user experience" and "are not compatible with CCTP."

**Launch-day check:** during payment flow, reject incoming transfers to our wallet if `log.address` is not exactly `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (lowercased). USDbC transfers are ignored.

---

## ERC-20 Transfer event — exact structure

**Solidity declaration** (from EIP-20):
```solidity
event Transfer(address indexed from, address indexed to, uint256 value);
```

**Event signature string:** `Transfer(address,address,uint256)` (no spaces, types only)

**Signature hash (topic[0]):** keccak256 of the signature string →
```
0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
```
This is the same hash for every ERC-20 transfer, on every chain. Hardcode it as a constant.

### Topic layout

| Index | Content | Encoding |
|---|---|---|
| `topics[0]` | Event signature hash | 32 bytes (hex) |
| `topics[1]` | `from` (indexed) | 32 bytes — left-pad the 20-byte address with 12 zero bytes |
| `topics[2]` | `to` (indexed) | 32 bytes — same encoding |
| `topics[3]` | (not present) | Transfer has only 2 indexed params |

### Data (non-indexed params)

`data` is the ABI-encoded concatenation of non-indexed parameters. For Transfer, that's just `value` — one `uint256`, 32 bytes.

**Decoding:**
```js
const valueRaw = BigInt('0x' + log.data.slice(2)); // strip "0x", parse as BigInt
const valueUsdc = Number(valueRaw) / 1_000_000;    // 6 decimals
// OR keep as BigInt for precise comparison:
const minAmount = 199n * 1_000_000n; // 199,000,000
if (valueRaw >= minAmount) { /* payment meets threshold */ }
```

**Never use `parseInt` or `Number()` on the raw hex.** USDC amounts above ~$9M overflow JS `Number` (max safe int is 2^53-1). Use `BigInt` everywhere.

### Decoding addresses from padded topics

```js
// topics[1] or topics[2] is "0x" + 24 hex zeros + 40 hex chars (address body)
const fromAddress = '0x' + log.topics[1].slice(-40); // always lowercase
const toAddress   = '0x' + log.topics[2].slice(-40);
```

Lowercase everywhere internally. Convert to EIP-55 checksum only for display.

---

## Matching an incoming payment

Algorithm:
1. Subscribe to logs where `address = 0x833589...2913`, `topics[0] = transferSig`, `topics[2] = leftPad(OUR_WALLET)`.
2. For each received log (after confirmation depth):
   - Reject if `log.removed === true` (reorg).
   - Decode `value` from `data` → must be `>= 199_000_000n` BigInt (or the exact subscription price in USDC base units).
   - Decode `from` from `topics[1]`.
3. Look up pending payment by `from` address in our DB (user declared their payer wallet when starting checkout).
4. If match found and confirmation count ≥ 10 blocks (~20 seconds):
   - Mark payment `confirmed`, tx hash = `log.transactionHash`.
   - Trigger Black Belt entitlement via tunnel gateway.
5. If no match found: log as unmatched transfer, flag for manual review, **do not refund automatically**.

**Edge cases:**
- User sends exactly $199.00 → match.
- User sends more (e.g. $200.00 to cover gas mental-model error) → accept as valid payment, credit the month. Do not auto-refund the delta; optionally credit against next cycle.
- User sends less → reject; surface "insufficient payment, please send the remaining $X" in chat. Do not auto-return funds.
- User sends from an exchange hot wallet (Coinbase, Binance) → `from` is the exchange's wallet, not the user's. Matching fails. **Launch mitigation:** UI warning "send from a self-custodial wallet (MetaMask, Rainbow, Coinbase Wallet)." Long-term: issue per-user receiving subaddresses.

---

## Confirmation depth

See `alchemy-base.md` — we wait for **10 confirmations on Base** (~20 seconds) before crediting. Belt-and-suspenders; sequencer-driven L2 reorgs are vanishingly rare in practice.

---

## What we DON'T do

- **We do not call USDC's `transfer` / `transferFrom` ourselves.** The user sends to us; we only observe.
- **We do not use `approve` + `transferFrom`.** That would require the user to pre-approve our contract — unnecessary for one-shot subscriptions.
- **We do not use EIP-2612 `permit` signatures.** Future possibility for gasless onboarding; out of scope for launch.
- **We do not use Circle CCTP.** CCTP is for cross-chain USDC burns/mints; we stay on Base.
- **We do not support USDC on other chains at launch.** Ethereum mainnet gas is too high for $199, Polygon/Arbitrum add confusion. Base-only.
- **We do not support USDbC (bridged USDC on Base).** Reject anything not from `0x833589...2913`.
- **We do not accept ETH or other tokens.** Only native USDC on Base.

---

## Gotchas / footguns

1. **Address case sensitivity.** Compare lowercase to lowercase. A checksum-cased wallet address in a config file vs lowercase from Alchemy will silently fail to match.
2. **BigInt everywhere.** USDC uses 6 decimals but amounts are stored as `uint256`. Never cast to JS `Number` for comparison.
3. **Event signature is chain-agnostic.** Don't try to look it up per chain — the hash is constant.
4. **USDC proxy upgrades.** Circle has upgraded the implementation before. Our code doesn't touch the impl; we only read events from the proxy. No action needed unless the proxy address itself changes (it won't).
5. **Decimals are 6, not 18.** ETH and most ERC-20s use 18 decimals. Hardcoding `10^18` will make every payment look 10^12x larger. Use `10^6`.
6. **`from` in the event is the msg.sender of `transfer()`**. If a user uses a smart-contract wallet (Safe, ERC-4337) the `from` will be the smart wallet address, not the EOA. Our match-by-declared-wallet logic handles this if the user declares the smart-wallet address; otherwise it fails.
7. **Zero-value transfers emit Transfer events.** Some tokens do; USDC also permits transfer(0). Always check `value >= threshold`, never `value > 0`.
8. **Null `to` address (`0x0...0`)** = mint from Circle's treasury. We will never be `to=0x0`; ignore as belt-and-suspenders.
9. **USDC contract is pausable.** Circle can pause all transfers in emergency. Monitor Circle's public status page; if USDC is paused, fall back to Stripe-only payments in the UI.
10. **Checksum address display.** When showing the receiving wallet to users in chat, render EIP-55 checksum format (capitalized) to help users eyeball-verify. Match internally on lowercase.

---

## Reference: event topic hashes we need

```
Transfer(address,address,uint256)
  → 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef

Approval(address,address,uint256)            // we do NOT watch
  → 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925
```

## Reference: contract addresses

```
USDC (native) on Base mainnet:        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC (native) on Base Sepolia:        0x036CbD53842c5426634e7929541eC2318f3dCF7e
USDbC (bridged, DO NOT ACCEPT):       0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA
USDC on Ethereum mainnet (reference): 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```

Store these as named constants in `lib/usdc.js`. Never hardcode inline.
