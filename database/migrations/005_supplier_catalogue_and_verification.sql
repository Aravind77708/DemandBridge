ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS verification_status TEXT,
  ADD COLUMN IF NOT EXISTS verification_reason TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE suppliers
   SET verification_status = CASE WHEN verified THEN 'approved' ELSE 'pending' END
 WHERE verification_status IS NULL;

ALTER TABLE suppliers
  ALTER COLUMN verification_status SET DEFAULT 'pending',
  ALTER COLUMN verification_status SET NOT NULL,
  ADD CONSTRAINT suppliers_verification_status_valid
    CHECK (verification_status IN ('pending','approved','rejected')) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_owner_user_unique_idx
  ON suppliers(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS suppliers_verification_status_idx
  ON suppliers(verification_status, id);

CREATE TABLE IF NOT EXISTS supplier_products (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  product_name TEXT NOT NULL,
  category TEXT NOT NULL,
  quality_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  unit TEXT NOT NULL,
  unit_price NUMERIC(14,2) NOT NULL,
  minimum_order_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
  available_capacity NUMERIC(14,2) NOT NULL DEFAULT 0,
  lead_days INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','approved','rejected')),
  verification_reason TEXT,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (unit_price >= 0),
  CHECK (minimum_order_quantity >= 0),
  CHECK (available_capacity >= 0),
  CHECK (lead_days >= 0)
);

ALTER TABLE order_allocations
  ADD COLUMN IF NOT EXISTS supplier_product_id TEXT REFERENCES supplier_products(id),
  ADD COLUMN IF NOT EXISTS product_name TEXT,
  ADD COLUMN IF NOT EXISTS unit TEXT;

CREATE INDEX IF NOT EXISTS supplier_products_supplier_status_idx
  ON supplier_products(supplier_id, verification_status, product_name);
CREATE INDEX IF NOT EXISTS supplier_products_verified_capacity_idx
  ON supplier_products(verification_status, available_capacity)
  WHERE verification_status = 'approved' AND available_capacity > 0;

-- Preserve old, explicitly supplied catalog names as pending review entries.
-- No legacy catalog entry is automatically approved by this migration.
INSERT INTO supplier_products (
  id, supplier_id, product_name, category, quality_attributes, unit, unit_price,
  minimum_order_quantity, available_capacity, lead_days, verification_status
)
SELECT 'SP-LEGACY-' || md5(s.id || ':' || catalog.ordinality::text),
       s.id, btrim(catalog.product_name), s.category, s.quality_attributes,
       s.capacity_unit, s.unit_price, s.minimum_order_quantity,
       s.available_capacity, s.lead_days, 'pending'
  FROM suppliers AS s
 CROSS JOIN LATERAL unnest(s.products) WITH ORDINALITY AS catalog(product_name, ordinality)
 WHERE btrim(catalog.product_name) <> ''
ON CONFLICT (id) DO NOTHING;
