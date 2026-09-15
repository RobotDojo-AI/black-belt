#!/usr/bin/env node
/**
 * Backwards-compatible entrypoint.
 *
 * Public FAQ data now comes from scripts/generate-public-truth.js. Keep this
 * filename because older hooks and docs still call `npm run bundle-faq`.
 */
import { main } from './generate-public-truth.js';

main();
