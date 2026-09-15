/**
 * st_24c158ae — node --import loader hook that wraps config/sla.js#assertTTFT
 * with a call counter. Registered via NODE_OPTIONS by check-sla-coverage.js.
 *
 * On every assertTTFT call, increments globalThis.__sla_assert_count. On
 * process exit, writes /tmp/sla-coverage-<basename>.json so the coverage
 * gate can read the count back from the parent process.
 *
 * Why a loader hook (not direct import): the test files import assertTTFT
 * from config/sla.js. We need to intercept those imports at load time,
 * replace the exported function with a wrapper that increments the counter,
 * then forward to the original. Node's --import flag runs this file before
 * any user-space module loads, so by the time test files execute, the
 * wrapped version is what they import.
 */
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.__sla_assert_count = 0;
globalThis.__sla_assert_calls = [];

// Initialize the loader hook that rewrites config/sla.js imports.
register('./sla-coverage-loader.js', import.meta.url);

// Persist the counter on process exit so the parent (check-sla-coverage.js)
// can read it via the JSON file. process.argv[1] is the test file path.
process.on('exit', () => {
  const testFile = process.argv[1] || 'unknown';
  const outPath = `/tmp/sla-coverage-${basename(testFile)}.json`;
  try {
    writeFileSync(outPath, JSON.stringify({
      test_file: testFile,
      assert_count: globalThis.__sla_assert_count,
      calls: globalThis.__sla_assert_calls.slice(0, 100),
    }));
  } catch { /* ignore */ }
});

export {};
