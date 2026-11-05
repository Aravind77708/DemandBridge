ALTER TABLE demands
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS quality_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS products TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS quality_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS minimum_order_quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capacity_unit TEXT NOT NULL DEFAULT 'kg',
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

ALTER TABLE demands
  ADD CONSTRAINT demands_matching_coordinates_pair
    CHECK ((latitude IS NULL) = (longitude IS NULL)) NOT VALID,
  ADD CONSTRAINT demands_matching_latitude_range
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90) NOT VALID,
  ADD CONSTRAINT demands_matching_longitude_range
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180) NOT VALID;

ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_matching_coordinates_pair
    CHECK ((latitude IS NULL) = (longitude IS NULL)) NOT VALID,
  ADD CONSTRAINT suppliers_matching_latitude_range
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90) NOT VALID,
  ADD CONSTRAINT suppliers_matching_longitude_range
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180) NOT VALID,
  ADD CONSTRAINT suppliers_matching_moq_nonnegative
    CHECK (minimum_order_quantity >= 0) NOT VALID;

CREATE INDEX IF NOT EXISTS suppliers_product_catalog_gin_idx ON suppliers USING GIN (products);
CREATE INDEX IF NOT EXISTS suppliers_category_verified_idx ON suppliers(category, verified);
