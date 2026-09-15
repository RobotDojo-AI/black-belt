/**
 * lib/criteria-lint.js
 *
 * Plan-seal linter for the machine-verifiable criteria commands. story-gate.js
 * calls lintCriteriaCommands() inside validateStageSeal's `plan` branch (after
 * parseCriteria); any returned violation BLOCKS the seal naming the offending
 * probe. The whole point (st_a5baa72c AC4): catch non-portable / silently-
 * false-passing probes at PLAN-SEAL, not after they ship and fail or
 * false-pass at QA.
 *
 * Each banned class below is sourced from agents/build-conventions.md
 * (Criteria-Runner Discipline + Security Model), which is the authoritative
 * list of probes that are genuinely broken:
 *
 *   1. `readlink -e`        — GNU-only; macOS lacks it. check-agent-os.js uses
 *                             realpathSync for exactly this reason. A probe
 *                             using it silently fails on the owner's Mac.
 *   2. `… -c … | grep '^0$'` — the tautological false-fail shape: a count
 *                             piped to grep '^0$' passes whenever the count is
 *                             zero, which is the failure state — it "passes" by
 *                             not-finding, so a real regression reads as green.
 *   3. hardcoded 40/64-hex  — a literal git sha / sha256 embedded in the
 *                             command rots the instant the artifact changes.
 *   4. bare existence/marker — `grep -q "<marker>" <file>` as the WHOLE command
 *      grep             is existence-only: it proves a string the build itself
 *                             wrote is present, not that any behavior works.
 *   5. stale DB path        — ~/robotdojo/user/databases/robotdojo.db is the
 *                             240MB leftover frozen 2026-06-01; any criterion
 *                             referencing it silently passes. Live DB is
 *                             ~/.robotdojo/robotdojo.db (lib/db.js default).
 *   6. banned api-key path  — ~/.robotdojo/api-key is forbidden; keys come from
 *                             the centralized Keychain helper.
 *   7. /health grepped 'ok' — /health is an HTML dashboard with no "ok" string;
 *                             /api/server-health is the JSON one. Grepping
 *                             /health for ok always fails (or matches stray
 *                             HTML) — wrong endpoint.
 *
 * Precision contract (the failure mode this module must NOT have): the deny-list
 * matches the command INVOKING the broken tool, never a probe that merely greps
 * a file which happens to MENTION the pattern. The portable/behavioral forms
 * used in real plans (`node --test …`, `! rg -q '…' || true`, real runtime
 * curls against /api/server-health) must produce ZERO violations. Every regex
 * below is anchored to the structural shape of the broken probe, not a loose
 * substring. The criteria-lint.test.js clean-case fixtures lock this in.
 */

