#!/usr/bin/env node
// Surgical edit of the approved avatar: keep everything except the specified change.
// Usage: node scripts/edit-avatar.js "move the scar to ..."

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const INPUT = process.env.INPUT || 'apps/static/img/robotdojo-mascot.png';
const OUT = process.env.OUT || 'apps/static/img/robotdojo-mascot.png';
const MODEL = process.env.MODEL || 'gemini-2.5-flash-image';
const EDIT = process.argv.slice(2).join(' ');

if (!EDIT) { console.error('usage: node scripts/edit-avatar.js "edit description"'); process.exit(1); }

const apiKey = process.env.GOOGLE_AI_API_KEY ||
  execSync('security find-generic-password -s robotdojo-GOOGLE_API_KEY -w', { encoding: 'utf8' }).trim();

const b64 = fs.readFileSync(INPUT).toString('base64');

const prompt = `Edit the attached robot-avatar image. Keep EVERYTHING in the image identical to the input — same face shape, same colors, same outlines, same hair (every strand in the same position), same eyes, same eyebrows (same position and shape), same stubble pattern, same t-shirt, same antenna, same pose, same background, same style, same dimensions. Do not regenerate from scratch. Do not redraw the image. Preserve the exact input pixels wherever possible.

The ONLY change: ${EDIT}

Output the edited image — identical to the input in every other respect.`;

console.log(`→ ${MODEL}  edit: ${EDIT.slice(0, 80)}`);

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/png', data: b64 } },
          { text: prompt },
        ],
      }],
    }),
  },
);

if (!res.ok) { console.error('HTTP', res.status, await res.text()); process.exit(1); }

const json = await res.json();
for (const p of json?.candidates?.[0]?.content?.parts || []) {
  const data = p.inline_data?.data || p.inlineData?.data;
  if (data) {
    fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
    console.log(`✓ saved ${OUT} (${(fs.statSync(OUT).size/1024).toFixed(1)}KB)`);
    process.exit(0);
  } else if (p.text) console.log('model text:', p.text.slice(0, 200));
}
console.error('no image in response');
process.exit(1);
