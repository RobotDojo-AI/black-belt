#!/usr/bin/env node
// Stylize a headshot into the Robot Dojo brand avatar via Gemini 2.5 Flash Image (Nano Banana).
// Usage: node scripts/generate-avatar.js [path/to/photo.jpg]

import fs from 'node:fs';
import { execSync } from 'node:child_process';

// No founder headshot default — require an explicit photo path for generation.
const PHOTO = process.argv[2] || '';
if (!PHOTO) {
  console.error('Usage: node scripts/generate-avatar.js <photo-path>');
  process.exit(1);
}
const OUT = process.env.OUT || 'apps/static/img/robotdojo-mascot.png';
const MODEL = process.env.MODEL || 'gemini-2.5-flash-image';

const apiKey = process.env.GOOGLE_AI_API_KEY ||
  execSync('security find-generic-password -s robotdojo-GOOGLE_API_KEY -w', { encoding: 'utf8' }).trim();

if (!apiKey) { console.error('no GOOGLE_AI_API_KEY'); process.exit(1); }
if (!fs.existsSync(PHOTO)) { console.error('photo not found:', PHOTO); process.exit(1); }

const photoB64 = fs.readFileSync(PHOTO).toString('base64');

const prompt = `Stylize the attached headshot into a friendly robot-mascot avatar. The goal: this avatar should UNMISTAKABLY LOOK LIKE THE PERSON IN THE PHOTO — same face shape, same eyes, same eyebrows, same hair direction/length/part/volume, same stubble pattern, same smile, same expression. Faithfully reproduce their features; do not substitute or generalize. If a feature is in the photo, it is in the avatar. If it isn't in the photo (e.g., hair on the back of the head that isn't visible), it isn't in the avatar.

Do not add any scars, facial marks, lines above the eyes, panel seams on the face, creases, or decorative marks. The face surface stays clean and uninterrupted.

Then apply this brand's art style on top of those faithful features:
- Head fill: soft lavender/pale-blue (#e0e7ff) — this is skin color in this brand, replacing natural skin tone.
- Clean blue outline strokes (#3b82f6), ~3px.
- Thin vertical antenna centered on the top of the head, with a glowing blue ball (#60a5fa) at the tip. Centered above the nose.
- Small rectangular robotic ear plates on the sides of the head (replacing natural ears).
- A couple of small bolts/rivets near the ear plates — light mechanical detailing only. DO NOT add any panel seam lines, creases, or decorative lines on the forehead, above the eyes, on the cheeks, or anywhere on the face. Keep the face surface clean and uninterrupted.
- Eyes keep the person's real color and shape from the photo, just rendered cleanly in flat-vector style with a small white shine highlight and a thin blue circuit ring around the outside.
- Smile is the person's real smile from the photo, rendered as a blue curve with white fill and white teeth.
- Stubble is rendered as the person's real stubble from the photo — as a light speckle of small dark dots across whatever facial areas it covers in the photo (don't invent coverage that isn't there, don't render it as a solid beard).
- Hair is the person's real hair from the photo — same cut, same direction, same part location, same volume, same length. Rendered in flat near-black with a few clean texture lines. DO NOT add hair that isn't visible in the photo (no extra length at the back of the head if the photo is a front-facing portrait).
- Crew-neck t-shirt at the neck/shoulders (same style as the photo's black tee) — render in a flat blue (#1e3a8a deep blue or black, your call — whichever looks cleaner with the lavender face and blue outlines). Simple round crew neck, no collar, no gi.

Style: clean flat vector illustration on a pure white background, square composition. No gradients, no photorealism, no 3D shading. Think flat 2D sticker/emoji style.

Above all: the robot should clearly, instantly read as this specific person — a robot version of them, not a generic robot with some of their features. Use the photo as ground truth for every feature; use the brand rules only for color/outline/stylistic treatment.`;

console.log(`→ ${MODEL}`);
console.log(`  photo: ${PHOTO}`);

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: photoB64 } },
          { text: prompt },
        ],
      }],
    }),
  },
);

if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}

const json = await res.json();
const parts = json?.candidates?.[0]?.content?.parts || [];
let saved = false;
for (const p of parts) {
  if (p.inline_data?.data || p.inlineData?.data) {
    const b64 = p.inline_data?.data || p.inlineData.data;
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log(`✓ saved ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)}KB)`);
    saved = true;
  } else if (p.text) {
    console.log('model text:', p.text.slice(0, 200));
  }
}

if (!saved) {
  console.error('no image in response');
  console.error(JSON.stringify(json, null, 2).slice(0, 1000));
  process.exit(1);
}
