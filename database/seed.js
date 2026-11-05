const sample = require('./sample-data');

async function seedIfEmpty(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['438719260184']);
    const result = await client.query(`
      SELECT (SELECT COUNT(*) FROM demands) + (SELECT COUNT(*) FROM suppliers) +
             (SELECT COUNT(*) FROM purchase_orders) + (SELECT COUNT(*) FROM shipments) AS record_count
    `);
    if (Number(result.rows[0].record_count) > 0) {
      await client.query('COMMIT');
      return false;
    }
    for (const supplier of sample.suppliers) {
      await client.query(
        `INSERT INTO suppliers (id,name,category,location,rating,available_capacity,unit_price,lead_days,verified,verification_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [supplier.id,supplier.name,supplier.category,supplier.location,supplier.rating,supplier.capacity,supplier.price,supplier.lead,supplier.verified,supplier.verified?'approved':'pending'],
      );
    }
    for (const demand of sample.demands) {
      await client.query(
        `INSERT INTO demands (id,buyer_name,item,quantity,unit,destination,due_date,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [demand.id,demand.buyer,demand.item,demand.qty,demand.unit,demand.destination,demand.due,demand.status,demand.created],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

module.exports = { seedIfEmpty };
