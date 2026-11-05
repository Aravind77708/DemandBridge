const crypto = require('node:crypto');
const { normalizeText } = require('./matching');

function validateData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The JSON root must be an object.');
  for (const key of ['demands', 'suppliers', 'orders', 'shipments', 'audit']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`data.json field ${key} must be an array.`);
  }
  for (const order of data.orders || []) {
    if (!(data.demands || []).some((demand) => demand.id === order.demandId)) throw new Error(`Order ${order.id} references missing demand ${order.demandId}.`);
    for (const allocation of order.allocations || []) {
      if (!(data.suppliers || []).some((supplier) => supplier.id === allocation.supplierId)) throw new Error(`Order ${order.id} references missing supplier ${allocation.supplierId}.`);
    }
  }
  for (const supplier of data.suppliers || []) {
    if (supplier.products !== undefined && (!Array.isArray(supplier.products) || supplier.products.some((product) => typeof product !== 'string' || !product.trim()))) throw new Error(`Supplier ${supplier.id} has an invalid products list.`);
    if (supplier.catalogProducts !== undefined && (!Array.isArray(supplier.catalogProducts) || supplier.catalogProducts.some((product) => !product || typeof product !== 'object' || Array.isArray(product) || typeof product.productName !== 'string' || !product.productName.trim()))) throw new Error(`Supplier ${supplier.id} has invalid catalogProducts.`);
  }
  return data;
}

