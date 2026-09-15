# secure_input — chat-driven credential capture

## Problem

The LLM routinely needs API keys and passwords that the server doesn't have
yet (Stripe, Anthropic, Alchemy, Resend, ...). The naive approach — "tell the
assistant your key, please" — puts the secret into:

- the browser-side transcript
- the HTTPS POST body
- the chat-router log
- the conversation DB (messages table)
- the LLM's context window on the next turn
- any agent memory snapshot

None of those are appropriate for live credentials.

## Solution

A dedicated out-of-band channel tied to the chat session:

1. The LLM calls a tool `request_credential({service, label, purpose})`.
2. Server creates a `secure_input_requests` row (migration 007). `service`
   is the canonical Keychain name (`STRIPE_SECRET_KEY`, etc.); no value.
3. Server emits an SSE frame `{type: 'secure_input', requestId, service, label}`.
4. Browser renders a password-masked input **above the chat composer** —
   outside the normal message stream. The field's submission uses a
   dedicated endpoint, never the chat stream.
5. User pastes the value and submits to `POST /api/secure-input/submit`
   with `{requestId, value}`. Session cookie gates the call.
6. Server verifies that the request belongs to the caller's session, writes
   the value to macOS Keychain via `security add-generic-password`, marks
   the row `submitted`. Only metadata (which key was stored) is logged.
7. Server returns `{success: true}` — never the value.
8. The chat tool handler sees `status = 'submitted'` in the DB and returns
   `{stored: true, service}` as its tool result. Claude continues the
   conversation aware that the key exists, not what it is.

## Threat model

| Attacker | Vector | Defense |
|---|---|---|
| Prompt injection trying to exfiltrate | The LLM only ever receives `{stored, service}` | Value never enters tool_result |
| Reader of conversation logs | Messages + tool_result are the transcript | Value never hits the chat router |
| Reader of server process logs | `console.*` could echo | Only key NAMES are logged, never values |
| Stolen request id | Another session submits | `session_id` bound at creation + timing-safe compare |
| Replay of old request | Reuse after submission | `consumed_at` + status flips to `submitted`, single-use |
| Stale request | Left sitting | 120 s `expires_at`, cron-free sweep runs on lookups |
| Non-macOS runtime | Keychain absent | `platform() !== 'darwin'` → HTTP 501 |

## Why argv-passing to `security` is acceptable

`security add-generic-password -w <VALUE>` accepts the password as an argv
element. We spawn with `child_process.spawn('/usr/bin/security', args)` —
args are delivered to the process via `execve(2)` directly. There is **no
shell** in the pipeline, so the value is not subject to globbing, history
expansion, tee, or command echo.

Visibility surface:

- `ps` can see the args of a running process. The `security` binary exits
  in < 50 ms for a single password write; the window is minimal and
  restricted to other processes running as the same user.
- macOS does not log argv into the unified log for short-lived processes
  invoked by a user-level application.

We prefer the argv path over stdin here because `security
add-generic-password` does not accept the password from stdin — its only
documented input paths are `-w <pw>` (explicit) and interactive prompting.
Interactive prompting can't be automated without a PTY, which is a much
larger surface than argv.

## Where the value lives afterwards

Only in Keychain, under service name `miyagi-<SERVICE>`. Everything else
(subscriptions, billing, etc.) reads via `config.js` → `secret(name)`
→ `security find-generic-password -s miyagi-<name>`.

## Adding a new service name

1. Pick an uppercase-snake name that matches what the rest of the app
   already uses. See `lib/config.js` for existing names.
2. Add an alias to `~/bin/load-keys.sh` if the loose CLI form should also
   accept it.
3. Have the LLM call `request_credential({service: 'FOO_API_KEY',
   label: 'Foo API key', purpose: 'Connect Foo for X'})`.

No server-side allowlist is enforced. The `VALID_SERVICE_RE` in
`lib/secure-input.js` only validates shape (`[A-Z][A-Z0-9_]{1,63}`).

## Surface area checklist (auditor view)

- [x] Value never passes to the chat router.
- [x] Value never appears in any `console.*` call.
- [x] Value never enters the LLM context.
- [x] Value never lives in the DB — only request metadata.
- [x] Request expires after 2 min without human action.
- [x] Request is single-use (`consumed_at` + status gate).
- [x] Session binding uses timing-safe compare.
- [x] Request id is 32 bytes of `randomBytes` (256 bits).
- [x] Keychain write uses `spawn` with argv, no shell.
- [x] Non-macOS path returns 501 instead of silently failing.
