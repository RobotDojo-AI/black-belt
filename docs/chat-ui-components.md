# Chat UI Components

Two components live under `apps/chat/components/` and plug into the chat
app without touching the message rendering pipeline. Both consume SSE
events from the chat stream through a small event bus declared in
`apps/chat/app.js`.

## Architecture

```
Backend (Ori)                     Frontend (Katagami)
─────────────                     ──────────────────
watcher.js ──┐
             │ emits SSE events
routes/chat. │   file_arrived
js (main     │   file_classified
chat stream) │   file_processed
             ├─▶ file_errored       ─▶ modules/chat.js
             │   secure_input          handleSSEEvent()
             │                         │
routes/      │                         └─▶ window.__chatEventBus.dispatch()
secure-input │                               │
.js          │    POST /api/secure-input/    │
             ◀──  {submit,cancel}            │
             │                               ├─▶ drop-events.js
             │   (optional ambient) ─────────┤   (renders cards)
             └─▶ GET /api/chat/events        │
                                             └─▶ secure-input-overlay.js
                                                 (renders overlay)
```

**No npm deps. No framework. Pure vanilla ES modules.**

## drop-events.js

### Purpose

Render file-ingest activity as compact system cards in the chat stream
when the user drops a file into `~/robotdojo/user/inbox/`.

### SSE contract (from Ori)

Events share the live chat SSE stream. Each event carries a stable
`fileId` that joins all events for the same file.

| type              | shape                                                       |
|-------------------|-------------------------------------------------------------|
| `file_arrived`    | `{ type, fileId, name }`                                    |
| `file_classified` | `{ type, fileId, name, docType, topicPath }`                |
| `file_processed`  | `{ type, fileId, name, summary }` (summary is a string)     |
| `file_errored`    | `{ type, fileId, name, reason }`                            |

### Behavior

- A file's lifecycle renders as **one card** that is progressively
  mutated by subsequent events. We never stack multiple cards for the
  same `fileId`.
- State ordering is enforced: `arrived → classified → processed/errored`.
  An out-of-order event (e.g. stale `arrived` after `processed`) does
  not regress the state.
- If the user is scrolled to the bottom OR a message is currently
  streaming, the chat auto-scrolls to keep the new card in view.
- If the user is scrolled up reading history, the chat does **not**
  auto-scroll. A "New activity" pill appears near the bottom of the
  scroller. Clicking it jumps to the latest content. The pill
  auto-hides after 8 seconds.

### Visual style

- Muted surface (`--surface`), small padding, 13px text.
- Monospace file names and topic paths (inline pill background).
- Neutral color — never the brand blue. Brand blue is reserved for
  actionable assistant messages.
- Errored cards get a red tint and a `⚠︎` icon.

## secure-input-overlay.js

### Purpose

Collect a credential (API key, secret token, etc.) from the user when
the LLM invokes a tool that needs one. The value flows browser →
HTTPS → Keychain, **never** through chat state, LLM context, or logs.

### SSE contract (from Ori)

One event kicks off the overlay:

```
{ type: 'secure_input', requestId, label, service }
```

- `requestId` — opaque, round-tripped back to the backend.
- `label` — human-readable prompt shown in the header
  (e.g. "Stripe Secret Key").
- `service` — optional; used when `label` is missing.

### Endpoints called

| Method | Path                         | Body                      | Response      |
|--------|------------------------------|---------------------------|---------------|
| POST   | `/api/secure-input/submit`   | `{ requestId, value }`    | `{ ok: true }`|
| POST   | `/api/secure-input/cancel`   | `{ requestId }`           | `{ ok: true }`|

On submit success the backend writes the value to the macOS Keychain
and resumes the paused LLM tool call. On cancel the backend marks the
request cancelled.

### Behavior

- Appears **above** the chat input area (pushes input down, does not
  cover the messages).
- Password-masked input with every autocomplete hint disabled —
  `autocomplete="off"`, `spellcheck="false"`, `autocapitalize="none"`,
  `autocorrect="off"`, `data-lpignore="true"` (LastPass),
  `data-1p-ignore="true"` (1Password), `data-form-type="other"`.
  The `name` is generic (`secure-value`) and not associated with a
  `<form>`; browsers do not offer "Remember this password".
- 2-minute visible countdown in the top-right of the card. On zero
  the overlay auto-cancels (fires the cancel endpoint).
