-- Fixes "edit user" changes not saving.
--
-- The app authenticates with its own JWT (not Supabase Auth) and talks to
-- Supabase using the anon key, so Row Level Security on the users table
-- blocks the UPDATE from src/routes/auth.js (PUT /api/auth/users/:id) even
-- though the request passes the app's own admin check. This matches the
-- pattern used for the other app-managed tables (notifications,
-- activity_log, category_settings, etc.) which all have RLS disabled.

ALTER TABLE users DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
