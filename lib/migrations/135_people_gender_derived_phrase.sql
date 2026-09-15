-- 135_people_gender_derived_phrase.sql — gender as a person-node property +
-- the derived-relation phrase cache column (st_f67bc2eb D3/D5).
--
-- GEDCOM X models gender as a property of the Person node; mother vs father is
-- never stored — it derives from the parent edge + the parent node's gender at
-- render. This migration gives the node that property. NULL = unknown; a NULL
-- gender renders the genderless tag phrase, never a guessed one.
--
-- species: the same store-the-fact-derive-the-value normal form for pets.
-- The predecessor's "Dog: Biscuit" rendering carried species inside
-- relation_label; after the truth swap relation_label is a walker-derived
-- cache (gendered from node gender), so species must live on the node or be
-- lost. Closed set (dog|cat), code-validated like gender.
--
-- relation_derived_phrase: the exact multi-hop walk phrase ("wife's cousin")
-- the six existing readers upgrade to. NULL when tag+label already express the
-- full role. One truth, two precisions, never two truths.
ALTER TABLE people ADD COLUMN gender TEXT CHECK (gender IN ('male','female'));
ALTER TABLE people ADD COLUMN species TEXT CHECK (species IN ('dog','cat'));
ALTER TABLE people ADD COLUMN relation_derived_phrase TEXT;

-- Backfill the node facts already implied by existing gendered labels — the
-- label was always a (relation class x gender) denormalization; recover the
-- gender half onto the node where it belongs.
UPDATE people SET gender = 'female'
 WHERE gender IS NULL
   AND relation_label IN ('mother','mother-in-law','sister','sister-in-law','grandmother','wife','daughter');
UPDATE people SET gender = 'male'
 WHERE gender IS NULL
   AND relation_label IN ('father','father-in-law','brother','brother-in-law','grandfather','husband','son');
UPDATE people SET species = relation_label
 WHERE species IS NULL AND relation_tag = 'pet' AND relation_label IN ('dog','cat');
