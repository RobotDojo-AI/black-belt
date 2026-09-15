-- df_f9812d29 — remove the in-chat relationship-confirmation surface.
-- Drop the 'confirm_people' onboarding tile row on existing installs. The
-- seed block in lib/db.js is removed in the same change, so once this DELETE
-- runs the row does not return (SQL migrations run BEFORE inline migrate()
-- seeds). The candidate queue and its mining pipeline are untouched.
DELETE FROM setup_steps WHERE step = 'confirm_people';
