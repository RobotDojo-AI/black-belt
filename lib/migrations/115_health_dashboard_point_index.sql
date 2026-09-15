-- Speed up the Health dashboard's canonical point read:
-- active points, grouped by marker, in date order.
CREATE INDEX IF NOT EXISTS idx_hdp_active_marker_date
ON health_data_points(marker_id, date)
WHERE excluded = 0;
