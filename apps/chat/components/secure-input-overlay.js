// Secure-input credential overlay
//
// Rendered directly above the chat input-area when the backend emits an
// SSE event of the form:
//   { type: 'secure_input', requestId, label, service }
//
// Backend contract (Ori):
//   POST /api/secure-input/submit  { requestId, value }  -> 200 { ok: true }
//   POST /api/secure-input/cancel  { requestId }         -> 200 { ok: true }
//
// Security invariants — load-bearing:
//   - The raw value lives only inside an in-memory closure during the
//     active submit fetch. It is cleared (set to empty string, then
//     re-assigned to undefined) the moment the response settles, success
//     or failure. No retries keep it around.
//   - The value is NEVER logged (no console, no analytics, no error msg).
//     On fetch failure we surface a GENERIC message to the user and the
//     value is gone before any error handler sees it.
//   - The password <input> has autocomplete/autofill disabled, an
//     anonymous name (`secure-value`), and is not associated with a
//     <form> element so browsers do not offer to "remember this password".
//   - When the overlay closes, `input.value = ''` happens before the
//     element is removed from the DOM.

const SUBMIT_ENDPOINT = '/api/secure-input/submit';
const CANCEL_ENDPOINT = '/api/secure-input/cancel';
const TIMEOUT_MS = 120_000; // 2 minutes

