/**
 * Turn-status narration. Renders the work currently in flight from
 * server-emitted `phase` events. No spinner, no cycling copy, no icons —
 * the visible text is the last honest phase label.
 *
 * Every visible TEXT state MUST correspond to a server-emitted phase or
 * payload field — never invent — except the static LABELS fallback when
 * the server sends a known phase with no label.
 */

const LABELS = {
  connected: 'Opening the chat stream.',
  assembling_context: 'Preparing the response.',
  searching_memory: 'Searching memory context.',
  calling_tools: 'Calling tools.',
  thinking: 'Thinking it through.',
  streaming: '',
  persisted: '',
};

const RESPONSE_MODE_TIER = { fast: 0, context: 1, deep: 2 };
const MODE_TO_LANE = { fast: 'ask', context: 'work', deep: 'think' };
const LANE_TO_MODE = Object.fromEntries(Object.entries(MODE_TO_LANE).map(([mode, lane]) => [lane, mode]));

const TOOL_ACTION_LABELS = {
  search_memory: 'Searching your memory',
  search_people: 'Looking through your contacts',
  query_network: 'Mapping your network',
  query_family: 'Checking your family info',
  add_fact: 'Saving a fact',
  add_person: 'Adding that person',
  set_relation_tag: 'Updating your relationships',
  set_employer: 'Updating your work info',
  update_person: 'Updating that record',
  update_profile: 'Updating your profile',
  get_health_summary: 'Checking your health summary',
  record_viewer_correction: 'Applying your correction',
};
const TOOL_ACTION_FALLBACK = 'Working on it…';

function resolveMode(payload) {
  const mode = payload?.mode;
  if (Object.prototype.hasOwnProperty.call(RESPONSE_MODE_TIER, mode)) return mode;
  const fromLane = LANE_TO_MODE[payload?.lane];
  return fromLane || 'fast';
}

function humanizeToolPhase(payload) {
  const rawLabel = typeof payload?.label === 'string' ? payload.label.trim() : '';
  if (!rawLabel) {
    return typeof payload?.count === 'number'
      ? composeCountLabel('calling_tools', payload.count)
      : TOOL_ACTION_FALLBACK;
  }
  const match = rawLabel.match(/^calling\s+(.+?)[.…]*$/i);
  const name = (match ? match[1] : rawLabel).trim();
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return TOOL_ACTION_LABELS[key] || TOOL_ACTION_FALLBACK;
}

export class Indicator {
  /**
   * @param {Element} domEl - the `.chat-indicator` container. Must contain
   *   a `.chat-indicator-icon` and a `.chat-indicator-text` child.
   */
  constructor(domEl) {
    this._el = domEl;
    this._iconEl = domEl?.querySelector?.('.chat-indicator-icon') || null;
    this._textEl = domEl?.querySelector?.('.chat-indicator-text') || null;
    this._lastPhase = null;
    this._tier = null;
    this._lane = null;
    this._holdTimer = null;
    this._providerDegradedMessage = null;
  }

  /**
   * Render a phase label into the DOM. Unknown phases are no-ops.
   *
   * @param {string} phaseName
   * @param {object} [payload]
   */
  setPhase(phaseName, payload) {
    if (!Object.prototype.hasOwnProperty.call(LABELS, phaseName)) return;
    this._lastPhase = phaseName;

    if (payload && payload.degraded === true && typeof payload.label === 'string' && payload.label.trim()) {
      this._providerDegradedMessage = payload.label.trim();
    }
    if (this._providerDegradedMessage) {
      this._render(this._providerDegradedMessage);
      if (this._el?.dataset) this._el.dataset.providerDegraded = 'true';
      return;
    }

    if (phaseName === 'assembling_context') {
      const mode = resolveMode(payload);
      this._tier = RESPONSE_MODE_TIER[mode] ?? 0;
      this._lane = MODE_TO_LANE[mode] || 'ask';
      if (this._el?.dataset) this._el.dataset.tier = this._lane;
    }

    let text = '';
    if (phaseName === 'calling_tools') {
      text = humanizeToolPhase(payload);
    } else if (payload && typeof payload === 'object') {
      if (typeof payload.label === 'string' && payload.label.trim()) {
        text = payload.label.trim();
      } else if (typeof payload.count === 'number') {
        text = composeCountLabel(phaseName, payload.count);
      } else {
        text = LABELS[phaseName];
      }
    } else {
      text = LABELS[phaseName];
    }

    if (!text) return;
    this._render(text);
  }

  fadeOut() {
    if (this._el && this._el.classList) {
      this._el.classList.add('is-fading');
      this._el.classList.remove('is-active');
    }
  }

  clear() {
    this._lastPhase = null;
    this._tier = null;
    this._lane = null;
    this._providerDegradedMessage = null;
    this._holdTimer = null;
    if (this._textEl) this._textEl.textContent = '';
    else if (this._el) this._el.textContent = '';
    if (this._iconEl) {
      this._iconEl.innerHTML = '';
      if (this._iconEl.classList) {
        this._iconEl.classList.remove('ask');
        this._iconEl.classList.remove('work');
        this._iconEl.classList.remove('think');
      }
      this._iconEl.removeAttribute?.('data-tip');
    }
    if (this._el) {
      if (this._el.dataset) {
        delete this._el.dataset.phase;
        delete this._el.dataset.status;
        delete this._el.dataset.tier;
        delete this._el.dataset.providerDegraded;
      }
      this._el.removeAttribute?.('aria-label');
      if (this._el.classList) {
        this._el.classList.remove('is-fading');
        this._el.classList.remove('is-active');
      }
    }
  }

  getPhase() {
    return this._lastPhase;
  }

  isProviderDegraded() {
    return Boolean(this._providerDegradedMessage);
  }

  _render(text) {
    if (this._textEl) this._textEl.textContent = text;
    else if (this._el) this._el.textContent = text;
    if (this._el?.dataset) {
      this._el.dataset.slaManaged = 'true';
      if (this._lastPhase) this._el.dataset.phase = this._lastPhase;
      const value = String(text || '').trim();
      if (value) {
        this._el.dataset.status = value;
        this._el.setAttribute?.('aria-label', value);
      }
    }
    if (this._el?.classList) {
      this._el.classList.add('is-active');
      this._el.classList.remove('is-fading');
    }
  }
}

export function composeCountLabel(phase, count) {
  const n = Number.isFinite(count) ? count : 0;
  switch (phase) {
    case 'searching_memory': return `Reading ${n} of your sources…`;
    case 'calling_tools':    return `Calling ${n} tools…`;
    case 'assembling_context': return `Adding context from ${n} sources.`;
    default: return LABELS[phase] || '';
  }
}

export { LABELS as INDICATOR_LABELS };
export { RESPONSE_MODE_TIER, resolveMode, humanizeToolPhase };
