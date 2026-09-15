/**
 * Error UI for chat turns (st_74f45a1a Phase 3/4).
 *
 * Renders a [data-testid="chat-error-message"] paragraph and a
 * [data-testid="chat-retry-button"] button into a container. Retry click
 * invokes the injected onRetry() callback.
 *
 * Container ownership: the caller owns the container; show() never wipes
 * anything outside the elements ErrorUI manages.
 */

const FRIENDLY_MESSAGES = {
  http_error: 'The server hit an error. Tap retry or try again in a moment.',
  network_error: 'Connection trouble. Tap retry to reconnect.',
  simulated_error: 'Test hook triggered an error. Tap retry.',
  llm_error: 'The model had trouble responding. Tap retry.',
  // Generic fallback if the server sends an unrecognized error_type.
  default: 'Something went wrong. Please try again.',
};

export class ErrorUI {
  /**
   * @param {Element} container - DOM element to mount into
   * @param {object} options
   * @param {Function} options.onRetry - called when retry button clicked
   * @param {Document} [options.document] - DOM document (injectable for tests)
   */
  constructor(container, { onRetry, document: doc } = {}) {
    this._container = container;
    this._onRetry = typeof onRetry === 'function' ? onRetry : () => {};
    // Resolve document at construction time so tests can inject a stub.
    // In browsers, fallback to globalThis.document.
    this._doc = doc || (typeof document !== 'undefined' ? document : null);
    this._wrapper = null;
  }

  /**
   * Show an error with a friendly label.
   * @param {string} errorType - 'http_error' | 'network_error' | 'simulated_error' | 'llm_error' | ...
   * @param {string} [message] - server-provided message; falls back to FRIENDLY_MESSAGES[errorType]
   */
  show(errorType, message) {
    if (!this._doc) return;
    // Replace any prior error — no stacking.
    this.hide();

    const wrapper = this._doc.createElement('div');
    wrapper.setAttribute('data-testid', 'chat-error-wrapper');
    wrapper.classList.add('chat-error-wrapper');

    const msg = this._doc.createElement('p');
    msg.setAttribute('data-testid', 'chat-error-message');
    msg.classList.add('chat-error-message');
    msg.textContent = message || FRIENDLY_MESSAGES[errorType] || FRIENDLY_MESSAGES.default;

    const btn = this._doc.createElement('button');
    btn.setAttribute('data-testid', 'chat-retry-button');
    btn.classList.add('chat-retry-button');
    btn.textContent = 'Retry';
    btn.disabled = false;
    btn.addEventListener('click', () => {
      try { this._onRetry(); } catch (err) {
        // Never let a faulty onRetry handler crash the chat surface.
        // eslint-disable-next-line no-console
        if (typeof console !== 'undefined') console.error('[chat error-ui] onRetry threw:', err);
      }
    });

    wrapper.appendChild(msg);
    wrapper.appendChild(btn);
    this._container.appendChild(wrapper);
    this._wrapper = wrapper;
  }

  hide() {
    if (this._wrapper) {
      // Remove via parent.removeChild so the stub-DOM tests stay happy.
      if (typeof this._wrapper.remove === 'function') {
        this._wrapper.remove();
      } else if (this._wrapper.parent && typeof this._wrapper.parent.removeChild === 'function') {
        this._wrapper.parent.removeChild(this._wrapper);
      }
      this._wrapper = null;
    }
  }
}
