-- Canonicalize historical imported health data points that landed under
-- auto-created alias marker IDs before the display-layer canonical map existed.
-- Source IDs remain unchanged so provenance/idempotency is preserved.

CREATE TEMP TABLE health_marker_alias_repair (
  imported_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL
);

INSERT INTO health_marker_alias_repair (imported_id, canonical_id) VALUES
  ('bilirubin_total', 'bilirubin'),
  ('bun_creatinine_ratio', 'bun_creat_ratio'),
  ('calcium_24_hr', 'urine_calcium_24hr'),
  ('co2', 'carbon_dioxide'),
  ('carbon_dioxide_total', 'carbon_dioxide'),
  ('chloride_serum', 'chloride'),
  ('copper_serum_or_plasma', 'copper'),
  ('creatinine_serum_or_plasma', 'creatinine'),
  ('crp_mg_dl', 'hscrp'),
  ('egfr_ckd_epi_2021', 'egfr'),
  ('immunoglobulin_a_qn_serum', 'iga'),
  ('immunoglobulin_g_qn_serum', 'igg'),
  ('immunoglobulin_m_qn_serum', 'igm'),
  ('ldl_c_nih_calc', 'ldl'),
  ('lymphocytes_absolute', 'lymph_abs'),
  ('neutrophils_absolute', 'anc'),
  ('plasma_zinc', 'zinc'),
  ('sex_horm_binding_glob_serum', 'shbg'),
  ('testosterone_serum', 'testosterone'),
  ('testosterone_total_lc_ms', 'testosterone');

UPDATE health_data_points
SET
  marker_id = (
    SELECT canonical_id
    FROM health_marker_alias_repair
    WHERE imported_id = health_data_points.marker_id
  ),
  specimen_type = CASE
    WHEN (
      SELECT canonical_id
      FROM health_marker_alias_repair
      WHERE imported_id = health_data_points.marker_id
    ) LIKE 'urine_%' THEN 'urine_24hr'
    WHEN (
      SELECT canonical_id
      FROM health_marker_alias_repair
      WHERE imported_id = health_data_points.marker_id
    ) LIKE 'serum_%' THEN 'serum'
    ELSE specimen_type
  END
WHERE marker_id IN (SELECT imported_id FROM health_marker_alias_repair)
  AND EXISTS (
    SELECT 1
    FROM health_markers canonical
    WHERE canonical.id = (
      SELECT canonical_id
      FROM health_marker_alias_repair
      WHERE imported_id = health_data_points.marker_id
    )
  );

DROP TABLE health_marker_alias_repair;
