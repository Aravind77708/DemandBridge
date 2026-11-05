const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const MIGRATION_LOCK_ID = 438719260183n;

function createPool(options = {}) {
  const connectionString = options.connectionString || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required; JSON-file persistence is no longer used by the API.');
  let isLoopback = false;
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase();
    isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch { /* Let node-postgres report malformed connection strings. */ }
  return new (options.PoolClass || Pool)({
    connectionString,
    max: options.max || Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ...(options.options ? { options: options.options } : {}),
    ...(options.ssl === undefined ? { ssl: isLoopback ? false : { rejectUnauthorized: true } } : { ssl: options.ssl }),
  });
}

async function applyMigrations(pool, migrationsDir = path.join(__dirname, 'migrations')) {
  const files = fs.readdirSync(migrationsDir).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
  const client = await pool.connect();
  const applied = [];
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_ID.toString()]);
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [file]);
        if (existing.rowCount) {
          if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} was modified. Add a new migration instead.`);
          await client.query('COMMIT');
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    client.release();
  }
}

module.exports = { createPool, applyMigrations };
