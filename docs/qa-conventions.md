# scripts/qa/

Playwright + browser QA infrastructure.

## Affected-specs map sync

When a story adds a new Playwright spec, a new `apps/` path, or a new route file under `routes/`, update `scripts/qa/affected-specs.json` in the same commit. This file maps source path prefixes to Playwright spec filenames — if a new path isn't in the map, the spec won't run for targeted stories and the affected-test selector will silently skip it.

Route files that handle auth-gated endpoints need at least `auth-gates.spec.js` mapped; route files with a corresponding UI page need the page spec too.

## Playwright spec location

All Playwright specs go in `scripts/qa/tests/` — this is the `testDir` in `playwright.config.js`. Never create specs in `scripts/qa/specs/` (that directory does not exist). Plans specifying `scripts/qa/specs/` are wrong; Katagami places the file in `scripts/qa/tests/` regardless of what the plan says. Root cause: st_120fdf3b plan wrote `scripts/qa/specs/` without reading `playwright.config.js`.

## Local-server URL

`baseURL` in `playwright.config.js` and `BASE_URL` in `tests/env.js` must use `https://localhost:4338`, not `http://`. Using `http://` causes "Cannot navigate to invalid URL" for every `page.goto()` with a relative path.
