-- Required for the sales_log upsert (onConflict: 'store_id,order_id,type')
-- used in src/routes/sales.js to dedupe near-simultaneous webhook events.
-- Without this constraint, every insert fails with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"

-- Step 1: remove any pre-existing duplicate (store_id, order_id, type) rows,
-- keeping the oldest one of each group. Safe to run even if there are none.
DELETE FROM sales_log a
USING sales_log b
WHERE a.id > b.id
  AND a.store_id = b.store_id
  AND a.order_id = b.order_id
  AND a.type = b.type;

-- Step 2: add the unique constraint the upsert relies on.
ALTER TABLE sales_log
  ADD CONSTRAINT sales_log_store_order_type_unique
  UNIQUE (store_id, order_id, type);
