# Encryption, Credentials, and Belt Gating

Robot Dojo has two separate security tracks:

1. The local SQLite database is always encrypted at rest.
2. Black Belt entitlement controls premium engines and surfaces.

They are intentionally separate. A payment or beta key should never weaken local data protection, and a local DB key should never be treated as a subscription credential.

## Local DB Encryption

Every install uses the canonical database path:

```text
~/.robotdojo/robotdojo.db
```

The database key lives in macOS Keychain under:

```text
robotdojo-LOCAL_DB_KEY
```

The installer preserves an existing Keychain value. If the key is missing, first boot generates a fresh 32-byte key and writes it to Keychain. Tests and CI may set `ROBOTDOJO_LOCAL_DB_KEY`; production installs should use Keychain.

Hardened coding-agent hosts (Grok's Developer ID binary) cannot decrypt this Keychain item — `security -w` returns status 36. `com.robotdojo.keychain-bridge` is a login-session LaunchAgent that can, and `lib/keychain.js` falls back to it for `robotdojo-LOCAL_DB_KEY` only. Provider keys are not bridged.

`lib/db.js` opens the DB through `better-sqlite3-multiple-ciphers`, then `lib/db-encryption.js` applies SQLCipher pragmas before any query runs. If a legacy plaintext DB exists, boot migrates it into encrypted form and atomically replaces the original file.

## Credential Storage

Third-party API keys and local auth secrets live in macOS Keychain as `robotdojo-*` entries. The Account page is the user-facing manager:

- add or replace a key through a masked input
- delete a key
- see whether a key or OAuth account exists
- never reveal the raw secret back through the UI or API

OAuth tokens for Google and Microsoft also live in Keychain. Account rows make connected accounts visible, but the token material stays out of SQLite, logs, chat history, and LLM context.

## Tier Enforcement

Robot Dojo ships in two tiers with deliberately different enforcement mechanisms:

- **White Belt** is MIT, fully open source. Anyone can audit, fork, and run it on their own hardware. No subscription, no gate.
- **Black Belt** is source-available under the Elastic License v2 (ELv2). The code is public so users can audit it, but it runs only with an active subscription. Subscription state is checked server-side; the relay (remote access) is the hard gate that cannot be cracked client-side. Premium engines key-gate locally for convenience, but the relay is the binding control.

Inference runs on the user's own API keys at both tiers. The only thing on the operator's keys is the marketing-site FAQ chat (limited, marketing — not the product).

At launch, Black Belt is activated by issued or prepaid beta keys. Checkout is not part of the beta surface. Black Belt enables entity extraction, enrichment, inline entity recognition, coding-agent skills on topics, Health, premium apps, premium agent/tool runs, and relay access.

If Black Belt expires, premium engines pause and relay access ends. Raw data, chats, topics, topic logs and outputs, user-created files/apps, account settings, and existing entity markdowns remain local and read-only. Resubscribing re-animates active enrichment and entity-aware injection. Cancellation gives the user a 48-hour grace window; during that window the product should clearly explain that local data remains theirs, premium engines pause after grace, and reactivation restores active use.

## Operational Checks

```bash
# Confirm the DB key exists without printing it.
security find-generic-password -s robotdojo-LOCAL_DB_KEY >/dev/null

# Confirm the DB path.
test -f ~/.robotdojo/robotdojo.db

# Confirm plaintext sqlite cannot read the encrypted DB.
sqlite3 ~/.robotdojo/robotdojo.db 'select count(*) from sqlite_master'
# Expected: "file is not a database"
```

Do not paste Keychain values into chat, docs, tickets, logs, or test output.
