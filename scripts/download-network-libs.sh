#!/bin/bash
# download-network-libs.sh — Refresh the static nickname + surname data files
# checked into config/. Run once on dataset updates (rarely — these change
# every census decade).
#
# Sources:
#   - config/nicknames.json  : carltonnorthern/nicknames CSV transformed into a
#       bidirectional JSON map { name: [equivalents...] }. Bidirectional so
#       the runtime lookup is O(1) (the source CSV is directional).
#   - config/surnames-top-25K.json : Census 2010 surnames, top 25K only,
#       trimmed from FiveThirtyEight's CSV mirror (the official Census file
#       is XLSX-only). Format: { surname: rank }.
#
# WHY top 25K: rank > 25,000 means the surname uniquely identifies a small
# enough cluster that nickname-equivalent merge is safe. Patel (~172),
# Nguyen (~147), Garcia (~8) — all common — fall below the cutoff and are
# correctly excluded from the merge gate.
#
# Story: st_87a0d072 (network-ranking-quality-investigation)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="$REPO_ROOT/config"

NICKNAMES_URL="https://raw.githubusercontent.com/carltonnorthern/nicknames/master/names.csv"
SURNAMES_URL="https://raw.githubusercontent.com/fivethirtyeight/data/master/most-common-name/surnames.csv"

TMP_NICK="$(mktemp)"
TMP_SURN="$(mktemp)"
trap 'rm -f "$TMP_NICK" "$TMP_SURN"' EXIT

echo "[download-network-libs] fetching $NICKNAMES_URL"
curl -sL --max-time 60 -o "$TMP_NICK" "$NICKNAMES_URL"
echo "[download-network-libs] fetching $SURNAMES_URL"
curl -sL --max-time 60 -o "$TMP_SURN" "$SURNAMES_URL"

# Transform nicknames CSV → bidirectional JSON map.
node --input-type=module -e "
import { readFileSync, writeFileSync, statSync } from 'node:fs';
const csv = readFileSync('$TMP_NICK', 'utf8');
const lines = csv.split('\n').slice(1);
const map = {};
for (const line of lines) {
  if (!line.trim()) continue;
  const parts = line.split(',');
  if (parts.length < 3) continue;
  const a = parts[0].toLowerCase().trim();
  const b = parts[2].toLowerCase().trim();
  if (!a || !b || a === b) continue;
  if (!map[a]) map[a] = [];
  if (!map[a].includes(b)) map[a].push(b);
  if (!map[b]) map[b] = [];
  if (!map[b].includes(a)) map[b].push(a);
}
writeFileSync('$CONFIG_DIR/nicknames.json', JSON.stringify(map));
console.log('  nicknames.json:', Object.keys(map).length, 'keys,', statSync('$CONFIG_DIR/nicknames.json').size, 'bytes');
"

# Trim surnames CSV to top 25K and write JSON map { surname: rank }.
node --input-type=module -e "
import { readFileSync, writeFileSync, statSync } from 'node:fs';
const csv = readFileSync('$TMP_SURN', 'utf8');
const lines = csv.split('\n').slice(1);
const result = {};
for (const line of lines) {
  if (!line.trim()) continue;
  const parts = line.split(',');
  const name = parts[0].toLowerCase();
  const rank = parseInt(parts[1], 10);
  if (!name || !Number.isFinite(rank)) continue;
  if (rank > 25000) break;
  if (!(name in result) || rank < result[name]) result[name] = rank;
}
writeFileSync('$CONFIG_DIR/surnames-top-25K.json', JSON.stringify(result));
console.log('  surnames-top-25K.json:', Object.keys(result).length, 'entries,', statSync('$CONFIG_DIR/surnames-top-25K.json').size, 'bytes');
"

echo '[download-network-libs] done'
