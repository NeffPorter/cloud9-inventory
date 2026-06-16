-- Locks down all app tables so they are NOT accessible via the Supabase
-- REST API using the anon key. The backend now uses the service role key
-- (SUPABASE_SERVICE_KEY in Railway env vars), which bypasses RLS entirely,
-- so no permissive policies are needed — RLS on + no policies = anon key
-- gets nothing, service key gets everything.
--
-- Run this in the Supabase SQL editor.

ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores                ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE distributors          ENABLE ROW LEVEL SECURITY;
ALTER TABLE distributor_prices    ENABLE ROW LEVEL SECURITY;
ALTER TABLE distributor_lead_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_budgets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_invoices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_take_reports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_take_drafts     ENABLE ROW LEVEL SECURITY;

-- Run this if store_settings table exists in your project
-- ALTER TABLE store_settings ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