- Keyboard:
  - **Enter** (while focused on input) submits.
  - **Escape** cancels.
  - **Tab / Shift-Tab** cycle only within the overlay
    (input → cancel → submit → input → …). A document-level keydown
    guard yanks focus back if it escapes.
- While the overlay is showing, the main chat input is disabled and
  dimmed (`body.secure-input-active .input-container`).
- Fade-in (160ms) with a subtle blue pulse shadow on appearance.
- Fade-out (160ms) on submit/cancel.
- Responsive down to 375px — on narrow screens the buttons stretch
  full-width.

### Threat model

The value is the sensitive unit. We harden the lifecycle around it:

1. **Never serialized with chat state.** The overlay lives outside the
   chat messages stream. Nothing about the submitted value reaches
   `/api/chat/stream`, `messages` in localStorage, conversation DB
   rows, or RAG ingest. The backend also does not echo the value in
   any SSE event.
2. **Captured once, into a closure local.** `doSubmit` reads
   `input.value` into a local `let value`, immediately sets
   `input.value = ''`, and passes `value` to `fetch`.
3. **Cleared on settle.** A `try/finally` around the fetch resets
   `value = ''; value = undefined` regardless of success or failure.
   No reference survives for retries.
4. **Generic error surface.** On fetch failure, the UI shows
   "Could not save. Please try again." The raw error is NOT logged or
   displayed — if it were, `err.message` from a proxy misconfig could
   conceivably echo the request body.
5. **DOM scrub on close.** `dismiss()` sets `input.value = ''` before
   removing the element from the DOM, so even DevTools time-travel
   inspection of the fading overlay shows no value.
6. **Form autofill denied.** The input has no associated `<form>`, a
   generic `name`, and four vendor-specific "do not save" flags.
7. **Never logged.** No `console.log`, `console.error`, analytics, or
   error-reporting call in the component references the value or the
   error body. Grep for `value` in the file — every reference is
   either assignment to/from DOM, assignment to the scrub variable,
   or the fetch body.
8. **One overlay at a time.** If a second `secure_input` event arrives
   while one is open, the first is dismissed (scrubbed) before the
   second is presented. Prevents cross-contamination.
9. **Timeout safety.** 2-minute inactivity timer triggers cancel so a
   forgotten overlay does not leave the input and DOM dangling with
   (empty) state.

### Accessibility

- `role="dialog" aria-modal="true"` on the card, `aria-labelledby`
  pointing at the title.
- `aria-label` on the password input (matches the title).
- `aria-live="polite"` on the helper text so screen readers announce
  the error message when fetch fails.
- Tab trap scoped to the overlay; Escape closes. Focus returns to the
  chat textarea on close (and it is re-enabled).

## Event bus (`window.__chatEventBus`)

Internal to the chat app. Declared in `apps/chat/app.js`.

```js
window.__chatEventBus = {
  on(type, fn): unsubscribe,
  dispatch(event): void,
};
```

- `modules/chat.js:handleSSEEvent` forwards unknown-to-the-pipeline
  events (the five listed above) into the bus.
- `app.js` also opens an **optional** `EventSource('/api/chat/events')`
  so drop-folder events arrive when no chat stream is active (e.g.
  user drops a file while scrolling history). If that endpoint is
  absent, the bus just silently never receives ambient events — the
  streaming path continues to work.

## Files touched

```
apps/chat/components/drop-events.js          (new — ~200 lines)
apps/chat/components/secure-input-overlay.js (new — ~270 lines)
apps/chat/app.js                             (bus + wiring added in init())
apps/chat/modules/chat.js                    (handleSSEEvent dispatches 5 new event types)
apps/static/shared/shell.css                 (~200 lines of component styles)
docs/chat-ui-components.md                   (this file)
```

## Testing notes

- Drop-events: simulate by running
  `window.__chatEventBus.dispatch({ type: 'file_arrived', fileId: 't1', name: 'test.pdf' })`
  from DevTools. Then `file_classified`, `file_processed`. Watch one
  card evolve in place.
- Secure-input: `window.__chatEventBus.dispatch({ type: 'secure_input', requestId: 'r1', label: 'Stripe Secret Key', service: 'stripe' })`.
  The overlay appears; Escape cancels; submitting posts to the
  backend (404 is expected locally until Ori's route is live, which
  surfaces the "Could not save" helper).
- Resize to 375px to verify mobile layout.
- Tab through the overlay — focus should cycle only within it.
