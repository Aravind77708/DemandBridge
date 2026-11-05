require('../env');
const fs = require('node:fs');
const path = require('node:path');
const { createPool, applyMigrations } = require('../database');
const { importJsonData, validateData } = require('../database/import-json');

(async () => {
  const file = path.resolve(process.env.IMPORT_FILE || path.join(__dirname, '..', 'data.json'));
  if (!fs.existsSync(file)) throw new Error(`Source file not found: ${file}`);
  const data = validateData(JSON.parse(fs.readFileSync(file, 'utf8')));
  const counts = Object.fromEntries(['suppliers','demands','orders','allocations','shipments','audit'].map((key) => [key, (data[key] || []).length]));
  if (!process.argv.includes('--apply')) {
    console.log(`Dry run; source file is unchanged. Ready to import: ${JSON.stringify(counts)}`);
    console.log('Set DATABASE_URL to the Neon database, then run: npm run db:import-json -- --apply');
    return;
  }
  const pool = createPool();
  try {
    await applyMigrations(pool);
    const inserted = await importJsonData(pool, data);
    console.log(`Import completed. Inserted counts (existing IDs are skipped): ${JSON.stringify(inserted)}`);
    console.log('The source data.json file was not modified or deleted.');
  } finally { await pool.end(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
