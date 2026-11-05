require('../env');
const { createPool, applyMigrations } = require('../database');

(async () => {
  const pool = createPool();
  try {
    const applied = await applyMigrations(pool);
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is current.');
  } finally { await pool.end(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
