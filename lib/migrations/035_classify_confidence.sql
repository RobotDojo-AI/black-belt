-- Track classification confidence so the nightly reclassifier knows which
-- files to revisit. Files with low confidence get re-classified by Haiku
-- and moved to a better T1/T2 if the guess improves.
ALTER TABLE drop_folder_files ADD COLUMN classify_confidence REAL;
