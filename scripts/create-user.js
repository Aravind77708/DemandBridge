require('../env');
const crypto = require('node:crypto');
const { createPool, applyMigrations } = require('../database');
const { hashPassword, ROLES } = require('../auth');

(async () => {
  const email = (process.env.USER_EMAIL || '').trim().toLowerCase();
  const role = process.env.USER_ROLE || '';
  const password = process.env.USER_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Set USER_EMAIL to a valid email address.');
  if (!ROLES.includes(role)) throw new Error(`Set USER_ROLE to one of: ${ROLES.join(', ')}.`);
  if (!password) throw new Error('Set USER_PASSWORD through a private environment variable; it is never printed.');
  const isDemo = process.env.USER_IS_DEMO === 'true';
  if (isDemo && !(process.env.NODE_ENV === 'development' && process.env.DEMO_AUTH_ENABLED === 'true')) throw new Error('Demo accounts require NODE_ENV=development and DEMO_AUTH_ENABLED=true.');
  const passwordHash = await hashPassword(password);
  const pool = createPool();
  try {
    await applyMigrations(pool);
    const inserted = await pool.query(
      `INSERT INTO users (id,email,display_name,role,password_hash,is_demo)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [crypto.randomUUID(), email, process.env.USER_NAME || email.split('@')[0], role, passwordHash, isDemo],
    );
    if (!inserted.rowCount) throw new Error('That email already exists; no user record was changed.');
    console.log(`Created ${isDemo ? 'local demo' : 'user'} account ${email} (${role}).`);
  } finally { await pool.end(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
