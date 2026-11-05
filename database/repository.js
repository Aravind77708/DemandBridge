const crypto = require('node:crypto');
const { matchSuppliers } = require('./matching');

const asNumber = (value) => Number(value || 0);
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
const dateAfterDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function mapDemand(row) {
  return { id: row.id, buyer: row.buyer_name, item: row.item, qty: asNumber(row.quantity), unit: row.unit, destination: row.destination, due: dateOnly(row.due_date), status: row.status, created: new Date(row.created_at).toISOString(), category: row.category || '', qualityRequirements: row.quality_requirements || {}, latitude: row.latitude === null ? null : row.latitude === undefined ? null : asNumber(row.latitude), longitude: row.longitude === null ? null : row.longitude === undefined ? null : asNumber(row.longitude) };
}
function mapSupplier(row) {
  return { id: row.id, name: row.name, category: row.category, location: row.location, rating: asNumber(row.rating), capacity: asNumber(row.available_capacity), capacityUnit: row.capacity_unit || 'kg', price: asNumber(row.unit_price), lead: asNumber(row.lead_days), verified: row.verified, verificationStatus: row.verification_status || (row.verified ? 'approved' : 'pending'), verificationReason: row.verification_reason || '', products: row.products || [], qualityAttributes: row.quality_attributes || {}, minimumOrderQuantity: asNumber(row.minimum_order_quantity), latitude: row.latitude === null || row.latitude === undefined ? null : asNumber(row.latitude), longitude: row.longitude === null || row.longitude === undefined ? null : asNumber(row.longitude) };
}
function mapCatalogueProduct(row) {
  return { id: row.id, supplierId: row.supplier_id, supplier: row.supplier_name, productName: row.product_name, category: row.category, qualityAttributes: row.quality_attributes || {}, unit: row.unit, price: asNumber(row.unit_price), minimumOrderQuantity: asNumber(row.minimum_order_quantity), availableCapacity: asNumber(row.available_capacity), leadDays: asNumber(row.lead_days), verificationStatus: row.verification_status, verificationReason: row.verification_reason || '', createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
function mapShipment(row) {
  return { id: row.id, orderId: row.order_id, carrier: row.carrier, status: row.status, origin: row.origin, destination: row.destination, eta: dateOnly(row.eta) };
}

async function nextId(client, table, prefix, first, width = 0) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`id:${table}`]);
  const result = await client.query(
    `SELECT COALESCE(MAX(substring(id FROM $1)::bigint), $2::bigint - 1) AS max_id, COUNT(*) AS row_count FROM ${table} WHERE id LIKE $3`,
    [prefix.length + 1, first, `${prefix}%`],
  );
  const maxId = asNumber(result.rows[0].max_id);
  const count = asNumber(result.rows[0].row_count);
  return `${prefix}${String(Math.max(maxId + 1, first + count)).padStart(width, '0')}`;
}

class Repository {
  constructor(pool) { this.pool = pool; }

  async health() {
    await this.pool.query('SELECT 1');
    return { ok: true, db: 'postgres', time: new Date().toISOString() };
  }

  async getDemands() {
    const result = await this.pool.query('SELECT * FROM demands ORDER BY created_at DESC, id DESC');
    return result.rows.map(mapDemand);
  }

  async getSuppliers(role = 'Administrator') {
    const result = await this.pool.query(
      `SELECT s.* FROM suppliers s
        WHERE $1 = 'Administrator' OR
              ($1 = ANY($2::text[]) AND s.verified=true AND s.verification_status='approved'
               AND EXISTS (SELECT 1 FROM supplier_products p WHERE p.supplier_id=s.id AND p.verification_status='approved'))
        ORDER BY s.name ASC,s.id ASC`,
      [role, ['Buyer', 'Procurement Manager']],
    );
    return result.rows.map((row) => {
      const supplier = mapSupplier(row);
      if (role !== 'Administrator') {
        delete supplier.products;
        delete supplier.qualityAttributes;
        delete supplier.verificationReason;
        delete supplier.latitude;
        delete supplier.longitude;
      }
      return supplier;
    });
  }

