# Robot Dojo — Memory Log Spec (port of Miyagi V1)

Hash-chained append-only user memory. Mirrors the Miyagi V1 protocol at `~/.claude/projects/-Users-miyagi/memory/LOG_PROTOCOL.md`.

## Layout (per user)

```
~/robotdojo/user/memory/
├── log/                               (mode 0700)
│   └── YYYY-MM-DDTHH-MM-SSZ-<sha256_first_12>.md   (mode 0600)
└── projections/
    └── {topic}.md                     ← auto-generated projection, NOT authoritative
```

## File format

Identical to Miyagi. YAML frontmatter: `timestamp`, `type`, `name`, `description`, `prev_hash`, `author`, `source_class`, optional `status`, `session_id`, `tags`. Body below. Filename suffix = first 12 hex of `sha256(full bytes)`. First entry declares `prev_hash: genesis`; every subsequent entry's `prev_hash` = `sha256(previous file bytes)`.

`source_class` (Chunk 7A, `lib/provenance.js`) is derived from `author`, never caller-set: the literal author `owner` stamps `user-stated`; every other author stamps `llm-distilled` plus `status: provisional`. A pre-Chunk-7A entry has no `source_class` field and resolves the same way at read time from its `author`. This is what stops an agent's own generalization from surfacing as a settled owner rule in chat/identity context — see `lib/memory-context.js` and `lib/distill-sources/memory-log.js`.

## Integration points

Build in `lib/memory.js`:

- `appendMemory({ type, name, description, author, body, sessionId, tags }) -> { path, prevHash, selfHash }`
  Find latest log file, compute `prev_hash`, write tmp, hash, rename to content-addressed name, chmod 0600.
- `verifyChain() -> { ok: boolean, count, head, break? }`
  Walk log in filename-sort order; check `prev_hash` and filename suffix at each link.
- `getLogIndex() -> Array<{ name, type, description, timestamp, path }>`
  Parse frontmatter for each entry, return sorted desc by timestamp.

## Chat tool routing

The `update_context(topic, body)` chat tool currently overwrites `user/contexts/{topic}.md`. Change it to:

1. Call `appendMemory({ type: 'session-note', name: topic, description: '<first line>', author: 'chat', body })`.
2. Mark `user/contexts/{topic}.md` as stale so the maintenance projector regenerates it from the log.

## Backward compatibility

`user/contexts/{topic}.md` stays as the auto-generated projection — consumers (RAG, wiki) keep reading from it. The log is the source of truth; projection is regenerated on every append and daily via a maintenance projector job that reads the log and rewrites `user/contexts/*.md`.

## Privacy

V1: file mode 0600 under the user's home is sufficient. V2: consider storing log entries as rows in a SQLCipher DB keyed on user id, or rsync/encrypt the log directory. Decide once we have real users.

## Deferred

- Migration of existing `user/contexts/*.md` into the log (one-time batch).
- Signed entries (ed25519 per-user key) — useful when multiple agents write.
- Cross-user shared memory (intentionally not in scope).

## Out of scope for V1

- Server-side verification, cross-device sync, push notifications on chain break, GC of old entries. None of these change the on-disk file format, so we can add them without breaking the log.
