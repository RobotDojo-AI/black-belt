#!/usr/bin/env node
/**
 * scripts/check-profile-retired.js
 *
 * Guard: fail if `the retired profile target` is recreated on disk.
 *
 * WHY (st_0c491456 Phase 1f): the retired profile target was the original identity
 * injection target. It opened with two `<!-- include: -->` voice/formatting
 * fragments (~5745 chars) that consumed the entire 4000-char identity
 * budget before reaching the owner's actual name, family, or career —
 * leaving chat blind to the user. The fix moved identity to
 * `wk_user/context.md` (chat-injected distillation) and `wk_user/USER.md`
 * (deep IDE companion). This gate prevents accidental recreation of the
 * old file path by any synthesis script, restore, or manual write —
 * recreation would silently bypass the new injection path and re-introduce
 * the original starvation bug because identity-card.js no longer reads it.
 *
 * Exit 0 = profile.md absent (clean).
 * Exit 1 = profile.md present (recreation detected).
 *
 * Wire to pre-commit via scripts/pre-commit.sh.
 */

import { existsSync } from 'node:fs';
import { USER_ROOT } from '../lib/robotdojo-paths.js';
import { join } from 'node:path';

const PROFILE_PATH = join(USER_ROOT, 'profile.md');

if (existsSync(PROFILE_PATH)) {
  console.error(`check-profile-retired: FAIL — ${PROFILE_PATH} exists.`);
  console.error('the retired profile target was retired in st_0c491456 (Phase 1).');
  console.error('Identity injection lives in user/workbenches/user/wk_user/context.md.');
  console.error('Deep companion lives in user/workbenches/user/wk_user/USER.md.');
  console.error('Delete the retired profile target to clear this gate.');
  process.exit(1);
}

process.exit(0);
