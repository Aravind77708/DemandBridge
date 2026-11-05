-- Current PostgreSQL schema. Applied through the versioned SQL files in migrations/.
-- Migrations are additive; do not edit already-applied migration files.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Buyer','Supplier','Procurement Manager','Logistics Provider','Administrator')),
  password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_demo BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_case_insensitive_idx ON users(lower(email));
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, location TEXT NOT NULL,
  rating NUMERIC(2,1) NOT NULL DEFAULT 0, available_capacity NUMERIC(14,2) NOT NULL DEFAULT 0,
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0, lead_days INTEGER NOT NULL DEFAULT 0,
  products TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  quality_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  minimum_order_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
  capacity_unit TEXT NOT NULL DEFAULT 'kg',
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  owner_user_id UUID REFERENCES users(id),
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','approved','rejected')),
  verification_reason TEXT, reviewed_by UUID REFERENCES users(id), reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (available_capacity >= 0), CHECK (minimum_order_quantity >= 0),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  verified BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_owner_user_unique_idx ON suppliers(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS suppliers_verification_status_idx ON suppliers(verification_status,id);
CREATE TABLE IF NOT EXISTS supplier_products (
  id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  product_name TEXT NOT NULL, category TEXT NOT NULL,
  quality_attributes JSONB NOT NULL DEFAULT '{}'::jsonb, unit TEXT NOT NULL,
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  minimum_order_quantity NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (minimum_order_quantity >= 0),
  available_capacity NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (available_capacity >= 0),
  lead_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_days >= 0),
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','approved','rejected')),
  verification_reason TEXT, reviewed_by UUID REFERENCES users(id), reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_products_supplier_status_idx ON supplier_products(supplier_id,verification_status,product_name);
CREATE INDEX IF NOT EXISTS supplier_products_verified_capacity_idx ON supplier_products(verification_status,available_capacity)
  WHERE verification_status = 'approved' AND available_capacity > 0;
CREATE TABLE IF NOT EXISTS demands (
  id TEXT PRIMARY KEY, buyer_name TEXT NOT NULL, item TEXT NOT NULL,
  quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0), unit TEXT NOT NULL,
  destination TEXT NOT NULL, due_date DATE NOT NULL, status TEXT NOT NULL,
  category TEXT, quality_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  buyer_user_id UUID REFERENCES users(id),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY, demand_id TEXT NOT NULL REFERENCES demands(id),
  total NUMERIC(16,2) NOT NULL DEFAULT 0, status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), item TEXT, quantity NUMERIC(14,2)
);
CREATE TABLE IF NOT EXISTS order_allocations (
  id BIGSERIAL PRIMARY KEY, order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id), quantity NUMERIC(14,2) NOT NULL,
  unit_price NUMERIC(14,2) NOT NULL, supplier_name TEXT,
  lead_days INTEGER NOT NULL DEFAULT 0, subtotal NUMERIC(16,2) NOT NULL DEFAULT 0,
  supplier_product_id TEXT REFERENCES supplier_products(id), product_name TEXT, unit TEXT,
  CHECK (quantity > 0)
);
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES purchase_orders(id), carrier TEXT NOT NULL,
  status TEXT NOT NULL, origin TEXT, destination TEXT NOT NULL, eta DATE
);
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY, action TEXT NOT NULL, entity TEXT NOT NULL,
  happened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demands_status_idx ON demands(status);
CREATE INDEX IF NOT EXISTS demands_buyer_user_created_idx ON demands(buyer_user_id,created_at DESC,id DESC) WHERE buyer_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_status_idx ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS audit_happened_at_idx ON audit_events(happened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_one_per_demand_idx ON purchase_orders(demand_id);
CREATE INDEX IF NOT EXISTS suppliers_available_capacity_idx ON suppliers(available_capacity, id)
  WHERE verified = true AND available_capacity > 0;
CREATE INDEX IF NOT EXISTS suppliers_product_catalog_gin_idx ON suppliers USING GIN (products);
CREATE INDEX IF NOT EXISTS suppliers_category_verified_idx ON suppliers(category, verified);
