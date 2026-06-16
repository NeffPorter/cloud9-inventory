const { createClient } = require('@supabase/supabase-js');

// Uses the service role key so RLS is bypassed entirely on all tables.
// This key must stay server-side only (Railway env vars) — never expose it
// in browser code or public repos.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = supabase;
