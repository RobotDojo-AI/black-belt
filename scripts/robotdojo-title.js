#!/usr/bin/env node
/**
 * scripts/robotdojo-title.js — st_8745309c follow-on.
 *
 * Thin shell-callable CLI over lib/work-item-title.js.
 *
 * Usage:
 *   node scripts/robotdojo-title.js <story_id>
 *
 * Prints the plain-English title for the story to stdout (no trailing
 * newline-pollution beyond one \n). Exits 0 always — an empty title is
 * a valid result that means "no active story, render label only". The
 * statusLine and tab-title wrappers cannot tolerate stderr noise or
 * non-zero exits, so any failure path returns an empty title silently.
 */
import { workItemTitle } from '../lib/work-item-title.js';

const storyId = process.argv[2];
try {
  const title = workItemTitle(storyId);
  // Single println; the shell wrappers strip trailing newline already.
  process.stdout.write(title + '\n');
  process.exit(0);
} catch {
  // Defensive: any unexpected throw must not break terminal rendering.
  process.stdout.write('\n');
  process.exit(0);
}
