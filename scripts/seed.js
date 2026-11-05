require('../env');
const { createPool, applyMigrations } = require('../database');
const { seedIfEmpty } = require('../database/seed');

(async () => {
  const pool = createPool();
  try {
    await applyMigrations(pool);
    const seeded = await seedIfEmpty(pool);
    console.log(seeded ? 'Sample data inserted into an empty database.' : 'Seed skipped: database already contains data; nothing was overwritten.');
  } finally { await pool.end(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
