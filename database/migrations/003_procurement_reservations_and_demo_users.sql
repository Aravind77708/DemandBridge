ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_available_capacity_nonnegative
  CHECK (available_capacity >= 0) NOT VALID;

ALTER TABLE order_allocations
  ADD CONSTRAINT order_allocations_quantity_positive
  CHECK (quantity > 0) NOT VALID;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- Prior JSON-backed releases persisted allocations without reducing available capacity.
-- Carry those committed/reserved quantities forward, clamping at zero rather than dropping records.
WITH reserved AS (
  SELECT supplier_id, SUM(quantity) AS quantity
    FROM order_allocations
   GROUP BY supplier_id
)
UPDATE suppliers AS s
   SET available_capacity = GREATEST(0, s.available_capacity - reserved.quantity)
  FROM reserved
 WHERE reserved.supplier_id = s.id;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_case_insensitive_idx
  ON users(lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_one_per_demand_idx
  ON purchase_orders(demand_id);

CREATE INDEX IF NOT EXISTS suppliers_available_capacity_idx
  ON suppliers(available_capacity, id)
  WHERE verified = true AND available_capacity > 0;
