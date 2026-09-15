-- Keep the Health dashboard first payload off the encrypted table b-tree.
-- The route reads exactly these columns for every active point in marker/date
-- order, so this partial covering index avoids one table lookup per point.
CREATE INDEX IF NOT EXISTS idx_hdp_active_dashboard_covering
ON health_data_points(marker_id, date, value, source, source_file, source_id, specimen_type)
WHERE excluded = 0;