  async getOrders(orderId = null, orderIds = null) {
    const result = await this.pool.query(
      `SELECT po.id, po.demand_id, po.item, po.quantity, po.total, po.status, po.created_at,
              d.item AS demand_item, d.quantity AS demand_quantity
         FROM purchase_orders po JOIN demands d ON d.id = po.demand_id
        WHERE ($1::text IS NULL OR po.id = $1) AND ($2::text[] IS NULL OR po.id=ANY($2::text[]))
        ORDER BY po.created_at DESC, po.id DESC`,
      [orderId, orderIds],
    );
    if (!result.rows.length) return orderId ? null : [];
    const ids = result.rows.map((row) => row.id);
    const allocated = await this.pool.query(
      `SELECT a.order_id, a.supplier_id, COALESCE(a.supplier_name, s.name) AS supplier_name,
              a.quantity, a.unit_price, a.lead_days, a.subtotal, a.product_name, a.unit
         FROM order_allocations a JOIN suppliers s ON s.id = a.supplier_id
        WHERE a.order_id = ANY($1::text[]) ORDER BY a.id ASC`,
      [ids],
    );
    const byOrder = new Map(ids.map((id) => [id, []]));
    for (const row of allocated.rows) byOrder.get(row.order_id).push({
      supplier: row.supplier_name, supplierId: row.supplier_id, qty: asNumber(row.quantity),
      price: asNumber(row.unit_price), lead: asNumber(row.lead_days), subtotal: asNumber(row.subtotal), productName: row.product_name || null, unit: row.unit || null,
    });
    return result.rows.map((row) => ({
      id: row.id, demandId: row.demand_id, item: row.item || row.demand_item,
      qty: asNumber(row.quantity ?? row.demand_quantity), allocations: byOrder.get(row.id),
      total: asNumber(row.total), status: row.status, created: new Date(row.created_at).toISOString(),
    }));
  }

  async getShipments() {
    const result = await this.pool.query('SELECT * FROM shipments ORDER BY id DESC');
    return result.rows.map(mapShipment);
  }

  async getAudit() {
    const result = await this.pool.query('SELECT id, action, entity, happened_at FROM audit_events ORDER BY happened_at DESC, id DESC');
    return result.rows.map((row) => ({ id: row.id, action: row.action, entity: row.entity, at: new Date(row.happened_at).toISOString() }));
  }

