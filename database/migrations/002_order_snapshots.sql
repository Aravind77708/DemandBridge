ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS item TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS quantity NUMERIC(14,2);

UPDATE purchase_orders AS po
SET item = d.item, quantity = d.quantity
FROM demands AS d
WHERE d.id = po.demand_id AND (po.item IS NULL OR po.quantity IS NULL);

ALTER TABLE order_allocations ADD COLUMN IF NOT EXISTS supplier_name TEXT;
ALTER TABLE order_allocations ADD COLUMN IF NOT EXISTS lead_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_allocations ADD COLUMN IF NOT EXISTS subtotal NUMERIC(16,2) NOT NULL DEFAULT 0;

UPDATE order_allocations AS a
SET supplier_name = s.name, lead_days = s.lead_days,
    subtotal = a.quantity * a.unit_price
FROM suppliers AS s
WHERE s.id = a.supplier_id AND (a.supplier_name IS NULL OR a.subtotal = 0);
