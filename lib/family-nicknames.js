/**
 * Family nickname → relation map (Apple Contacts inverse lookup).
 *
 * WHY this exists: Phase 4 Pass 4 (config-driven) iterates `config/family.json`
 * members and tries to find each by canonical name. That fails when the user
 * stored the contact AS the relationship label — e.g. an Apple Contact literally
 * named "Mom" or "Dad" with no first/last name. The inverse direction is what we
 * need: iterate every contact, and if the contact name matches a known
 * relationship nickname, tag the underlying person with the inferred relation.
 *
 * WHY a flat map (not a function with regex / fuzzy logic): nickname → relation
 * is a curated decision per term. Loose matching (e.g. "any string starting with
 * 'mom'") would mis-tag "Mom's friend Helen" or "Tom Smith". Keep it exact and
 * case-insensitive after `.trim().toLowerCase()`.
 *
 * WHY conservative on "spouse": only the literal terms wife / husband / hubby.
 * Apple users often save partners under their first name; we never want to
 * invent a spouse relation from a single ambiguous label. Risk-reward is
 * skewed — a missed spouse tag is a small downside (they get tagged via
 * config/family.json or Miyagi), a false-positive spouse tag is corrosive.
 *
 * WHY "pop pop" / "mom-mom" variants are included: these are common East-Coast
 * grandparent nicknames that show up frequently in Apple Contacts. Coverage
 * over elegance.
 *
 * Pass 4b in scripts/ingest/04-classify.js consumes this. The match runs AFTER
 * Pass 4 (config explicit name) so when both succeed for the same person, the
 * explicit relation wins — this is fallback inference, not authoritative truth.
 */

export const APPLE_NICKNAME_TO_RELATION = {
  // parents
  'mom': 'parent', 'mommy': 'parent', 'mother': 'parent', 'ma': 'parent', 'mama': 'parent',
  'dad': 'parent', 'daddy': 'parent', 'father': 'parent', 'pa': 'parent', 'papa': 'parent',
  // siblings
  'bro': 'sibling', 'brother': 'sibling',
  'sis': 'sibling', 'sister': 'sibling',
  // grandparents
  'grandma': 'grandparent', 'grandmother': 'grandparent', 'gran': 'grandparent', 'granny': 'grandparent', 'nana': 'grandparent', 'gma': 'grandparent',
  'grandpa': 'grandparent', 'grandfather': 'grandparent', 'gramps': 'grandparent', 'gpa': 'grandparent', 'pop pop': 'grandparent', 'mom mom': 'grandparent', 'pop-pop': 'grandparent', 'mom-mom': 'grandparent', 'nonna': 'grandparent', 'nonno': 'grandparent', 'pappy': 'grandparent', 'gigi': 'grandparent',
  // in-laws and kids
  'mil': 'parent-in-law', 'fil': 'parent-in-law', 'sil': 'sibling-in-law', 'bil': 'sibling-in-law',
  // spouse — only if very confident, low risk
  'wife': 'spouse', 'husband': 'spouse', 'hubby': 'spouse',
};

/**
 * Normalize an Apple Contacts display name and return the inferred relation,
 * or null if the name is not a known relationship nickname.
 *
 * Trim + lowercase only; no regex / partial matching. A contact must have one
 * of the literal keys as its full normalized name to match.
 *
 * @param {string|null|undefined} name - raw contact display name
 * @returns {string|null} a FAMILY_TAGS value or null
 */
export function nicknameToRelation(name) {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return APPLE_NICKNAME_TO_RELATION[key] || null;
}
