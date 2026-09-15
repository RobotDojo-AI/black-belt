#!/usr/bin/env node
/**
 * One observational pass over the owner's writing pile.
 * Compounds owner voice.md in the background. Never Miyagi.
 */
import { maybeLearnOwnerVoice } from '../lib/writing-learn.js';

const r = await maybeLearnOwnerVoice();
process.stdout.write(`${r.reason} learned=${!!r.learned} new=${r.newChars} next=${r.nextChars} empty=${r.consecutiveEmpty}\n`);
process.exit(0);
