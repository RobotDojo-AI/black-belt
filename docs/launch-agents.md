# Background LaunchAgents

Packaged product LaunchAgents are declared in `config/launch-agents.json` and templated from `apps/static/launch-agents/`. Installed plists live at `~/Library/LaunchAgents/com.robotdojo.*.plist`.

The broader maintenance contract lives in `docs/background-routines.md` and `config/background-routines.json`. LaunchAgents are one worker type inside that system, not the whole system.

## Backup Owner

`com.robotdojo.backup` is the only backup owner.

- Schedule: daily at 02:30 local time.
- Entrypoint: `scripts/backup-dispatcher.js --strict --force-scheduled`.
- Destination: configured backup provider; the bucket name is operator-specific and is read at runtime from the gitignored `config/backup-buckets.user.json`.
- Logs: `~/.robotdojo/logs/robotdojo-backup.{out,err}.log`.
- Restore proof: `scripts/verify-gcp-backup-restore.js` downloads real objects and compares sha256 bytes. This is a live QA check, not an offline structure gate, because it requires configured GCP credentials and a recent backup.
- Coverage proof: `scripts/check-backup-recoverability.js` rejects ignored files unless they are GCP-backed or explicitly regenerable.
- CPU policy: `ProcessType=Background`, `Nice=10`.

The GitHub/GCP split is recoverability-MECE. GitHub owns tracked source. GCP owns private or local state under `user/`, `pipeline/`, `docs/`, `config/`, `.backup/`, `.claude/`, `code/`, and `quarantine/`, plus declared local-only files such as `.env.local` and ignored owner scripts. Tool outputs such as `node_modules/`, `.vercel/`, `agents/dist/`, and deploy version stamps are allowed only because they are regenerated from source or setup. Test screenshots/results write to `/tmp/robotdojo-qa/` unless a story explicitly preserves QA evidence under `pipeline/`.

The retired `com.robotdojo.nightly` agent (overnight batch, deleted by st_fd14cdd4) never owns backup if it resurfaces on an old machine — maintenance routines run always-on via the server-supervised maintenance worker (`lib/maintenance-routines.js`), and backup stays with `com.robotdojo.backup` alone.

Legacy owner-personal jobs such as `com.robotdojo.backup-files` are deprecated and not packaged. They belong to the LaunchAgent cleanup story, not the product backup architecture.

Live drift is checked by `scripts/check-live-launch-agents.js`. Repair is dry-run by default via `scripts/repair-live-launch-agents.js`; `--apply` requires explicit owner approval.

## `com.robotdojo.chunk-worker`

Dedicated launchd agent for vector embedding. Runs `scripts/chunk-embed-worker.js` on a 120-second StartInterval at `ProcessType=Background`, `LowPriorityIO=true`, `Nice=10`.

- Plist: `~/Library/LaunchAgents/com.robotdojo.chunk-worker.plist`
- Packaged logs: `~/.robotdojo/logs/robotdojo-chunk-worker.{out,err}.log`
- `runChunkWorker()` is NOT called inline from `sync.js` or `oauth.js` — this plist is the only caller. Any story touching the embedding pipeline must account for this agent.

## `com.robotdojo.keychain-bridge`

Aqua login-session process that decrypts `robotdojo-LOCAL_DB_KEY` for hardened coding-agent hosts. Grok cannot call `security -w` (status 36); this agent can because launchd starts it outside that process tree. Provider keys are not served.

- Plist: `~/Library/LaunchAgents/com.robotdojo.keychain-bridge.plist`
- Socket: `~/.robotdojo/runtime/keychain-bridge.sock` (0600)
- Entrypoint: `scripts/keychain-bridge.js`
- KeepAlive + RunAtLoad. Logs: `~/.robotdojo/logs/robotdojo-keychain-bridge.{out,err}.log`

## `com.robotdojo.server`

The main Hono server. Started by `install.sh`. After removing or changing an env var in this plist, verify the running server's env, not just the file. A server reloaded without unloading first retains old env vars even if the plist changed.
