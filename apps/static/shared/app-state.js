(function () {
  class RobotDojoAppState {
    constructor() {
      this.initial = null;
      this.tabs = new Map();
      this.loading = new Map();
      this.timestamps = new Map();
    }

    async loadInitial(fetcher) {
      if (this.initial) return this.initial;
      this.initial = await fetcher();
      return this.initial;
    }

    async loadTab(key, fetcher, { force = false } = {}) {
      if (!force && this.tabs.has(key)) return this.tabs.get(key);
      if (!force && this.loading.has(key)) return this.loading.get(key);
      const started = performance.now();
      const p = Promise.resolve(fetcher()).then((value) => {
        this.tabs.set(key, value);
        this.timestamps.set(key, { loadedAt: Date.now(), durationMs: performance.now() - started });
        this.loading.delete(key);
        return value;
      }).catch((err) => {
        this.loading.delete(key);
        throw err;
      });
      this.loading.set(key, p);
      return p;
    }

    invalidate(key) {
      if (key) {
        this.tabs.delete(key);
        this.timestamps.delete(key);
        return;
      }
      this.initial = null;
      this.tabs.clear();
      this.timestamps.clear();
    }

    meta(key) {
      return this.timestamps.get(key) || null;
    }
  }

  window.RobotDojoAppState = RobotDojoAppState;
})();
