/**
 * About RobotDojo data assembly for the Admin tab inline row.
 * Story st_d9fc573b — AC 2.
 *
 * WHY a separate lib module: keeps routes/accounts.js thin and lets the
 * About data shape be unit-tested without spinning up a Hono request.
 *
 * No DB. No LLM. Reads package.json (injected) + a constant GitHub URL.
 */

const GITHUB_URL = 'https://github.com/RobotDojo-AI/black-belt';

/**
 * Resolve the build date from (in order):
 *   1. process.env.BUILD_DATE (set by install/deploy automation)
 *   2. package.json.buildDate field (if present)
 *   3. Today (server boot fallback — gives a sensible value even on a
 *      freshly cloned dev checkout where neither env nor package field is set)
 *
 * Returns a YYYY-MM-DD string. Never null.
 */
function resolveBuildDate(pkg) {
  if (process.env.BUILD_DATE) return process.env.BUILD_DATE;
  if (pkg && typeof pkg.buildDate === 'string') return pkg.buildDate;
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns the About RobotDojo info object as a single inline row payload.
 *
 * @param {{ version?: string, license?: string, buildDate?: string }} pkg
 *   The parsed package.json contents. Injected to keep this module pure.
 * @returns {{ version: string, build_date: string, github_url: string, license: string }}
 */
export function getAboutInfo(pkg) {
  const version = (pkg && pkg.version) || '0.0.0';
  const license = (pkg && pkg.license) || 'MIT';
  return {
    version,
    build_date: resolveBuildDate(pkg),
    github_url: GITHUB_URL,
    license,
  };
}
