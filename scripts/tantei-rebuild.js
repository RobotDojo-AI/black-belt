#!/usr/bin/env node
/**
 * Tantei — Network rebuild from source. Entry point wrapper.
 *
 * Phases live in scripts/rebuild/*.js. This file is a thin shim so existing
 * npm scripts / launchd jobs that invoke `node scripts/tantei-rebuild.js`
 * keep working without modification.
 */
import { runRebuild } from './rebuild/index.js';

runRebuild().catch((err) => {
  console.error('\n[tantei-rebuild] FAILED:', err);
  console.error(err.stack);
  process.exit(1);
});