async function importJsonData(pool, input) {
  const data = validateData(input);
  const client = await pool.connect();
  const counts = { suppliers: 0, catalogProducts: 0, demands: 0, orders: 0, allocations: 0, shipments: 0, audit: 0 };
  try {
    await client.query('BEGIN');
    for (const supplier of data.suppliers || []) {
      const r = await client.query(
        `INSERT INTO suppliers (id,name,category,location,rating,available_capacity,unit_price,lead_days,verified,products,quality_attributes,minimum_order_quantity,capacity_unit,latitude,longitude,verification_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16) ON CONFLICT (id) DO NOTHING`,
        [supplier.id, supplier.name, supplier.category, supplier.location, supplier.rating, supplier.capacity, supplier.price, supplier.lead, Boolean(supplier.verified), supplier.products || [], JSON.stringify(supplier.qualityAttributes || {}), supplier.minimumOrderQuantity || 0, supplier.capacityUnit || 'kg', supplier.latitude ?? null, supplier.longitude ?? null, supplier.verified ? 'approved' : 'pending'],
      );
      counts.suppliers += r.rowCount;
      const products = supplier.catalogProducts || (supplier.products || []).map((productName) => ({ productName }));
      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        const id = `SP-IMPORT-${crypto.createHash('sha256').update(`${supplier.id}:${index}:${product.productName}`).digest('hex').slice(0,24)}`;
        const inserted = await client.query(
          `INSERT INTO supplier_products (id,supplier_id,product_name,category,quality_attributes,unit,unit_price,minimum_order_quantity,available_capacity,lead_days,verification_status)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,'pending') ON CONFLICT (id) DO NOTHING`,
          [id,supplier.id,product.productName,product.category || supplier.category,JSON.stringify(product.qualityAttributes || supplier.qualityAttributes || {}),product.unit || supplier.capacityUnit || 'kg',product.price ?? supplier.price ?? 0,product.minimumOrderQuantity ?? supplier.minimumOrderQuantity ?? 0,product.availableCapacity ?? supplier.capacity ?? 0,product.leadDays ?? supplier.lead ?? 0],
        );
        counts.catalogProducts += inserted.rowCount;
      }
    }
    for (const demand of data.demands || []) {
      const r = await client.query(
        `INSERT INTO demands (id,buyer_name,item,quantity,unit,destination,due_date,status,created_at,category,quality_requirements,latitude,longitude)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13) ON CONFLICT (id) DO NOTHING`,
        [demand.id, demand.buyer || 'Northstar Foods', demand.item, demand.qty, demand.unit || 'kg', demand.destination || '', demand.due || '2026-12-01', demand.status || 'Matching', demand.created || new Date().toISOString(), demand.category || null, JSON.stringify(demand.qualityRequirements || {}), demand.latitude ?? null, demand.longitude ?? null],
      );
      counts.demands += r.rowCount;
    }
    for (const order of data.orders || []) {
      const demand = data.demands.find((item) => item.id === order.demandId);
      const r = await client.query(
        `INSERT INTO purchase_orders (id,demand_id,item,quantity,total,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [order.id, order.demandId, order.item || demand.item, order.qty ?? demand.qty, order.total || 0, order.status || 'Pending approval', order.created || new Date().toISOString()],
      );
      counts.orders += r.rowCount;
      if (!r.rowCount) continue;
      for (const allocation of order.allocations || []) {
        const supplier = data.suppliers.find((item) => item.id === allocation.supplierId);
        const catalogName = allocation.productName || order.item || demand.item;
        const catalogUnit = allocation.unit || demand.unit || supplier?.capacityUnit || 'kg';
        const catalogCandidates = await client.query(
          `SELECT id,product_name,unit,available_capacity FROM supplier_products
            WHERE supplier_id=$1 AND lower(unit)=lower($2) ORDER BY id FOR UPDATE`,
          [allocation.supplierId,catalogUnit],
        );
        const catalogRows = catalogCandidates.rows.filter((product) => normalizeText(product.product_name) === normalizeText(catalogName));
        let remaining = Number(allocation.qty);
        const reservedProducts = [];
        for (const product of catalogRows) {
          if (remaining <= 0) break;
          const quantity = Math.min(remaining, Number(product.available_capacity));
          if (quantity <= 0) continue;
          const reservation = await client.query(
            `UPDATE supplier_products SET available_capacity=available_capacity-$2,updated_at=now()
              WHERE id=$1 AND available_capacity >= $2`, [product.id,quantity],
          );
          if (reservation.rowCount !== 1) throw new Error(`Insufficient catalogue capacity while importing allocation for supplier ${allocation.supplierId}.`);
          reservedProducts.push({ ...product, quantity });
          remaining = Number((remaining - quantity).toFixed(2));
        }
        if (catalogRows.length && remaining > 0) throw new Error(`Imported allocation exceeds matching catalogue capacity for supplier ${allocation.supplierId}.`);
        const parts = reservedProducts.length ? reservedProducts : [{ id: null, product_name: allocation.productName || null, unit: allocation.unit || demand.unit || null, quantity: Number(allocation.qty) }];
        for (const part of parts) {
          const subtotal = part.quantity * Number(allocation.price);
          const line = await client.query(
            `INSERT INTO order_allocations (order_id,supplier_id,supplier_name,quantity,unit_price,lead_days,subtotal,supplier_product_id,product_name,unit)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [order.id, allocation.supplierId, allocation.supplier, part.quantity, allocation.price, allocation.lead || 0, subtotal, part.id, part.product_name, part.unit],
          );
          counts.allocations += line.rowCount;
        }
        const reservation = await client.query(
          `UPDATE suppliers SET available_capacity = available_capacity - $2
            WHERE id = $1 AND available_capacity >= $2`,
          [allocation.supplierId, allocation.qty],
        );
        if (reservation.rowCount !== 1) throw new Error(`Insufficient remaining capacity while importing allocation for supplier ${allocation.supplierId}.`);
      }
    }
    for (const shipment of data.shipments || []) {
      const r = await client.query(
        `INSERT INTO shipments (id,order_id,carrier,status,origin,destination,eta)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [shipment.id, shipment.orderId, shipment.carrier || 'Unknown carrier', shipment.status || 'Pending', shipment.origin || null, shipment.destination || '', shipment.eta || null],
      );
      counts.shipments += r.rowCount;
    }
    for (const event of data.audit || []) {
      const r = await client.query(
        `INSERT INTO audit_events (id,action,entity,happened_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [event.id, event.action, event.entity, event.at || new Date().toISOString()],
      );
      counts.audit += r.rowCount;
    }
    await client.query('COMMIT');
    return counts;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

module.exports = { importJsonData, validateData };
