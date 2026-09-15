const HEALTH_MARKERS_CACHE_TTL_MS = Number(process.env.ROBOTDOJO_HEALTH_MARKERS_CACHE_MS || 15_000);
const HEALTH_MARKERS_CACHE_ENABLED = HEALTH_MARKERS_CACHE_TTL_MS > 0 && process.env.ROBOTDOJO_DB !== ':memory:';
const healthMarkerPayloadCache = new Map();
const healthMarkerPayloadWarmers = new Map();
let healthMarkerPayloadCacheGeneration = 0;

export function getHealthMarkerPayloadCacheEntry(cacheKey) {
  if (!HEALTH_MARKERS_CACHE_ENABLED) return null;
  return healthMarkerPayloadCache.get(cacheKey) || null;
}

export function getFreshHealthMarkerPayload(cacheKey) {
  const cached = getHealthMarkerPayloadCacheEntry(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.createdAt >= HEALTH_MARKERS_CACHE_TTL_MS) return null;
  return cached.payload;
}

export function refreshHealthMarkerPayloadCacheEntry(entry) {
  if (!HEALTH_MARKERS_CACHE_ENABLED || !entry) return;
  entry.createdAt = Date.now();
}

export function setHealthMarkerPayloadCache(cacheKey, { signature, payload }) {
  if (!HEALTH_MARKERS_CACHE_ENABLED) return;
  healthMarkerPayloadCache.set(cacheKey, {
    createdAt: Date.now(),
    signature,
    payload,
  });
}

export function getHealthMarkerPayloadWarmPromise(cacheKey) {
  if (!HEALTH_MARKERS_CACHE_ENABLED) return null;
  return healthMarkerPayloadWarmers.get(cacheKey) || null;
}

export function prewarmHealthMarkerPayloadCache(cacheKey, { signature, buildPayload, onError, delayMs = 0 } = {}) {
  if (!HEALTH_MARKERS_CACHE_ENABLED || !cacheKey || typeof buildPayload !== 'function') return false;
  const cached = getHealthMarkerPayloadCacheEntry(cacheKey);
  if (cached?.signature === signature) return false;
  if (healthMarkerPayloadWarmers.has(cacheKey)) return false;

  const generation = healthMarkerPayloadCacheGeneration;
  const delay = Math.max(0, Number.isFinite(Number(delayMs)) ? Number(delayMs) : 0);
  const warmer = new Promise(resolve => {
    const timer = setTimeout(async () => {
      try {
        const payload = await buildPayload();
        if (generation === healthMarkerPayloadCacheGeneration) {
          setHealthMarkerPayloadCache(cacheKey, { signature, payload });
        }
        resolve(payload);
      } catch (err) {
        if (typeof onError === 'function') onError(err);
        resolve(null);
      } finally {
        if (healthMarkerPayloadWarmers.get(cacheKey) === warmer) {
          healthMarkerPayloadWarmers.delete(cacheKey);
        }
      }
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  });
  healthMarkerPayloadWarmers.set(cacheKey, warmer);
  return true;
}

export function clearHealthMarkerPayloadCache() {
  healthMarkerPayloadCacheGeneration += 1;
  healthMarkerPayloadCache.clear();
  healthMarkerPayloadWarmers.clear();
}
