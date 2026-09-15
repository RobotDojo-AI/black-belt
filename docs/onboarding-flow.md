# First-Run Flow

Canonical spec for the install-to-ready path. A new local install opens the two
durable product surfaces the user will keep using: Account Integrations and
Chat.

## Product rule

Post-install opens exactly two browser tabs:

1. **Account Integrations** — the operational source of truth for connections,
   imports, exports, credentials, artifact counts, status, last seen, and next
   action.
2. **Chat** — the real chat app with setup-guide context and an initial help
   prompt, so the user can ask what to do next without learning another UI.

There is no browser `/setup` route and no separate post-install screen. Any
first-run readiness, permission, OAuth, key, import, or relay state must appear
in Account Integrations or be explained through Chat.

## Terminal install

The supported command is:

```bash
curl -fsSL https://robotdojo.ai/install.sh | bash
```

The installer:

- runs preflight checks for Node, ports, disk, and local service support
- installs dependencies and product LaunchAgents
- creates `~/.robotdojo/`
- provisions the local database key and local auth token
- derives a suggested device name from the computer name
- asks the user to confirm or edit the login slug
- creates `~/Applications/Robot Dojo.app` as the local app runtime for macOS permissions, plus a compatibility launcher at `~/.robotdojo/bin/Robot Dojo`
- starts the local service
- opens macOS Full Disk Access so the user can approve `Robot Dojo`; if runtime creation fails, setup truthfully falls back to the Node runtime path
- opens a one-time local auth handoff URL at `/auth/local-start?token=...`
- opens Chat with `context=setup-guide`

The auth handoff validates the local token, creates the browser session, strips
the token from the browser URL, and lands on `/account/integrations`.

## Account Integrations

Account Integrations is the first-run control plane. It must show one normalized
row shape across local Mac access, OAuth providers, API keys, imports, backup,
relay, and foundation-model export/import paths.

Each row should expose:

- provider or subsystem
- status
- credential state
- artifact counts by type when available
- last seen or last checked
- primary next action
- links to auth, exports, keys, or import areas

The table can include loading, syncing, stale, missing, error, connected, and
retry states. It should never make the user leave the product to understand
whether Robot Dojo is ready.

## Chat handoff

The installer opens the real Chat app with setup-guide context loaded. Chat uses
the same shell, styling, composer, and message behavior as authenticated chat.

The setup guide context answers from the latest repo and generated public truth
where appropriate. Public docs chat remains bounded to public-safe canonical
sources. Local installed chat can use local app state and repo/current install
context as available.

## External actions

External systems are linked from Account Integrations:

- Local Mac integrations require Full Disk Access for the runtime that owns the server process. The installer builds an ad-hoc signed `~/Applications/Robot Dojo.app`, bundles the Node runtime and dylibs inside it, and runs every product LaunchAgent through that executable so macOS permission UI can attach to Robot Dojo. If runtime creation fails, Account Integrations must show the fallback Node path instead. macOS still requires the user to grant Full Disk Access manually; the installer can create the app and open the settings pane, but it cannot silently approve the permission.
- Local permission checks must never open protected Apple SQLite stores in the server process. Probe local Mac permissions in timed child processes and treat timeout as not granted so Apple/Granola setup can never freeze Chat or Account Integrations.
- Google OAuth returns to Account Integrations.
- Microsoft setup uses tenant-admin Graph application permissions. In Azure, add Application permissions for Mail.Read or Mail.ReadWrite, add Calendars.Read if calendar sync is wanted, click Grant admin consent, then store tenant ID, client ID, and client secret in Account Integrations and add each mailbox email. Do not use the delegated approval prompt as the launch path.
- Foundation model export pages are links from integration rows.
- API keys are entered through account key surfaces.
- Dropped files and exports land in the import/drop-folder flow.

Slow provider-paced work never blocks first-run. Account Integrations shows
pending state and Chat explains what the user can do while the work runs.

## Readiness model

Robot Dojo is usable before every integration is complete. First-run readiness
means:

- the local service is running
- the user can open authenticated Account Integrations
- Chat opens with setup context
- at least one useful data path is available or clearly actionable

Full historical backfills, foundation model exports, and optional integrations
can continue in the background.

## Implementation notes

- Browser product route: no `/setup`.
- Local auth handoff: `/auth/local-start?token=...`.
- Account APIs may continue using `/api/setup/*` compatibility names until those
  internal names are intentionally migrated. They are data APIs, not a setup UI.
- Device rename and slug confirmation happen in the installer and Account
  surfaces, not in a wizard.
- Re-running the installer is idempotent and should reopen Integrations + Chat,
  not resurrect a setup surface.

## Acceptance criteria

- The installer opens Account Integrations and Chat, and no third first-run UI.
- `/setup` does not render a product screen.
- OAuth success and recovery return to Account Integrations.
- Chat setup help is available through the real Chat app.
- Account Integrations exposes clear state for local permissions, OAuth, keys,
  imports, backups, relay, and model/export paths.
- Canonical docs and generated repo maps describe only Account Integrations and
  Chat as post-install product surfaces.
