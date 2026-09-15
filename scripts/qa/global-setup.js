/**
 * Playwright globalSetup — runs once before all specs.
 *
 * Currently a no-op (auth + cookie are handled per-spec via env.js).
 * Kept as a hook point for future cross-spec fixtures (e.g., per-suite
 * test DB seeding).
 */
export default async function globalSetup() {
  // Intentionally empty — see scripts/qa/tests/env.js for per-spec setup.
}
