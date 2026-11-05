require('../env');
const crypto = require('node:crypto');
const { createPool, applyMigrations } = require('../database');
const { hashPassword, ROLES } = require('../auth');

(async () => {
  if (!(process.env.NODE_ENV === 'development' && process.env.DEMO_AUTH_ENABLED === 'true')) throw new Error('Set NODE_ENV=development and DEMO_AUTH_ENABLED=true to create local demo accounts.');
  const password = process.env.DEMO_ACCOUNT_PASSWORD;
  if (!password) throw new Error('Set DEMO_ACCOUNT_PASSWORD to a private value of at least 12 characters.');
  const pool = createPool();
  try {
    await applyMigrations(pool);
    let created = 0;
    for (const role of ROLES) {
      const localRole = role.toLowerCase().replace(/[^a-z]+/g, '-');
      const email = `${localRole}@demo.local`;
      const passwordHash = await hashPassword(password);
      const result = await pool.query(
        `INSERT INTO users (id,email,display_name,role,password_hash,is_demo)
         VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING RETURNING id`,
        [crypto.randomUUID(), email, role, role, passwordHash],
      );
      created += result.rowCount;
    }
    console.log(`Created ${created} local demo account(s). Existing accounts were not changed.`);
    console.log('The API accepts demo accounts only with NODE_ENV=development and DEMO_AUTH_ENABLED=true.');
  } finally { await pool.end(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
