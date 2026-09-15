/**
 * st_24c158ae — module loader that wraps config/sla.js#assertTTFT to count
 * invocations. Paired with sla-coverage-hook.js (registered via NODE_OPTIONS
 * --import).
 *
 * Strategy: when Node resolves an import of config/sla.js, this loader
 * intercepts the load and synthesizes a tiny shim module that re-exports
 * the real assertTTFT through a wrapper. The wrapper increments the
 * global counter on the parent process (set by sla-coverage-hook.js).
 */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith('/config/sla.js')) {
    return { ...resolved, format: 'module', shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('/config/sla.js')) {
    // Load the real module and wrap its exports.
    const real = await nextLoad(url, context);
    // The real source is in real.source (string or Buffer). Append a wrapper
    // that re-exports assertTTFT through a counter.
    const realSource = real.source.toString();
    const wrapped = `
${realSource}

// st_24c158ae coverage hook — increment counter on every call.
const __assertTTFT_real = assertTTFT;
export { __assertTTFT_real };

const __wrappedAssertTTFT = function (elapsedMs, kind) {
  if (typeof globalThis.__sla_assert_count === 'number') {
    globalThis.__sla_assert_count++;
    if (Array.isArray(globalThis.__sla_assert_calls)) {
      globalThis.__sla_assert_calls.push({ elapsedMs, kind });
    }
  }
  return __assertTTFT_real(elapsedMs, kind);
};

// Replace the export by reassigning the binding through a module-level
// proxy. We can't change a const re-export, so the consumer must rely on
// the loader-injected hook. To preserve the original binding semantics,
// callers import { assertTTFT } — which Node resolves to the original
// function. We re-export the wrapped version under the same name via
// a trick: rewrite the module to be the wrapped version.
`;
    // Simpler approach: synthesize a NEW module that imports from the real
    // url-suffixed-once-removed and re-exports the wrapped function.
    // But we already loaded real.source. Replace the export of assertTTFT.
    const rewritten = realSource.replace(
      /export function assertTTFT\(/,
      'function __assertTTFT_orig(',
    ) + `

// Coverage hook (st_24c158ae).
export function assertTTFT(elapsedMs, kind) {
  if (typeof globalThis.__sla_assert_count === 'number') {
    globalThis.__sla_assert_count++;
    if (Array.isArray(globalThis.__sla_assert_calls)) {
      globalThis.__sla_assert_calls.push({ elapsedMs, kind });
    }
  }
  return __assertTTFT_orig(elapsedMs, kind);
}
`;
    return { format: 'module', source: rewritten, shortCircuit: true };
  }
  return nextLoad(url, context);
}