// Each rule: { id, label, test(command) → boolean }. test() returns true when
// the command is the broken shape. Keep tests narrow and shape-anchored.
const RULES = [
  {
    id: 'gnu-readlink-e',
    label: 'GNU-only `readlink -e` (non-portable on macOS — use realpath / node realpathSync)',
    // Match the flag invocation `readlink -e` / `readlink -ef` etc., where -e is
    // a real flag (preceded by whitespace, a leading dash run). Do NOT match a
    // string literal that contains the text inside quotes being grepped FOR.
    test: (cmd) => /(^|[\s;&|(])readlink\s+-\w*e\w*\b/.test(cmd),
  },
  {
    id: 'count-grep-zero-falsefail',
    label: "tautological false-fail: a `-c` count piped to `grep '^0$'` passes on the failure state",
    // `<something> -c <...> | grep '^0$'` — the count flag (rg -c / grep -c /
    // grep -ic) feeding a pipe whose right side is grep for an exact zero line.
    test: (cmd) =>
      /-i?c\b/.test(cmd) &&
      /\|\s*grep\b[^|]*(['"]?)\^0\$\1/.test(cmd),
  },
  {
    id: 'hardcoded-sha',
    label: 'hardcoded git-sha / sha256 literal embedded in the probe (rots on the next artifact change)',
    // A standalone 40-hex (git sha) or 64-hex (sha256) run, bounded by
    // non-hex/word edges so we don't match inside a longer hex/identifier.
    test: (cmd) => /(^|[^0-9a-fA-F])[0-9a-f]{40}([^0-9a-fA-F]|$)/.test(cmd) ||
                   /(^|[^0-9a-fA-F])[0-9a-f]{64}([^0-9a-fA-F]|$)/.test(cmd),
  },
  {
    id: 'stale-db-path',
    label: 'stale DB path ~/robotdojo/user/databases/robotdojo.db (240MB leftover frozen 2026-06-01 — criterion silently passes; live DB is ~/.robotdojo/robotdojo.db)',
    // Corrected 2026-06-09: the guard was previously inverted, banning the LIVE
    // ~/.robotdojo/robotdojo.db (lib/db.js default, ~6.3GB, the path the running
    // server holds open — verified via lsof). The actual stale leftover is
    // ~/robotdojo/user/databases/robotdojo.db. Match the user/databases segment
    // regardless of home-prefix spelling; anchored on user/databases + filename
    // so it cannot match the live ~/.robotdojo path.
    test: (cmd) => /user\/databases\/robotdojo\.db\b/.test(cmd),
  },
  {
    id: 'banned-api-key-path',
    label: 'banned ~/.robotdojo/api-key path (keys come from the centralized Keychain helper)',
    test: (cmd) => /\.robotdojo\/api-key\b/.test(cmd),
  },
  {
    id: 'health-grep-ok',
    label: "/health grepped for 'ok' (wrong endpoint — /health is an HTML dashboard; use /api/server-health)",
    // The command hits /health (NOT /api/server-health) AND greps for ok.
    // Require /health as a path segment not immediately preceded by
    // `server-` and not part of `/api/server-health`.
    test: (cmd) =>
      /\/health(\b|["'\/?])/.test(cmd) &&
      !/\/api\/server-health/.test(cmd) &&
      !/server-health/.test(cmd) &&
      /\bgrep\b[^|]*\bok\b/i.test(cmd),
  },
  {
    id: 'bare-existence-grep',
    label: 'bare existence/marker grep used as the whole probe (proves a string is present, not that behavior works)',
    // The ENTIRE command is a single `grep -q "<literal>" <file>` (optionally
    // `&& echo ok`). No pipe, no test runner, no second behavioral stage.
    // A real probe runs code and asserts an EFFECT; this only asserts a marker
    // the build itself wrote. We require: starts with grep -q, a quoted literal
    // (no regex metacharacters that would indicate a computed/behavioral
    // pattern), a file arg, and nothing else of substance.
    test: (cmd) => {
      const stripped = cmd.replace(/\s*&&\s*echo\s+\S+\s*$/, '').trim();
      // Single grep -q with a quoted plain literal + a file path, nothing piped.
      if (/[|]/.test(stripped)) return false;
      const m = stripped.match(/^grep\s+(?:-[a-zA-Z]+\s+)*-q\s+(['"])(.+?)\1\s+\S+$/);
      if (!m) return false;
      const literal = m[2];
      // If the literal looks like a real regex assertion (anchors, char classes,
      // alternation, counts), treat it as behavioral, not a bare marker.
      if (/[\^\$\[\]\(\)\{\}\+\*\\]|\|/.test(literal)) return false;
      return true;
    },
  },
];

/**
 * lintCriteriaCommands(parsed) → Array<{description, command, violation}>
 *
 * parsed: the array from parseCriteria() — {description, command} pairs.
 * Returns one entry per (criterion × matched rule). Empty array = clean.
 */
export function lintCriteriaCommands(parsed) {
  const violations = [];
  for (const { description, command } of parsed || []) {
    if (!command) continue;
    for (const rule of RULES) {
      if (rule.test(command)) {
        violations.push({ description, command, violation: rule.label, rule: rule.id });
      }
    }
  }
  return violations;
}

// Exposed for tests / introspection.
export const CRITERIA_LINT_RULES = RULES.map((r) => ({ id: r.id, label: r.label }));