function escapeHTML(s) {
  if (typeof esc === 'function') return esc(s);
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function buildOverlayHTML({ requestId, label, service }) {
  const labelText = escapeHTML(label || (service ? `${service} credential` : 'Credential'));
  const svc = service ? escapeHTML(service) : '';
  return `
    <div class="secure-input-card" role="dialog" aria-modal="true" aria-labelledby="secInputTitle-${escapeHTML(requestId)}">
      <div class="secure-input-header">
        <span class="secure-input-lock" aria-hidden="true">🔒</span>
        <span class="secure-input-title" id="secInputTitle-${escapeHTML(requestId)}">${labelText}</span>
        <span class="secure-input-timer" aria-live="off">2:00</span>
      </div>
      <div class="secure-input-field">
        <input
          type="password"
          class="secure-input-value"
          name="secure-value"
          autocomplete="off"
          spellcheck="false"
          autocapitalize="none"
          autocorrect="off"
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          aria-label="${labelText}"
          placeholder="Paste value here"
        >
      </div>
      <div class="secure-input-actions">
        <button type="button" class="secure-input-btn secure-input-btn--cancel">Cancel</button>
        <button type="button" class="secure-input-btn secure-input-btn--submit" disabled>Submit</button>
      </div>
      <p class="secure-input-helper" aria-live="polite" data-service="${svc}">
        This value goes directly to your Keychain. It will never appear in chat history.
      </p>
    </div>
  `;
}

function formatTimer(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function createSecureInputController(opts) {
  const host = opts?.host || document.getElementById('inputArea');
  const onOpen = opts?.onOpen || (() => {});
  const onClose = opts?.onClose || (() => {});

  if (!host) {
    console.warn('[secure-input] no host provided');
    return { present() {}, dismiss() {}, isOpen: () => false };
  }

  let activeOverlay = null; // { el, request, cleanup }

  function dismiss(opts = {}) {
    if (!activeOverlay) return;
    const { el, cleanup } = activeOverlay;
    activeOverlay = null;
    cleanup(opts);
    // Fade out then remove
    el.classList.add('secure-input-overlay--closing');
    setTimeout(() => {
      if (el && el.parentElement) el.remove();
    }, 160);
    onClose();
  }

  function present(request) {
    if (!request || !request.requestId) return;

    // If one is already open for the same requestId, do nothing.
    // If a DIFFERENT request arrives, replace (backend should not do this,
    // but be defensive so we never leak a value across requests).
    if (activeOverlay) {
      if (activeOverlay.request.requestId === request.requestId) return;
      dismiss({ reason: 'superseded' });
    }

    const overlay = document.createElement('div');
    overlay.className = 'secure-input-overlay';
    overlay.dataset.requestId = request.requestId;
    overlay.innerHTML = buildOverlayHTML(request);

    // Insert directly above the input area (same parent, previous sibling).
    host.parentElement.insertBefore(overlay, host);

    const input    = overlay.querySelector('.secure-input-value');
    const submitBtn = overlay.querySelector('.secure-input-btn--submit');
    const cancelBtn = overlay.querySelector('.secure-input-btn--cancel');
    const timerEl   = overlay.querySelector('.secure-input-timer');

    // --- Timer ------------------------------------------------------
    const deadline = Date.now() + TIMEOUT_MS;
    let rafId = 0;
    function tickTimer() {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timerEl.textContent = '0:00';
        autoCancel();
        return;
      }
      timerEl.textContent = formatTimer(remaining);
      // 1 Hz is plenty — use setTimeout rather than rAF to reduce churn.
      rafId = setTimeout(tickTimer, 500);
    }
    tickTimer();

    // --- Focus trap --------------------------------------------------
    const focusables = [input, cancelBtn, submitBtn];
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        doCancel();
      } else if (e.key === 'Enter') {
        // Enter in the password field submits.
        if (e.target === input && !submitBtn.disabled) {
          e.preventDefault();
          doSubmit();
        }
      } else if (e.key === 'Tab') {
        const idx = focusables.indexOf(document.activeElement);
        if (idx === -1) {
          e.preventDefault();
          focusables[0].focus();
          return;
        }
        e.preventDefault();
        const next = e.shiftKey
          ? (idx - 1 + focusables.length) % focusables.length
          : (idx + 1) % focusables.length;
        focusables[next].focus();
      }
    }
    overlay.addEventListener('keydown', onKey);

    // Prevent Tab/Shift-Tab from escaping the overlay at the document level.
    function documentKeyGuard(e) {
      if (!activeOverlay || activeOverlay.el !== overlay) return;
      if (e.key !== 'Tab') return;
      // If focus somehow escaped the overlay, yank it back.
      if (!overlay.contains(document.activeElement)) {
        e.preventDefault();
        focusables[0].focus();
      }
    }
    document.addEventListener('keydown', documentKeyGuard, true);

    // --- Enable/disable submit based on non-empty value -------------
    input.addEventListener('input', () => {
      submitBtn.disabled = input.value.length === 0;
    });

    // --- Actions -----------------------------------------------------
    let settling = false;
    let submitAttempts = 0; // tracks failed save attempts for fallback copy

    async function doSubmit() {
      if (settling) return;
      if (!input.value) return;
      settling = true;
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      input.readOnly = true;

      // Capture value into a local variable, IMMEDIATELY clear the DOM.
      // This is the only place the value exists in JS memory.
      let value = input.value;
      input.value = '';

      let ok = false;
      try {
        const res = await fetch(SUBMIT_ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: request.requestId, value }),
        });
        ok = res.ok;
      } catch {
        // Do NOT include anything that might leak the value. No `err.message`.
        ok = false;
      } finally {
        // Scrub the captured value from memory as best JS allows.
        value = '';
        // eslint-disable-next-line no-unused-vars
        value = undefined;
      }

      if (ok) {
        dismiss({ reason: 'submitted' });
        if (typeof showToast === 'function') showToast('Saved to Keychain');
        return;
      }

      // Failed. First failure: let the user retry once with clear copy.
      // Second failure: stop retrying and tell them exactly how to save it
      // manually in Keychain Access — no silent dead-end.
      submitAttempts += 1;
      settling = false;
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      input.readOnly = false;
      const helper = overlay.querySelector('.secure-input-helper');
      if (helper) {
        helper.classList.add('secure-input-helper--error');
        if (submitAttempts === 1) {
          helper.textContent = 'Couldn\u2019t save. Try again \u2014 if this keeps failing we\u2019ll give you a manual path.';
        } else {
          const svc = helper.dataset.service || (request.service || '');
          const kcService = svc ? `robotdojo-${svc}` : 'robotdojo-<NAME>';
          helper.innerHTML = `Still couldn\u2019t save to Keychain. Open <strong>Keychain Access</strong>, add a password item with service <code>${escapeHTML(kcService)}</code>, paste the value there, then retry.`;
          // One-click copy of the service name if clipboard is allowed.
          const code = helper.querySelector('code');
          if (code) {
            code.style.cursor = 'pointer';
            code.title = 'Copy service name';
            code.addEventListener('click', () => {
              if (navigator.clipboard) navigator.clipboard.writeText(kcService).catch(() => {});
              if (typeof showToast === 'function') showToast('Copied service name');
            });
          }
        }
      }
      input.focus();
    }

    async function doCancel() {
      if (settling) return;
      settling = true;
      // Clear value synchronously before awaiting anything.
      input.value = '';
      try {
        await fetch(CANCEL_ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: request.requestId }),
        });
      } catch {
        // Best-effort — swallow.
      }
      dismiss({ reason: 'cancelled' });
    }

    function autoCancel() {
      // Timer expired — treat as cancel, backend will also time out.
      input.value = '';
      if (settling) return;
      doCancel();
    }

    submitBtn.addEventListener('click', doSubmit);
    cancelBtn.addEventListener('click', doCancel);

    // Pulse in
    requestAnimationFrame(() => overlay.classList.add('secure-input-overlay--visible'));

    // Focus the input after mount. Use rAF to ensure the element is
    // actually in layout before focusing (Safari quirk).
    requestAnimationFrame(() => input.focus({ preventScroll: false }));

    activeOverlay = {
      el: overlay,
      request,
      cleanup() {
        clearTimeout(rafId);
        document.removeEventListener('keydown', documentKeyGuard, true);
        // Final scrub just in case.
        if (input) input.value = '';
      },
    };
    onOpen(request);
  }

  function isOpen() {
    return !!activeOverlay;
  }

  return { present, dismiss, isOpen };
}
