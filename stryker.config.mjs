/**
 * StrykerJS mutation testing configuration.
 *
 * WHY: Mutation testing measures how well the test suite catches real bugs.
 * Each mutation is a small semantic change (e.g. `>` → `>=`, `&&` → `||`).
 * A test suite that kills every mutant has no blind spots.
 *
 * Threshold: { high: 0, low: 0, break: 0 } — first run establishes baseline.
 * No failures on first run. Raise thresholds as coverage improves (st_175d5524).
 *
 * Test runner: 'tap' — uses @stryker-mutator/tap-runner which understands
 * Node's built-in test runner TAP output. Configured via tap.nodeArgs to
 * invoke `node --test` on each mutated test file.
 *
 * Run: npm run mutation
 */

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  testRunner: 'tap',

  // tap-runner configuration: use node:test (built-in, no extra deps)
  tap: {
    // testFiles: which tests to run against each mutant
    testFiles: ['tests/*.test.js'],
    // nodeArgs: additional flags passed to node when running test files
    // node:test is invoked as: node --test <testFile>
    nodeArgs: ['--test'],
  },

  // Which source files to mutate
  mutate: [
    'lib/**/*.js',
    'routes/**/*.js',
    '!lib/migrations/**',
  ],

  // Thresholds: break:0 means first run never fails regardless of score.
  // Raise break to enforce a minimum mutation score on future stories.
  thresholds: {
    high: 0,
    low: 0,
    break: 0,
  },

  reporters: ['clear-text', 'html'],

  // coverageAnalysis: off — not needed for baseline. Saves run time.
  coverageAnalysis: 'off',

  // plugins: tap-runner must be registered explicitly
  plugins: ['@stryker-mutator/tap-runner'],
};
