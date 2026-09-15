// Shared keyboard shortcut registry for Robot Dojo apps.
(function () {
  const STORAGE_KEY = 'rd_shortcuts_v1';
  const LEGACY_KEY = 'rd_account_shortcuts';

  // st_4e7e3aaf AC12 — each shortcut carries a "group" field so the Shortcuts
  // page can render labeled sections (Chat, Navigation, Organization, App).
  // Group order in the UI follows GROUP_ORDER below; within each group,
  // items render in the order declared here.
  const DEFAULTS = [
    { id: 'new_chat', label: 'New chat', keys: ['n'], "group": 'chat' },
    { id: 'focus_prompt', label: 'Focus prompt', keys: ['/'], "group": 'chat' },
    { id: 'cycle_model', label: 'Cycle model', keys: ['m'], "group": 'chat' },
    { id: 'attach_file', label: 'Attach file', keys: ['f'], "group": 'chat' },
    { id: 'navigate_down', label: 'Navigate down', keys: ['j'], "group": 'navigation' },
    { id: 'navigate_up', label: 'Navigate up', keys: ['k'], "group": 'navigation' },
    { id: 'open_selected', label: 'Open selected', keys: ['o'], "group": 'navigation' },
    { id: 'return_to_list', label: 'New chat', keys: ['u'], "group": 'navigation' },
    { id: 'archive', label: 'Archive', keys: ['e', 'y'], "group": 'organization' },
    { id: 'delete', label: 'Delete', keys: ['#'], "group": 'organization' },
    { id: 'star', label: 'Star', keys: ['s'], "group": 'organization' },
    { id: 'label_topic', label: 'Label / Topic', keys: ['t'], "group": 'organization' },
    { id: 'close', label: 'Close', keys: ['Esc'], "group": 'app' },
    { id: 'help', label: 'Shortcuts', keys: ['Shift+?'], "group": 'app' },
  ];

  // st_4e7e3aaf AC12 — render order + display labels for the groups.
  const GROUP_ORDER = ['chat', 'navigation', 'organization', 'app'];
  const GROUP_LABELS = {
    chat: 'Chat',
    navigation: 'Navigation',
    organization: 'Organization',
    app: 'App',
  };

  function cloneDefaults() {
    return DEFAULTS.map((s) => ({ ...s, keys: [...s.keys] }));
  }

  function normalizeKeyName(key) {
    const k = String(key || '').trim();
    const lower = k.toLowerCase();
    if (lower === 'escape') return 'Esc';
    if (lower === ' ') return 'Space';
    if (lower === 'arrowup') return 'ArrowUp';
    if (lower === 'arrowdown') return 'ArrowDown';
    if (lower === 'arrowleft') return 'ArrowLeft';
    if (lower === 'arrowright') return 'ArrowRight';
    if (lower === 'meta') return 'Cmd';
    if (lower === 'control') return 'Ctrl';
    if (lower === 'alt') return 'Alt';
    if (lower === 'shift') return 'Shift';
    return k.length === 1 ? k.toUpperCase() : k;
  }

  function eventToCombo(e) {
    const key = normalizeKeyName(e.key);
    if (['Cmd', 'Ctrl', 'Alt', 'Shift'].includes(key)) return '';
    const mods = [];
    if (e.metaKey) mods.push('Cmd');
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey && key !== '#') mods.push('Shift');
    return [...mods, key].join('+');
  }

  function keyMatches(e, combo) {
    const parts = String(combo || '').split('+').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return false;
    const wanted = {
      cmd: parts.some((p) => /^cmd|command|meta$/i.test(p)),
      ctrl: parts.some((p) => /^ctrl|control$/i.test(p)),
      alt: parts.some((p) => /^alt|option$/i.test(p)),
      shift: parts.some((p) => /^shift$/i.test(p)),
    };
    const keyPart = parts.find((p) => !/^(cmd|command|meta|ctrl|control|alt|option|shift)$/i.test(p));
    if (!keyPart) return false;
    if (wanted.cmd && !(e.metaKey || e.ctrlKey)) return false;
    if (wanted.ctrl && !e.ctrlKey) return false;
    if (wanted.alt !== !!e.altKey) return false;
    if (wanted.shift && !e.shiftKey) return false;
    if (!wanted.cmd && !wanted.ctrl && (e.metaKey || e.ctrlKey)) return false;
    if (!wanted.alt && e.altKey) return false;
    const actual = normalizeKeyName(e.key).toLowerCase();
    const target = normalizeKeyName(keyPart).toLowerCase();
    return actual === target;
  }

  function migrateLegacy() {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw || localStorage.getItem(STORAGE_KEY)) return null;
    try {
      const legacy = JSON.parse(raw);
      if (!Array.isArray(legacy)) return null;
      const defaults = cloneDefaults();
      for (let i = 0; i < legacy.length && i < defaults.length; i++) {
        const keys = String(legacy[i]?.[1] || '').split('/').map((s) => s.trim()).filter(Boolean);
        if (keys.length) defaults[i].keys = keys;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
      return defaults;
    } catch {
      return null;
    }
  }

  function load() {
    const migrated = migrateLegacy();
    if (migrated) return migrated;
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(parsed)) {
        const byId = new Map(parsed.map((s) => [s.id, s]));
        return cloneDefaults().map((base) => {
          const saved = byId.get(base.id);
          return saved ? { ...base, keys: Array.isArray(saved.keys) ? saved.keys : base.keys } : base;
        });
      }
    } catch { /* ignore */ }
    return cloneDefaults();
  }

  function saveShortcut(id, combo) {
    const all = load();
    const hit = all.find((s) => s.id === id);
    if (hit && combo) hit.keys = [combo];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    localStorage.removeItem(LEGACY_KEY);
    return all;
  }

  function reset() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_KEY);
  }

  function matchEvent(e) {
    for (const shortcut of load()) {
      if ((shortcut.keys || []).some((combo) => keyMatches(e, combo))) return shortcut.id;
    }
    return null;
  }

  window.RobotDojoShortcuts = {
    defaults: cloneDefaults,
    load,
    saveShortcut,
    reset,
    eventToCombo,
    matchEvent,
    GROUP_ORDER,
    GROUP_LABELS,
  };
})();
