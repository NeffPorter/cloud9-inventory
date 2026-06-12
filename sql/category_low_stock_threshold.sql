-- Adds a per-category low stock threshold used by the inventory page
-- (Low Stock bubble/popup and the row highlight color) and shown in the
-- Purchase Planner next to the Buffer Days setting.

ALTER TABLE category_settings
  ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5;