  async findUserByEmail(email) {
    const result = await this.pool.query(
      'SELECT id,email,display_name,role,password_hash,is_demo FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    return result.rows[0] || null;
  }

  async findUserById(id) {
    const result = await this.pool.query(
      'SELECT id,email,display_name,role,is_demo FROM users WHERE id = $1',
      [id],
    );
    return result.rows[0] || null;
  }

  async bootstrap(role, userId = null) {
    const includeAudit = role === 'Procurement Manager' || role === 'Administrator';
    const isOperations = role === 'Procurement Manager' || role === 'Administrator';
    const isBuyer = role === 'Buyer';
    const [demands, suppliers, orders, audit] = await Promise.all([
      isOperations ? this.getDemands() : isBuyer ? this.getDemandsForBuyer(userId) : Promise.resolve([]),
      ['Buyer', 'Procurement Manager', 'Administrator'].includes(role) ? this.getSuppliers(role) : Promise.resolve([]),
      isOperations ? this.getOrders() : role === 'Logistics Provider' ? this.getOrdersForLogistics() : isBuyer ? this.getOrdersForBuyer(userId) : Promise.resolve([]),
      includeAudit ? this.getAudit() : Promise.resolve([]),
    ]);
    const shipments = isOperations || role === 'Logistics Provider' || isBuyer
      ? await this.getShipmentsForOrders(orders.map((order) => order.id)) : [];
    const supplierWorkspace = role === 'Supplier' && userId ? await this.getSupplierWorkspace(userId) : null;
    const result = {
      demands, suppliers, orders, shipments, audit,
      // The schema does not record actual delivery timestamps, so on-time performance cannot yet be calculated honestly.
      stats: { open: demands.filter((d) => d.status !== 'Completed').length, spend: orders.reduce((total, order) => total + order.total, 0), suppliers: role === 'Supplier' ? Number(Boolean(supplierWorkspace?.profile)) : suppliers.length, onTime: null },
    };
    if (supplierWorkspace) result.supplierWorkspace = supplierWorkspace;
    if (role === 'Administrator') result.supplierSubmissions = await this.getSupplierSubmissions();
    return result;
  }

  async getDemandsForBuyer(userId) {
    if (!userId) return [];
    const result = await this.pool.query('SELECT * FROM demands WHERE buyer_user_id=$1 ORDER BY created_at DESC,id DESC', [userId]);
    return result.rows.map(mapDemand);
  }

  async getOrdersForBuyer(userId) {
    if (!userId) return [];
    const result = await this.pool.query('SELECT po.id FROM purchase_orders po JOIN demands d ON d.id=po.demand_id WHERE d.buyer_user_id=$1', [userId]);
    return result.rowCount ? this.getOrders(null, result.rows.map((row) => row.id)) : [];
  }

  async getOrdersForLogistics() {
    const result = await this.pool.query("SELECT id FROM purchase_orders WHERE status IN ('Approved','In transit','Delivered','Delayed') ORDER BY created_at DESC,id DESC");
    if (!result.rowCount) return [];
    const orders = await this.getOrders(null, result.rows.map((row) => row.id));
    return orders.map((order) => ({
      ...order,
      total: null,
      allocations: order.allocations.map(({ price, subtotal, ...operational }) => operational),
    }));
  }

  async getShipmentsForOrders(orderIds) {
    if (!orderIds.length) return [];
    const result = await this.pool.query('SELECT * FROM shipments WHERE order_id=ANY($1::text[]) ORDER BY id DESC', [orderIds]);
    return result.rows.map(mapShipment);
  }

  async matchDemand(id, role = null, userId = null) {
    const demandResult = await this.pool.query(
      `SELECT * FROM demands WHERE id=$1 AND ($2::text IS DISTINCT FROM 'Buyer' OR buyer_user_id=$3)`,
      [id, role, userId],
    );
    if (!demandResult.rowCount) return null;
    const demand = mapDemand(demandResult.rows[0]);
    const candidates = await this.getMatchCandidates(this.pool);
    const visibleCandidates = role === 'Administrator' ? candidates : candidates.filter((candidate) => candidate.verified);
    return { demand, ...matchSuppliers(demand, visibleCandidates) };
  }

  async getMatchCandidates(queryable, lock = false) {
    const result = await queryable.query(
      `SELECT sp.id AS product_id, sp.supplier_id, s.name AS supplier_name, s.location,
              s.rating, s.verified AS supplier_verified, s.verification_status AS supplier_status,
              sp.product_name, sp.category, sp.quality_attributes, sp.unit AS capacity_unit,
              sp.unit_price, sp.minimum_order_quantity, sp.available_capacity, sp.lead_days,
              sp.verification_status AS product_status, sp.verification_reason,
              s.latitude, s.longitude
         FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id
        ORDER BY sp.id${lock ? ' FOR UPDATE OF sp, s' : ''}`,
    );
    return result.rows.map((row) => ({
      id: row.product_id, productId: row.product_id, supplierId: row.supplier_id,
      name: row.supplier_name, productName: row.product_name, location: row.location, rating: asNumber(row.rating),
      category: row.category, products: [row.product_name],
      qualityAttributes: row.quality_attributes || {}, capacityUnit: row.capacity_unit,
      capacity: asNumber(row.available_capacity), price: asNumber(row.unit_price),
      minimumOrderQuantity: asNumber(row.minimum_order_quantity), lead: asNumber(row.lead_days),
      latitude: row.latitude === null ? null : asNumber(row.latitude), longitude: row.longitude === null ? null : asNumber(row.longitude),
      verified: row.supplier_verified && row.supplier_status === 'approved' && row.product_status === 'approved',
      supplierVerified: row.supplier_verified, supplierVerificationStatus: row.supplier_status,
      productVerificationStatus: row.product_status, verificationReason: row.verification_reason || '',
    }));
  }

  async getSupplierWorkspace(userId) {
    const supplierResult = await this.pool.query('SELECT * FROM suppliers WHERE owner_user_id = $1', [userId]);
    if (!supplierResult.rowCount) return { profile: null, products: [] };
    const profile = mapSupplier(supplierResult.rows[0]);
    const products = await this.pool.query(
      `SELECT p.*, s.name AS supplier_name FROM supplier_products p JOIN suppliers s ON s.id=p.supplier_id
        WHERE p.supplier_id=$1 ORDER BY p.created_at DESC,p.id`, [profile.id],
    );
    return { profile, products: products.rows.map(mapCatalogueProduct) };
  }

  async getSupplierSubmissions() {
    const [suppliers, products] = await Promise.all([
      this.pool.query(`SELECT s.*, u.email AS owner_email FROM suppliers s LEFT JOIN users u ON u.id=s.owner_user_id ORDER BY s.created_at DESC NULLS LAST,s.id`),
      this.pool.query(`SELECT p.*,s.name AS supplier_name,u.email AS owner_email FROM supplier_products p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN users u ON u.id=s.owner_user_id ORDER BY p.created_at DESC,p.id`),
    ]);
    return {
      suppliers: suppliers.rows.map((row) => ({ ...mapSupplier(row), ownerEmail: row.owner_email || '' })),
      products: products.rows.map((row) => ({ ...mapCatalogueProduct(row), ownerEmail: row.owner_email || '' })),
    };
  }

  async createDemand(data, user = null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = await nextId(client, 'demands', 'DEM-', 1049);
      const demand = { id, buyer: user?.role === 'Buyer' ? user.display_name : (data.buyer || 'Northstar Foods'), qty: Number(data.qty), item: data.item, unit: data.unit || 'kg', destination: data.destination || 'Pune, IN', due: data.due || dateAfterDays(30), status: 'Matching', created: new Date().toISOString(), category: data.category || '', qualityRequirements: data.qualityRequirements || {}, latitude: data.latitude ?? null, longitude: data.longitude ?? null };
      await client.query(
        `INSERT INTO demands (id,buyer_name,item,quantity,unit,destination,due_date,status,created_at,category,quality_requirements,latitude,longitude,buyer_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
        [demand.id, demand.buyer, demand.item, demand.qty, demand.unit, demand.destination, demand.due, demand.status, demand.created, demand.category || null, JSON.stringify(demand.qualityRequirements), demand.latitude, demand.longitude, user?.role === 'Buyer' ? user.id : null],
      );
      await this.insertAudit(client, 'Demand created', id);
      await client.query('COMMIT');
      return demand;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async createSupplier(data, user = null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ownerId = user?.role === 'Supplier' ? user.id : null;
      if (ownerId) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`supplier-profile:${ownerId}`]);
        const existing = await client.query('SELECT id FROM suppliers WHERE owner_user_id=$1', [ownerId]);
        if (existing.rowCount) {
          await client.query('ROLLBACK');
          return { error: 'A supplier profile already exists for this account', status: 409 };
        }
      }
      const id = await nextId(client, 'suppliers', 'SUP-', 1, 3);
      await client.query(
        `INSERT INTO suppliers (id,name,category,location,rating,available_capacity,unit_price,lead_days,verified,products,quality_attributes,minimum_order_quantity,capacity_unit,latitude,longitude,owner_user_id,verification_status,created_at)
         VALUES ($1,$2,$3,$4,4.2,$5,$6,$7,false,ARRAY[]::text[],'{}'::jsonb,0,$8,$9,$10,$11,'pending',now())`,
        [id, data.name || 'New supplier', data.category || 'General', data.location || 'India', Number(data.capacity) || 0, Number(data.price) || 0, Number(data.lead) || 0, data.capacityUnit || 'kg', data.latitude ?? null, data.longitude ?? null, ownerId],
      );
      await this.insertAudit(client, 'Supplier profile submitted', id);
      for (const productName of data.products || []) {
        const productId = await nextId(client, 'supplier_products', 'CAT-', 1, 4);
        await client.query(
          `INSERT INTO supplier_products (id,supplier_id,product_name,category,quality_attributes,unit,unit_price,minimum_order_quantity,available_capacity,lead_days)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
          [productId,id,productName,data.category,JSON.stringify(data.qualityAttributes || {}),data.capacityUnit || 'kg',Number(data.price) || 0,Number(data.minimumOrderQuantity) || 0,Number(data.capacity) || 0,Number(data.lead) || 0],
        );
        await this.insertAudit(client, 'Supplier catalogue product submitted', productId);
      }
      await client.query('COMMIT');
      const result = await client.query('SELECT * FROM suppliers WHERE id = $1', [id]);
      return mapSupplier(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async createSupplierProduct(userId, data) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const supplier = await client.query('SELECT id FROM suppliers WHERE owner_user_id=$1 FOR UPDATE', [userId]);
      if (!supplier.rowCount) { await client.query('ROLLBACK'); return { error: 'Create a supplier profile before adding catalogue products', status: 409 }; }
      const supplierId = supplier.rows[0].id;
      const id = await nextId(client, 'supplier_products', 'CAT-', 1, 4);
      await client.query(
        `INSERT INTO supplier_products (id,supplier_id,product_name,category,quality_attributes,unit,unit_price,minimum_order_quantity,available_capacity,lead_days)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
        [id,supplierId,data.productName,data.category,JSON.stringify(data.qualityAttributes || {}),data.unit,data.price,data.minimumOrderQuantity,data.availableCapacity,data.leadDays],
      );
      await this.insertAudit(client, 'Supplier catalogue product submitted', id);
      await client.query('COMMIT');
      const result = await client.query('SELECT p.*,s.name AS supplier_name FROM supplier_products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1', [id]);
      return mapCatalogueProduct(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async updateSupplierProduct(userId, id, data) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT p.*,s.name AS supplier_name FROM supplier_products p JOIN suppliers s ON s.id=p.supplier_id
          WHERE p.id=$1 AND s.owner_user_id=$2 FOR UPDATE OF p`, [id,userId],
      );
      if (!result.rowCount) { await client.query('ROLLBACK'); return null; }
      const old = result.rows[0];
      const merged = {
        productName: data.productName ?? old.product_name,
        category: data.category ?? old.category,
        qualityAttributes: data.qualityAttributes ?? old.quality_attributes,
        unit: data.unit ?? old.unit,
        price: data.price ?? asNumber(old.unit_price),
        minimumOrderQuantity: data.minimumOrderQuantity ?? asNumber(old.minimum_order_quantity),
        availableCapacity: data.availableCapacity ?? asNumber(old.available_capacity),
        leadDays: data.leadDays ?? old.lead_days,
      };
      const catalogChanged = merged.productName !== old.product_name || merged.category !== old.category || JSON.stringify(merged.qualityAttributes) !== JSON.stringify(old.quality_attributes) || merged.unit !== old.unit || Number(merged.price) !== asNumber(old.unit_price) || Number(merged.minimumOrderQuantity) !== asNumber(old.minimum_order_quantity) || Number(merged.leadDays) !== old.lead_days;
      const changed = catalogChanged || Number(merged.availableCapacity) !== asNumber(old.available_capacity);
      const resubmittingRejected = old.verification_status === 'rejected';
      if (!changed) {
        if (resubmittingRejected) {
          await client.query(
            `UPDATE supplier_products SET verification_status='pending',verification_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,updated_at=now() WHERE id=$1`, [id],
          );
          await this.insertAudit(client, 'Rejected supplier catalogue product resubmitted for review', id);
        }
        await client.query('COMMIT');
        return resubmittingRejected ? mapCatalogueProduct((await client.query('SELECT p.*,s.name AS supplier_name FROM supplier_products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1', [id])).rows[0]) : mapCatalogueProduct(old);
      }
      await client.query(
        `UPDATE supplier_products SET product_name=$2,category=$3,quality_attributes=$4::jsonb,unit=$5,unit_price=$6,
          minimum_order_quantity=$7,available_capacity=$8,lead_days=$9,
          verification_status=CASE WHEN $10 THEN 'pending' ELSE verification_status END,
          verification_reason=CASE WHEN $10 THEN NULL ELSE verification_reason END,
          reviewed_by=CASE WHEN $10 THEN NULL ELSE reviewed_by END,
          reviewed_at=CASE WHEN $10 THEN NULL ELSE reviewed_at END,updated_at=now()
          WHERE id=$1`,
        [id,merged.productName,merged.category,JSON.stringify(merged.qualityAttributes),merged.unit,merged.price,merged.minimumOrderQuantity,merged.availableCapacity,merged.leadDays,catalogChanged || resubmittingRejected],
      );
      await this.insertAudit(client, catalogChanged || resubmittingRejected ? 'Supplier catalogue product updated and submitted for review' : 'Supplier inventory capacity updated', id);
      await client.query('COMMIT');
      const updated = await client.query('SELECT p.*,s.name AS supplier_name FROM supplier_products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1', [id]);
      return mapCatalogueProduct(updated.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async updateSupplierProfile(userId, data) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM suppliers WHERE owner_user_id=$1 FOR UPDATE', [userId]);
      if (!current.rowCount) { await client.query('ROLLBACK'); return null; }
      const row = current.rows[0];
      const latitude = data.latitude === undefined ? row.latitude : data.latitude;
      const longitude = data.longitude === undefined ? row.longitude : data.longitude;
      const changed = data.name !== row.name || data.category !== row.category || data.location !== row.location ||
        latitude !== row.latitude || longitude !== row.longitude;
      const resubmittingRejected = row.verification_status === 'rejected';
      if (!changed && !resubmittingRejected) { await client.query('COMMIT'); return mapSupplier(row); }
      await client.query(
        `UPDATE suppliers SET name=$2,category=$3,location=$4,latitude=$5,longitude=$6,
          verified=false,verification_status='pending',verification_reason=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=$1`,
        [row.id,data.name,data.category,data.location,latitude,longitude],
      );
      await this.insertAudit(client, changed ? 'Supplier profile corrected and resubmitted for review' : 'Rejected supplier profile resubmitted for review', row.id);
      await client.query('COMMIT');
      return mapSupplier((await client.query('SELECT * FROM suppliers WHERE id=$1', [row.id])).rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async reviewSupplier(id, decision, reason, adminId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const supplier = await client.query('SELECT id,verification_status FROM suppliers WHERE id=$1 FOR UPDATE', [id]);
      if (!supplier.rowCount) { await client.query('ROLLBACK'); return { error: 'Supplier submission not found', status: 404 }; }
      if (supplier.rows[0].verification_status !== 'pending') { await client.query('ROLLBACK'); return { error: 'Only pending supplier submissions can be reviewed', status: 409 }; }
      const approved = decision === 'approve';
      await client.query(
        `UPDATE suppliers SET verification_status=$2,verified=$3,verification_reason=$4,reviewed_by=$5,reviewed_at=now() WHERE id=$1`,
        [id,approved?'approved':'rejected',approved,reason || null,adminId],
      );
      await this.insertAudit(client, `Supplier submission ${approved?'approved':'rejected'}`, id);
      await client.query('COMMIT');
      return mapSupplier((await client.query('SELECT * FROM suppliers WHERE id=$1', [id])).rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async reviewSupplierProduct(id, decision, reason, adminId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const product = await client.query(
        `SELECT p.id,p.verification_status,s.verification_status AS supplier_status
           FROM supplier_products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1 FOR UPDATE OF p,s`, [id],
      );
      if (!product.rowCount) { await client.query('ROLLBACK'); return { error: 'Catalogue submission not found', status: 404 }; }
      if (product.rows[0].verification_status !== 'pending') { await client.query('ROLLBACK'); return { error: 'Only pending catalogue submissions can be reviewed', status: 409 }; }
      const approved = decision === 'approve';
      if (approved && product.rows[0].supplier_status !== 'approved') { await client.query('ROLLBACK'); return { error: 'Approve the supplier profile before approving its catalogue products', status: 409 }; }
      await client.query(
        `UPDATE supplier_products SET verification_status=$2,verification_reason=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now() WHERE id=$1`,
        [id,approved?'approved':'rejected',reason || null,adminId],
      );
      await this.insertAudit(client, `Supplier catalogue product ${approved?'approved':'rejected'}`, id);
      await client.query('COMMIT');
      const result = await client.query('SELECT p.*,s.name AS supplier_name FROM supplier_products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1', [id]);
      return mapCatalogueProduct(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async insertAudit(client, action, entity) {
    await client.query('INSERT INTO audit_events (id,action,entity,happened_at) VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), action, entity, new Date().toISOString()]);
  }

  async allocate(demandId) {
    const client = await this.pool.connect();
    let orderId;
    try {
      await client.query('BEGIN');
      const demandResult = await client.query('SELECT * FROM demands WHERE id = $1 FOR UPDATE', [demandId]);
      if (!demandResult.rowCount) { await client.query('ROLLBACK'); return { error: 'Demand not found', status: 404 }; }
      const demand = mapDemand(demandResult.rows[0]);
      const existingOrder = await client.query('SELECT id FROM purchase_orders WHERE demand_id = $1 LIMIT 1', [demand.id]);
      if (existingOrder.rowCount) {
        await client.query('ROLLBACK');
        return { error: 'This demand already has a purchase order', status: 409 };
      }
      const candidates = await this.getMatchCandidates(client, true);
      const matching = matchSuppliers(demand, candidates);
      if (!matching.allocationPlan) {
        await client.query('ROLLBACK');
        return { error: matching.summary.coverageReason || 'No eligible supplier combination can fulfill the full demand', status: 422, matching: matching.summary };
      }
      const candidateByProductId = new Map(candidates.map((candidate) => [candidate.productId, candidate]));
      const allocations = matching.allocationPlan.map((plan) => {
        const product = candidateByProductId.get(plan.supplierProductId);
        return { supplier: product.name, supplierId: product.supplierId, supplierProductId: product.productId, productName: product.productName, unit: product.capacityUnit, qty: plan.quantity, price: product.price, lead: product.lead, subtotal: plan.quantity * product.price };
      });
      orderId = await nextId(client, 'purchase_orders', 'PO-', 3001);
      const total = allocations.reduce((sum, allocation) => sum + allocation.subtotal, 0);
      const created = new Date().toISOString();
      await client.query(
        `INSERT INTO purchase_orders (id,demand_id,item,quantity,total,status,created_at)
         VALUES ($1,$2,$3,$4,$5,'Pending approval',$6)`,
        [orderId, demand.id, demand.item, demand.qty, total, created],
      );
      for (const allocation of allocations) {
        await client.query(
          `INSERT INTO order_allocations (order_id,supplier_id,supplier_name,quantity,unit_price,lead_days,subtotal,supplier_product_id,product_name,unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [orderId, allocation.supplierId, allocation.supplier, allocation.qty, allocation.price, allocation.lead, allocation.subtotal, allocation.supplierProductId, allocation.productName, allocation.unit],
        );
        const reserved = await client.query(
          `UPDATE supplier_products SET available_capacity = available_capacity - $2, updated_at=now()
            WHERE id = $1 AND available_capacity >= $2 AND verification_status='approved'`,
          [allocation.supplierProductId, allocation.qty],
        );
        if (reserved.rowCount !== 1) throw new Error(`Supplier product capacity changed while reserving ${allocation.supplierProductId}`);
      }
      await client.query("UPDATE demands SET status = 'Pending approval' WHERE id = $1", [demand.id]);
      await this.insertAudit(client, 'Allocation proposed', orderId);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return (await this.getOrders(orderId))[0];
  }

  async approveOrder(id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT id,demand_id FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!result.rowCount) { await client.query('ROLLBACK'); return null; }
      await client.query("UPDATE purchase_orders SET status = 'Approved' WHERE id = $1", [id]);
      await client.query("UPDATE demands SET status = 'Approved' WHERE id = $1", [result.rows[0].demand_id]);
      await this.insertAudit(client, 'Purchase order approved', id);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return (await this.getOrders(id))[0];
  }

  async createShipment(data) {
    const client = await this.pool.connect();
    let shipmentId;
    try {
      await client.query('BEGIN');
      const order = await client.query('SELECT id,status FROM purchase_orders WHERE id = $1 FOR UPDATE', [data.orderId]);
      if (!order.rowCount || order.rows[0].status !== 'Approved') { await client.query('ROLLBACK'); return { error: 'Only approved orders can be dispatched', status: 422 }; }
      shipmentId = await nextId(client, 'shipments', 'SHP-', 5001);
      const shipment = { id: shipmentId, orderId: data.orderId, carrier: data.carrier || 'BlueDart Freight', status: 'In transit', origin: 'Supplier hub', destination: data.destination || 'Pune, IN', eta: data.eta || dateAfterDays(14) };
      await client.query(
        `INSERT INTO shipments (id,order_id,carrier,status,origin,destination,eta)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [shipment.id, shipment.orderId, shipment.carrier, shipment.status, shipment.origin, shipment.destination, shipment.eta],
      );
      await client.query("UPDATE purchase_orders SET status = 'In transit' WHERE id = $1", [data.orderId]);
      await client.query("UPDATE demands SET status = 'In transit' WHERE id = (SELECT demand_id FROM purchase_orders WHERE id = $1)", [data.orderId]);
      await this.insertAudit(client, 'Shipment created', shipmentId);
      await client.query('COMMIT');
      return shipment;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async updateShipment(id, status) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('UPDATE shipments SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
      if (!result.rowCount) { await client.query('ROLLBACK'); return null; }
      const orderStatus = status === 'Delivered' ? 'Delivered' : status;
      const demandStatus = status === 'Delivered' ? 'Completed' : status;
      await client.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [result.rows[0].order_id, orderStatus]);
      await client.query('UPDATE demands SET status = $2 WHERE id = (SELECT demand_id FROM purchase_orders WHERE id = $1)', [result.rows[0].order_id, demandStatus]);
      await this.insertAudit(client, 'Shipment status updated', id);
      await client.query('COMMIT');
      return mapShipment(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

module.exports = { Repository, nextId, mapDemand, mapSupplier, mapShipment };
