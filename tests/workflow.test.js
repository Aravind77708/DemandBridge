const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { createPool, applyMigrations } = require('../database');
const { Repository } = require('../database/repository');
const { matchSuppliers } = require('../database/matching');
const { seedIfEmpty } = require('../database/seed');
const { importJsonData } = require('../database/import-json');
const { createServer, routeRoles, createLoginRateLimiter } = require('../server');
const { createAuth, hashPassword } = require('../auth');
const { Pool } = require('pg');

const AUTH_SECRET = 'test-only-secret-material-not-for-any-deployment';
const TEST_PASSWORD = 'Test-Only-password-42!';

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startFixture({ seed = true, loginLimiter } = {}) {
  if (process.env.DEMANDBRIDGE_TEST_DATABASE_URL) {
    const schema = `dbtest_${crypto.randomUUID().replace(/-/g, '')}`;
    const rootPool = new Pool({ connectionString: process.env.DEMANDBRIDGE_TEST_DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 1 });
    await rootPool.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({
      connectionString: process.env.DEMANDBRIDGE_TEST_DATABASE_URL,
      ssl: { rejectUnauthorized: true },
      max: 5,
      options: `-c search_path=${schema}`,
    });
    try {
      const applied = await applyMigrations(pool);
      assert.deepEqual(applied, ['001_initial.sql', '002_order_snapshots.sql', '003_procurement_reservations_and_demo_users.sql', '004_demand_specific_matching.sql', '005_supplier_catalogue_and_verification.sql', '006_buyer_demand_ownership.sql']);
      const repository = new Repository(pool);
      const auth = createAuth({ secret: AUTH_SECRET });
      const users = await createFixtureUsers(pool);
      if (seed) await seedIfEmpty(pool);
      const server = createServer({ repository, auth, corsOrigins: 'https://demandbridge.vercel.app', ...(loginLimiter ? { loginLimiter } : {}) });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const request = makeRequester(base, auth, users);
      return { pool, rootPool, schema, repository, auth, users, server, request, remote: true };
    } catch (error) {
      await pool.end();
      await rootPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await rootPool.end();
      throw error;
    }
  }
  const pglite = await PGlite.create();
  const dbPort = await freePort();
  const pgServer = new PGLiteSocketServer({ db: pglite, port: dbPort, host: '127.0.0.1' });
  await pgServer.start();
  const pool = createPool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`, ssl: false, max: 1 });
  const applied = await applyMigrations(pool);
  assert.deepEqual(applied, ['001_initial.sql', '002_order_snapshots.sql', '003_procurement_reservations_and_demo_users.sql', '004_demand_specific_matching.sql', '005_supplier_catalogue_and_verification.sql', '006_buyer_demand_ownership.sql']);
  const repository = new Repository(pool);
  const auth = createAuth({ secret: AUTH_SECRET });
  const users = await createFixtureUsers(pool);
  if (seed) await seedIfEmpty(pool);
  const server = createServer({ repository, auth, corsOrigins: 'https://demandbridge.vercel.app', ...(loginLimiter ? { loginLimiter } : {}) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = makeRequester(base, auth, users);
  return { pglite, pgServer, pool, repository, auth, users, server, request };
}

async function createFixtureUsers(pool) {
  const users = {};
  const roles = ['Buyer', 'Supplier', 'Procurement Manager', 'Logistics Provider', 'Administrator'];
  for (const role of roles) {
    const email = `${role.toLowerCase().replace(/[^a-z]+/g, '-')}@test.example`;
    const user = { id: crypto.randomUUID(), email, display_name: `${role} Test`, role, password_hash: await hashPassword(TEST_PASSWORD), is_demo: false };
    await pool.query(
      'INSERT INTO users (id,email,display_name,role,password_hash,is_demo) VALUES ($1,$2,$3,$4,$5,$6)',
      [user.id,user.email,user.display_name,user.role,user.password_hash,user.is_demo],
    );
    users[role] = user;
  }
  const otherSupplier = { id: crypto.randomUUID(), email: 'other-supplier@test.example', display_name: 'Other Supplier Test', role: 'Supplier', password_hash: await hashPassword(TEST_PASSWORD), is_demo: false };
  await pool.query('INSERT INTO users (id,email,display_name,role,password_hash,is_demo) VALUES ($1,$2,$3,$4,$5,$6)', [otherSupplier.id,otherSupplier.email,otherSupplier.display_name,otherSupplier.role,otherSupplier.password_hash,otherSupplier.is_demo]);
  users['Other Supplier'] = otherSupplier;
  const otherBuyer = { id: crypto.randomUUID(), email: 'other-buyer@test.example', display_name: 'Other Buyer Test', role: 'Buyer', password_hash: await hashPassword(TEST_PASSWORD), is_demo: false };
  await pool.query('INSERT INTO users (id,email,display_name,role,password_hash,is_demo) VALUES ($1,$2,$3,$4,$5,$6)', [otherBuyer.id,otherBuyer.email,otherBuyer.display_name,otherBuyer.role,otherBuyer.password_hash,otherBuyer.is_demo]);
  users['Other Buyer'] = otherBuyer;
  return users;
}

function makeRequester(base, auth, users) {
  return async (route, options = {}) => {
    const headers = { 'content-type': 'application/json', ...(options.as ? { authorization: `Bearer ${auth.issue(users[options.as])}` } : {}), ...(options.headers || {}) };
    const { as, ...fetchOptions } = options;
    const response = await fetch(base + route, { ...fetchOptions, headers });
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  };
}

async function stopFixture(fixture) {
  await new Promise((resolve) => fixture.server.close(resolve));
  await fixture.pool.end();
  if (fixture.remote) {
    await fixture.rootPool.query(`DROP SCHEMA "${fixture.schema}" CASCADE`);
    await fixture.rootPool.end();
    return;
  }
  await fixture.pgServer.stop();
  await fixture.pglite.close();
}

test('login throttling, security headers, and request validation', async (t) => {
  const clock = { value: 0 };
  const loginLimiter = createLoginRateLimiter({ limit: 2, windowMs: 1000, now: () => clock.value });
  const fixture = await startFixture({ loginLimiter });
  t.after(() => stopFixture(fixture));
  const { request, users } = fixture;
  const badLogin = () => request('/api/demo-login', {
    method: 'POST',
    body: JSON.stringify({ email: users.Buyer.email, password: 'incorrect-password' }),
  });
  assert.equal((await badLogin()).response.status, 401);
  assert.equal((await badLogin()).response.status, 401);
  const limited = await badLogin();
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('retry-after'), '1');
  assert.equal(limited.body.error, 'Too many login attempts. Try again later.');

  clock.value = 1001;
  const recovered = await request('/api/demo-login', {
    method: 'POST',
    body: JSON.stringify({ email: users.Buyer.email, password: TEST_PASSWORD }),
  });
  assert.equal(recovered.response.status, 200, 'expired login window allows a valid login');

  const invalidDemand = await request('/api/demands', {
    as: 'Buyer', method: 'POST', body: JSON.stringify({ item: 'Invalid', qty: -1 }),
  });
  assert.equal(invalidDemand.response.status, 400);
  const nonNumericDemand = await request('/api/demands', {
    as: 'Buyer', method: 'POST', body: JSON.stringify({ item: 'Boolean quantity', qty: true }),
  });
  assert.equal(nonNumericDemand.response.status, 400, 'boolean values are not accepted as quantities');
  const invalidDate = await request('/api/demands', {
    as: 'Buyer', method: 'POST', body: JSON.stringify({ item: 'Bad date', qty: 1, due: '2026-02-31' }),
  });
  assert.equal(invalidDate.response.status, 400, 'calendar-invalid dates are rejected');
  const invalidShipment = await request('/api/shipments/SHP-UNKNOWN', {
    as: 'Logistics Provider', method: 'PATCH', body: JSON.stringify({ status: 'Teleporting' }),
  });
  assert.equal(invalidShipment.response.status, 400);

  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.response.headers.get('x-frame-options'), 'DENY');
  assert.match(health.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const bootstrap = await request('/api/bootstrap', { as: 'Buyer' });
  assert.equal(bootstrap.body.stats.onTime, null, 'on-time delivery is left unavailable without actual delivery timestamps');
  const staticPage = await fetch(new URL('/', health.response.url));
  assert.equal(staticPage.status, 200);
  assert.equal(staticPage.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await staticPage.text(), /<title>DemandBridge<\/title>/);
});

test('server authentication, expiry, and role authorization', async (t) => {
  const fixture = await startFixture();
  t.after(() => stopFixture(fixture));
  const { request, users } = fixture;
  assert.throws(() => createAuth({ secret: 'short' }), /at least 32 bytes/);
  assert.deepEqual(routeRoles('GET', '/api/health'), null, 'health is handled explicitly as the only public read');
  assert.deepEqual(routeRoles('GET', '/api/bootstrap'), ['Buyer', 'Supplier', 'Procurement Manager', 'Logistics Provider', 'Administrator']);
  assert.deepEqual(routeRoles('POST', '/api/demands'), ['Buyer', 'Administrator']);
  assert.deepEqual(routeRoles('POST', '/api/suppliers'), ['Supplier', 'Administrator']);
  assert.deepEqual(routeRoles('PATCH', '/api/suppliers'), ['Supplier']);
  assert.deepEqual(routeRoles('GET', '/api/audit'), ['Procurement Manager', 'Administrator']);
  assert.deepEqual(routeRoles('POST', '/api/allocate'), ['Procurement Manager', 'Administrator']);
  assert.deepEqual(routeRoles('POST', '/api/orders/PO-3001/approve'), ['Procurement Manager', 'Administrator']);
  assert.deepEqual(routeRoles('POST', '/api/shipments'), ['Logistics Provider', 'Administrator']);
  assert.deepEqual(routeRoles('PATCH', '/api/shipments/SHP-5001'), ['Logistics Provider', 'Administrator']);
  assert.deepEqual(routeRoles('GET', '/api/supplier/catalog'), ['Supplier']);
  assert.deepEqual(routeRoles('POST', '/api/supplier/catalog'), ['Supplier']);
  assert.deepEqual(routeRoles('PATCH', '/api/supplier/catalog/SP-0001'), ['Supplier']);
  assert.deepEqual(routeRoles('GET', '/api/admin/supplier-submissions'), ['Administrator']);
  assert.deepEqual(routeRoles('POST', '/api/admin/suppliers/SUP-001/review'), ['Administrator']);
  assert.deepEqual(routeRoles('POST', '/api/admin/supplier-products/SP-0001/review'), ['Administrator']);
  assert.equal(routeRoles('GET', '/api/not-a-route'), null);

  assert.equal((await request('/api/health')).response.status, 200, 'database health is public');
  assert.equal((await request('/api/bootstrap')).response.status, 401, 'sensitive reads require a bearer token');
  assert.equal((await request('/api/bootstrap', { headers: { authorization: 'Bearer invalid.token.value' } })).response.status, 401);
  const protectedRoutes = [
    ['GET','/api/bootstrap'], ['GET','/api/suppliers'], ['GET','/api/audit'], ['GET','/api/match/DEM-1048'],
    ['POST','/api/demands'], ['POST','/api/suppliers'], ['POST','/api/allocate'],
    ['POST','/api/orders/PO-3001/approve'], ['POST','/api/shipments'], ['PATCH','/api/shipments/SHP-5001'],
  ];
  for (const [method, route] of protectedRoutes) {
    assert.equal((await request(route, { method, body: method === 'GET' ? undefined : '{}' })).response.status, 401, `${method} ${route} requires authentication`);
  }

  const expiredAuth = createAuth({ secret: AUTH_SECRET, now: () => Date.now() - 60 * 60 * 1000 });
  const expiredToken = expiredAuth.issue(users.Buyer);
  assert.equal((await request('/api/bootstrap', { headers: { authorization: `Bearer ${expiredToken}` } })).response.status, 401);

  const login = await request('/api/demo-login', { method: 'POST', body: JSON.stringify({ email: users.Buyer.email, password: TEST_PASSWORD, role: 'Administrator' }) });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.role, 'Buyer', 'the role comes from the database, not the request body');
  assert.equal(typeof login.body.token, 'string');
  const wrongPassword = await request('/api/demo-login', { method: 'POST', body: JSON.stringify({ email: users.Buyer.email, password: 'incorrect-password' }) });
  assert.equal(wrongPassword.response.status, 401);
  assert.equal((await request('/api/demo-login', { method: 'POST', body: JSON.stringify({ email: users.Buyer.email, role: 'Administrator' }) })).response.status, 400);

  const forbiddenAudit = await request('/api/audit', { as: 'Buyer' });
  assert.equal(forbiddenAudit.response.status, 403);
  const forbiddenAllocation = await request('/api/allocate', { as: 'Buyer', method: 'POST', body: JSON.stringify({ demandId: 'DEM-1048' }) });
  assert.equal(forbiddenAllocation.response.status, 403);
  const forbiddenDemand = await request('/api/demands', { as: 'Supplier', method: 'POST', body: JSON.stringify({ item: 'Denied', qty: 1 }) });
  assert.equal(forbiddenDemand.response.status, 403);
  const allowedAudit = await request('/api/audit', { as: 'Procurement Manager' });
  assert.equal(allowedAudit.response.status, 200);

  const demoEmail = 'manager@demo.local';
  await fixture.pool.query(
    'INSERT INTO users (id,email,display_name,role,password_hash,is_demo) VALUES ($1,$2,$3,$4,$5,true)',
    [crypto.randomUUID(), demoEmail, 'Demo Manager', 'Procurement Manager', await hashPassword(TEST_PASSWORD)],
  );
  const oldNodeEnv = process.env.NODE_ENV;
  const oldDemoSetting = process.env.DEMO_AUTH_ENABLED;
  try {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_AUTH_ENABLED = 'true';
    assert.equal((await request('/api/demo-login', { method: 'POST', body: JSON.stringify({ email: demoEmail, password: TEST_PASSWORD }) })).response.status, 401, 'demo accounts remain disabled in production');
    process.env.NODE_ENV = 'development';
    assert.equal((await request('/api/demo-login', { method: 'POST', body: JSON.stringify({ email: demoEmail, password: TEST_PASSWORD }) })).response.status, 200, 'demo accounts require an explicit development opt-in');
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldDemoSetting === undefined) delete process.env.DEMO_AUTH_ENABLED;
    else process.env.DEMO_AUTH_ENABLED = oldDemoSetting;
  }

  const preflight = await request('/api/bootstrap', { method: 'OPTIONS', headers: { origin: 'https://demandbridge.vercel.app' } });
  assert.equal(preflight.response.headers.get('access-control-allow-origin'), 'https://demandbridge.vercel.app');
  assert.match(preflight.response.headers.get('access-control-allow-headers'), /authorization/i);
});

test('procurement workflow, capacity reservation, idempotence, concurrency, and rollback', async (t) => {
  const originalDataPath = path.join(__dirname, '..', 'data.json');
  const originalData = fs.readFileSync(originalDataPath, 'utf8');
  const fixture = await startFixture();
  t.after(() => stopFixture(fixture));
  const { pool, repository, request } = fixture;

  const supplierSubmission = await request('/api/suppliers', {
    as: 'Supplier', method: 'POST',
    body: JSON.stringify({ name: 'Workflow supplier', category: 'Resin', location: 'Pune', products: ['Workflow test resin'], qualityAttributes: { grade: 'A' }, minimumOrderQuantity: 20, capacity: 6000, price: 19, lead: 4 }),
  });
  assert.equal(supplierSubmission.response.status, 201);
  assert.equal(supplierSubmission.body.verified, false);
  assert.equal(supplierSubmission.body.verificationStatus, 'pending');
  const supplierWorkspace = await request('/api/supplier/catalog', { as: 'Supplier' });
  assert.equal(supplierWorkspace.response.status, 200);
  const pendingProduct = supplierWorkspace.body.products[0];
  assert.equal(pendingProduct.productName, 'Workflow test resin');
  assert.equal(pendingProduct.verificationStatus, 'pending');
  const supplierBootstrap = await request('/api/bootstrap', { as: 'Supplier' });
  assert.deepEqual(supplierBootstrap.body.demands, []);
  assert.deepEqual(supplierBootstrap.body.orders, []);
  assert.deepEqual(supplierBootstrap.body.shipments, []);
  assert.deepEqual(supplierBootstrap.body.suppliers, []);
  assert.equal((await request('/api/suppliers', { as: 'Supplier' })).body.length, 0, 'supplier cannot enumerate peer suppliers');
  assert.equal((await request('/api/suppliers', { as: 'Buyer' })).body.length, 0, 'buyers cannot see unverified suppliers');
  assert.equal((await request('/api/supplier/catalog', { as: 'Buyer' })).response.status, 403);
  assert.equal((await request('/api/admin/supplier-submissions', { as: 'Supplier' })).response.status, 403);
  const created = await request('/api/demands', { as: 'Buyer', method: 'POST', body: JSON.stringify({ item: 'Workflow test resin', category: 'Resin', qualityRequirements: { grade: 'A' }, qty: 6000, unit: 'kg', destination: 'Pune, IN', due: '2026-12-20' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.item, 'Workflow test resin');
  assert.deepEqual(created.body.qualityRequirements, { grade: 'A' });
  const otherBuyerDemand = await request('/api/demands', { as: 'Other Buyer', method: 'POST', body: JSON.stringify({ item: 'Private buyer material', qty: 20, unit: 'kg', destination: 'Delhi' }) });
  assert.equal(otherBuyerDemand.response.status, 201);
  assert.equal((await request(`/api/match/${otherBuyerDemand.body.id}`, { as: 'Buyer' })).response.status, 404, 'buyers cannot view another buyer demand through matching');
  assert.equal((await request('/api/bootstrap', { as: 'Buyer' })).body.demands.some((demand) => demand.id === otherBuyerDemand.body.id), false);
  const pendingMatching = await request(`/api/match/${created.body.id}`, { as: 'Buyer' });
  assert.equal(pendingMatching.body.matches.length, 0);
  assert.equal(pendingMatching.body.excluded.some((item) => item.id === pendingProduct.id), false, 'buyers cannot enumerate unverified catalogue entries via matching');
  const prematureProductApproval = await request(`/api/admin/supplier-products/${pendingProduct.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.equal(prematureProductApproval.response.status, 409);
  const supplierApproval = await request(`/api/admin/suppliers/${supplierSubmission.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.equal(supplierApproval.response.status, 200);
  assert.equal(supplierApproval.body.verificationStatus, 'approved');
  assert.equal((await request(`/api/admin/suppliers/${supplierSubmission.body.id}/review`, { as: 'Supplier', method: 'POST', body: JSON.stringify({ decision: 'approve' }) })).response.status, 403);
  const productApproval = await request(`/api/admin/supplier-products/${pendingProduct.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.equal(productApproval.response.status, 200);
  assert.equal(productApproval.body.verificationStatus, 'approved');
  const matching = await request(`/api/match/${created.body.id}`, { as: 'Buyer' });
  assert.equal(matching.response.status, 200);
  assert.ok(matching.body.matches.length > 0);
  assert.equal(matching.body.summary.fullyCoverable, true);
  assert.ok(matching.body.matches.every((supplier) => supplier.eligible && supplier.scoreBreakdown.product));
  const verifiedDirectory = await request('/api/suppliers', { as: 'Buyer' });
  assert.ok(verifiedDirectory.body.some((supplier) => supplier.id === supplierSubmission.body.id));
  assert.ok(verifiedDirectory.body.every((supplier) => supplier.verificationStatus === 'approved'));

  const initialCapacity = Number((await pool.query('SELECT available_capacity FROM supplier_products WHERE id=$1',[pendingProduct.id])).rows[0].available_capacity);
  const allocation = await request('/api/allocate', { as: 'Procurement Manager', method: 'POST', body: JSON.stringify({ demandId: created.body.id }) });
  assert.equal(allocation.response.status, 201);
  assert.equal(allocation.body.status, 'Pending approval');
  assert.ok(allocation.body.allocations.length > 0);
  assert.equal(allocation.body.allocations.reduce((sum, line) => sum + line.subtotal, 0), allocation.body.total);
  const duplicate = await request('/api/allocate', { as: 'Procurement Manager', method: 'POST', body: JSON.stringify({ demandId: created.body.id }) });
  assert.equal(duplicate.response.status, 409);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM purchase_orders WHERE demand_id = $1', [created.body.id])).rows[0].count, 1);
  const reservedCapacity = Number((await pool.query('SELECT available_capacity FROM supplier_products WHERE id=$1',[pendingProduct.id])).rows[0].available_capacity);
  assert.ok(reservedCapacity < initialCapacity);
  await assert.rejects(
    pool.query("INSERT INTO purchase_orders (id,demand_id,total,status) VALUES ('PO-DUPLICATE', $1, 0, 'Pending approval')", [created.body.id]),
    /purchase_orders_one_per_demand_idx/,
  );

  const approved = await request(`/api/orders/${allocation.body.id}/approve`, { as: 'Procurement Manager', method: 'POST', body: '{}' });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.status, 'Approved');
  const dispatched = await request('/api/shipments', { as: 'Logistics Provider', method: 'POST', body: JSON.stringify({ orderId: allocation.body.id, carrier: 'Test carrier', destination: 'Pune, IN', eta: '2026-12-20' }) });
  assert.equal(dispatched.response.status, 201);
  const delivered = await request(`/api/shipments/${dispatched.body.id}`, { as: 'Logistics Provider', method: 'PATCH', body: JSON.stringify({ status: 'Delivered' }) });
  assert.equal(delivered.response.status, 200);
  assert.equal(delivered.body.status, 'Delivered');
  const buyerBootstrap = await request('/api/bootstrap', { as: 'Buyer' });
  assert.equal(buyerBootstrap.response.status, 200);
  assert.deepEqual(buyerBootstrap.body.audit, [], 'audit data is omitted for roles without audit permission');
  assert.equal(buyerBootstrap.body.demands.find((demand) => demand.id === created.body.id).status, 'Completed');
  const managerBootstrap = await request('/api/bootstrap', { as: 'Procurement Manager' });
  assert.ok(managerBootstrap.body.demands.some((demand) => demand.id === otherBuyerDemand.body.id));
  assert.ok(managerBootstrap.body.audit.length >= 4);
  assert.ok(managerBootstrap.body.audit.some((event) => event.action === 'Supplier profile submitted' && event.entity === supplierSubmission.body.id));
  assert.ok(managerBootstrap.body.audit.some((event) => event.action === 'Supplier catalogue product approved' && event.entity === pendingProduct.id));
  assert.ok(managerBootstrap.body.audit.some((event) => event.action === 'Shipment status updated' && event.entity === dispatched.body.id));
  assert.ok(managerBootstrap.body.orders.some((order) => order.id === allocation.body.id && order.status === 'Delivered'));
  const logisticsBootstrap = await request('/api/bootstrap', { as: 'Logistics Provider' });
  assert.deepEqual(logisticsBootstrap.body.demands, []);
  assert.deepEqual(logisticsBootstrap.body.suppliers, []);
  assert.ok(logisticsBootstrap.body.orders.some((order) => order.id === allocation.body.id));
  assert.ok(logisticsBootstrap.body.shipments.some((shipment) => shipment.id === dispatched.body.id));
  const logisticsOrder = logisticsBootstrap.body.orders.find((order) => order.id === allocation.body.id);
  assert.equal(logisticsOrder.total, null, 'logistics does not receive purchase totals');
  assert.equal('price' in logisticsOrder.allocations[0], false, 'logistics does not receive supplier pricing');
  const administratorBootstrap = await request('/api/bootstrap', { as: 'Administrator' });
  assert.ok(administratorBootstrap.body.demands.some((demand) => demand.id === otherBuyerDemand.body.id));
  assert.ok(administratorBootstrap.body.supplierSubmissions.suppliers.some((supplier) => supplier.id === supplierSubmission.body.id));

  await pool.query("INSERT INTO suppliers (id,name,category,location,rating,verified,verification_status) VALUES ('SUP-CONCURRENT','Concurrent fixture','Materials','Test',4,true,'approved'); INSERT INTO supplier_products (id,supplier_id,product_name,category,quality_attributes,unit,unit_price,minimum_order_quantity,available_capacity,lead_days,verification_status) VALUES ('SP-CONCURRENT','SUP-CONCURRENT','Concurrent material','Materials','{}','kg',10,0,500,4,'approved')");
  const concurrentDemand = await repository.createDemand({ item: 'Concurrent material', qty: 500, unit: 'kg' });
  const concurrent = await Promise.all([
    request('/api/allocate', { as: 'Procurement Manager', method: 'POST', body: JSON.stringify({ demandId: concurrentDemand.id }) }),
    request('/api/allocate', { as: 'Procurement Manager', method: 'POST', body: JSON.stringify({ demandId: concurrentDemand.id }) }),
  ]);
  assert.deepEqual(concurrent.map((entry) => entry.response.status).sort(), [201, 409]);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM purchase_orders WHERE demand_id = $1', [concurrentDemand.id])).rows[0].count, 1);

  await pool.query('UPDATE suppliers SET available_capacity = 0; UPDATE supplier_products SET available_capacity = 0');
  await pool.query(`
    INSERT INTO suppliers (id,name,category,location,rating,verified,verification_status) VALUES
    ('SUP-PART-A','Partial A','Materials','Test',4.5,true,'approved'),
    ('SUP-PART-B','Partial B','Materials','Test',4.4,true,'approved');
    INSERT INTO supplier_products (id,supplier_id,product_name,category,quality_attributes,unit,unit_price,minimum_order_quantity,available_capacity,lead_days,verification_status) VALUES
    ('SP-PART-A','SUP-PART-A','Split source material','Materials','{}','kg',10,0,4,5,'approved'),
    ('SP-PART-B','SUP-PART-B','Split source material','Materials','{}','kg',12,0,6,6,'approved'),
    ('SP-ROLLBACK-A','SUP-PART-A','Rollback material','Materials','{}','kg',10,0,4,5,'approved'),
    ('SP-ROLLBACK-B','SUP-PART-B','Rollback material','Materials','{}','kg',12,0,6,6,'approved')
  `);
  const partialDemand = await repository.createDemand({ item: 'Split source material', qty: 8, unit: 'kg' });
  const partial = await repository.allocate(partialDemand.id);
  assert.equal(partial.qty, 8);
  assert.equal(partial.allocations.length, 2);
  assert.equal(partial.allocations.reduce((sum, line) => sum + line.qty, 0), 8);
  assert.equal(Number((await pool.query("SELECT available_capacity FROM supplier_products WHERE id = 'SP-PART-B'")).rows[0].available_capacity), 2);

  await pool.query("INSERT INTO suppliers (id,name,category,location,rating,verified,verification_status) VALUES ('SUP-RACE','Race capacity','Materials','Test',5,true,'approved'); INSERT INTO supplier_products (id,supplier_id,product_name,category,quality_attributes,unit,unit_price,minimum_order_quantity,available_capacity,lead_days,verification_status) VALUES ('SP-RACE','SUP-RACE','Race demand','Materials','{}','kg',8,0,7,3,'approved')");
  const raceDemandA = await repository.createDemand({ item: 'Race demand', qty: 5, unit: 'kg' });
  const raceDemandB = await repository.createDemand({ item: 'Race demand', qty: 5, unit: 'kg' });
  const competing = await Promise.all([
    request('/api/allocate', { as: 'Procurement Manager', method: 'POST', body: JSON.stringify({ demandId: raceDemandA.id }) }),
    request('/api/allocate', { as: 'Procurement Manager', method: 'POST', body: JSON.stringify({ demandId: raceDemandB.id }) }),
  ]);
  assert.deepEqual(competing.map((entry) => entry.response.status).sort(), [201, 422]);
  assert.equal(Number((await pool.query("SELECT available_capacity FROM supplier_products WHERE id='SP-RACE'")).rows[0].available_capacity), 2);

  const shortDemand = await repository.createDemand({ item: 'Insufficient material', qty: 5, unit: 'kg' });
  const capacitiesBefore = await pool.query("SELECT id,available_capacity FROM supplier_products WHERE id LIKE 'SP-PART-%' ORDER BY id");
  const insufficient = await repository.allocate(shortDemand.id);
  assert.equal(insufficient.status, 422);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM purchase_orders WHERE demand_id = $1', [shortDemand.id])).rows[0].count, 0);
  assert.deepEqual((await pool.query("SELECT id,available_capacity FROM supplier_products WHERE id LIKE 'SP-PART-%' ORDER BY id")).rows, capacitiesBefore.rows);

  await pool.query(`
    CREATE FUNCTION reject_allocation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'Allocation proposed' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_allocation_audit BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_allocation_audit();
  `);
  const rollbackDemand = await repository.createDemand({ item: 'Rollback material', qty: 2, unit: 'kg' });
  const beforeRollback = await pool.query("SELECT id,available_capacity FROM supplier_products WHERE id LIKE 'SP-ROLLBACK-%' ORDER BY id");
  await assert.rejects(repository.allocate(rollbackDemand.id), /injected audit failure/);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM purchase_orders WHERE demand_id = $1', [rollbackDemand.id])).rows[0].count, 0);
  assert.equal((await pool.query("SELECT status FROM demands WHERE id = $1", [rollbackDemand.id])).rows[0].status, 'Matching');
  assert.deepEqual((await pool.query("SELECT id,available_capacity FROM supplier_products WHERE id LIKE 'SP-ROLLBACK-%' ORDER BY id")).rows, beforeRollback.rows);
  assert.equal(fs.readFileSync(originalDataPath, 'utf8'), originalData, 'the local data.json must remain untouched');
});

test('supplier catalogue ownership, edits, administrator verification/rejection, and matching gate', async (t) => {
  const fixture = await startFixture({ seed: false });
  t.after(() => stopFixture(fixture));
  const { request, repository } = fixture;
  const profile = await request('/api/suppliers', { as: 'Supplier', method: 'POST', body: JSON.stringify({ name: 'Catalog Test Supplier', category: 'Raw Foods', location: 'Pune' }) });
  assert.equal(profile.response.status, 201);
  assert.equal(profile.body.verificationStatus, 'pending');
  assert.equal(profile.body.verified, false);
  assert.equal((await request('/api/suppliers', { as: 'Supplier', method: 'POST', body: JSON.stringify({ name: 'Duplicate', category: 'Raw Foods', location: 'Pune' }) })).response.status, 409);

  const invalid = await request('/api/supplier/catalog', { as: 'Supplier', method: 'POST', body: JSON.stringify({ productName: 'Sugar', category: 'Raw Foods', qualityAttributes: {}, unit: 'kg', price: -1, minimumOrderQuantity: 1, availableCapacity: 20, leadDays: 2 }) });
  assert.equal(invalid.response.status, 400);
  const created = await request('/api/supplier/catalog', { as: 'Supplier', method: 'POST', body: JSON.stringify({ productName: 'Organic cane sugar', category: 'Raw Foods', qualityAttributes: { organic: true, grade: 'A' }, unit: 'kg', price: 12, minimumOrderQuantity: 10, availableCapacity: 100, leadDays: 4 }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.verificationStatus, 'pending');
  assert.equal((await request('/api/supplier/catalog', { as: 'Buyer' })).response.status, 403);
  assert.equal((await request(`/api/supplier/catalog/${created.body.id}`, { as: 'Other Supplier', method: 'PATCH', body: JSON.stringify({ availableCapacity: 50 }) })).response.status, 404);
  assert.deepEqual((await request('/api/supplier/catalog', { as: 'Supplier' })).body.products.map((product) => product.id), [created.body.id]);
  assert.equal((await request('/api/admin/supplier-submissions', { as: 'Administrator' })).body.suppliers.some((item) => item.id === profile.body.id), true);
  assert.equal((await request(`/api/admin/supplier-products/${created.body.id}/review`, { as: 'Supplier', method: 'POST', body: JSON.stringify({ decision: 'approve' }) })).response.status, 403);
  assert.equal((await request(`/api/admin/suppliers/${profile.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'reject' }) })).response.status, 400, 'rejections require a reason');
  assert.equal((await request(`/api/admin/supplier-products/${created.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) })).response.status, 409, 'catalog products cannot be approved before the supplier profile');

  await request(`/api/admin/suppliers/${profile.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  const approved = await request(`/api/admin/supplier-products/${created.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.equal(approved.body.verificationStatus, 'approved');
  const demand = await repository.createDemand({ item: 'Organic cane sugar', category: 'Raw Foods', qualityRequirements: { organic: true }, qty: 80, unit: 'kg', due: '2026-12-31' });
  let matches = await repository.matchDemand(demand.id);
  assert.deepEqual(matches.matches.map((item) => item.productId), [created.body.id]);

  const inventory = await request(`/api/supplier/catalog/${created.body.id}`, { as: 'Supplier', method: 'PATCH', body: JSON.stringify({ availableCapacity: 50 }) });
  assert.equal(inventory.body.verificationStatus, 'approved', 'capacity-only edits preserve approval');
  matches = await repository.matchDemand(demand.id);
  assert.equal(matches.summary.fullyCoverable, false);
  assert.equal(matches.matches[0].capacity, 50);
  await request(`/api/supplier/catalog/${created.body.id}`, { as: 'Supplier', method: 'PATCH', body: JSON.stringify({ availableCapacity: 100 }) });

  const edited = await request(`/api/supplier/catalog/${created.body.id}`, { as: 'Supplier', method: 'PATCH', body: JSON.stringify({ productName: 'Organic cane sugar refined', category: 'Raw Foods', qualityAttributes: { organic: true, grade: 'A' }, unit: 'kg', price: 12, minimumOrderQuantity: 10, availableCapacity: 100, leadDays: 4 }) });
  assert.equal(edited.body.verificationStatus, 'pending', 'catalog identity or commercial edits require review');
  assert.equal((await repository.matchDemand(demand.id)).matches.length, 0);
  await request(`/api/admin/supplier-products/${created.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.equal((await repository.matchDemand(demand.id)).matches.length, 0, 'renamed product no longer falsely matches the old demand item');

  const otherProfile = await request('/api/suppliers', { as: 'Other Supplier', method: 'POST', body: JSON.stringify({ name: 'Rejected Supplier', category: 'Raw Foods', location: 'Nashik' }) });
  const rejectedProduct = await request('/api/supplier/catalog', { as: 'Other Supplier', method: 'POST', body: JSON.stringify({ productName: 'Organic cane sugar', category: 'Raw Foods', qualityAttributes: { organic: true }, unit: 'kg', price: 11, minimumOrderQuantity: 1, availableCapacity: 500, leadDays: 3 }) });
  await request(`/api/admin/suppliers/${otherProfile.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'reject', reason: 'Supplier documents could not be verified.' }) });
  const rejection = await request(`/api/admin/supplier-products/${rejectedProduct.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'reject', reason: 'Catalog quality evidence was incomplete.' }) });
  assert.equal(rejection.body.verificationStatus, 'rejected');
  assert.equal((await repository.matchDemand(demand.id)).matches.length, 0, 'rejected supplier and catalogue entries remain ineligible');
  const profileResubmission = await request('/api/suppliers', { as: 'Other Supplier', method: 'PATCH', body: JSON.stringify({ name: 'Corrected Supplier', category: 'Raw Foods', location: 'Nashik' }) });
  assert.equal(profileResubmission.response.status, 200);
  assert.equal(profileResubmission.body.verificationStatus, 'pending');
  const productResubmission = await request(`/api/supplier/catalog/${rejectedProduct.body.id}`, { as: 'Other Supplier', method: 'PATCH', body: JSON.stringify({ productName: 'Organic cane sugar', category: 'Raw Foods', qualityAttributes: { organic: true }, unit: 'kg', price: 11, minimumOrderQuantity: 1, availableCapacity: 500, leadDays: 3 }) });
  assert.equal(productResubmission.body.verificationStatus, 'pending');
  assert.equal((await repository.matchDemand(demand.id)).matches.length, 0, 'resubmitted entries remain ineligible pending review');
  await request(`/api/admin/suppliers/${otherProfile.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.equal((await repository.matchDemand(demand.id)).matches.length, 0, 'approved profile does not bypass product review');
  await request(`/api/admin/supplier-products/${rejectedProduct.body.id}/review`, { as: 'Administrator', method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.equal((await repository.matchDemand(demand.id)).matches.length, 1, 'corrected profile and product enter matching only after approval');
  const adminBootstrap = await request('/api/bootstrap', { as: 'Administrator' });
  assert.ok(adminBootstrap.body.audit.some((entry) => entry.action === 'Supplier submission rejected' && entry.entity === otherProfile.body.id));
  assert.ok(adminBootstrap.body.audit.some((entry) => entry.action === 'Supplier catalogue product rejected' && entry.entity === rejectedProduct.body.id));
  assert.ok(adminBootstrap.body.audit.some((entry) => entry.action === 'Supplier profile corrected and resubmitted for review' && entry.entity === otherProfile.body.id));
});

test('migrations and importer preserve existing data and reserve imported order capacity', async (t) => {
  const fixture = await startFixture({ seed: false });
  t.after(() => stopFixture(fixture));
  const { pool } = fixture;
  assert.deepEqual(await applyMigrations(pool), [], 'migrations are safe to repeat');
  const sourcePath = path.join(__dirname, '..', 'data.json');
  const originalData = fs.readFileSync(sourcePath, 'utf8');
  const importedProjectData = await importJsonData(pool, JSON.parse(originalData));
  assert.equal(importedProjectData.demands, 2);
  assert.equal(importedProjectData.suppliers, 4);
  assert.equal(importedProjectData.orders, 1);
  assert.equal(importedProjectData.allocations, 1);
  assert.equal(Number((await pool.query("SELECT available_capacity FROM suppliers WHERE id='SUP-001'")).rows[0].available_capacity), 8000);
  const importData = {
    suppliers: [{ id: 'SUP-900', name: 'Imported supplier', category: 'Materials', location: 'India', rating: 4.1, capacity: 1000, price: 10, lead: 5, verified: true, capacityUnit: 'kg', products: ['Imported-item'] }],
    demands: [{ id: 'DEM-9000', buyer: 'Importer', item: 'Imported item', qty: 10, unit: 'kg', destination: 'Test', due: '2026-12-31', status: 'Matching', created: '2026-11-05T00:00:00.000Z' }],
    orders: [{ id: 'PO-9000', demandId: 'DEM-9000', item: 'Imported item', qty: 10, allocations: [{ supplier: 'Imported supplier', supplierId: 'SUP-900', qty: 10, price: 10, lead: 5, subtotal: 100 }], total: 100, status: 'Approved', created: '2026-11-05T00:00:00.000Z' }],
    shipments: [{ id: 'SHP-9000', orderId: 'PO-9000', carrier: 'Importer Freight', status: 'Delivered', origin: 'Test origin', destination: 'Test', eta: '2026-12-31' }],
    audit: [{ id: crypto.randomUUID(), action: 'Imported event', entity: 'PO-9000', at: '2026-11-05T00:00:00.000Z' }],
  };
  const inserted = await importJsonData(pool, importData);
  assert.equal(inserted.allocations, 1);
  assert.equal(Number((await pool.query("SELECT available_capacity FROM suppliers WHERE id='SUP-900'")).rows[0].available_capacity), 990);
  const importedCatalogue = await pool.query("SELECT available_capacity,verification_status FROM supplier_products WHERE supplier_id='SUP-900' AND product_name='Imported-item'");
  assert.equal(importedCatalogue.rowCount, 1);
  assert.equal(Number(importedCatalogue.rows[0].available_capacity), 990, 'legacy allocation reduces corresponding catalogue inventory');
  assert.equal(importedCatalogue.rows[0].verification_status, 'pending', 'imported products are never auto-approved');
  const insufficientCatalogImport = {
    suppliers: [{ id: 'SUP-901', name: 'Limited importer supplier', category: 'Materials', location: 'India', rating: 4, capacity: 100, price: 10, lead: 5, capacityUnit: 'kg', catalogProducts: [{ productName: 'Short-item', availableCapacity: 5 }] }],
    demands: [{ id: 'DEM-9001', buyer: 'Importer', item: 'Short item', qty: 10, unit: 'kg', destination: 'Test', due: '2026-12-31' }],
    orders: [{ id: 'PO-9001', demandId: 'DEM-9001', item: 'Short item', qty: 10, allocations: [{ supplier: 'Limited importer supplier', supplierId: 'SUP-901', qty: 10, price: 10 }], total: 100 }],
  };
  await assert.rejects(importJsonData(pool, insufficientCatalogImport), /exceeds matching catalogue capacity/);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM suppliers WHERE id='SUP-901'")).rows[0].count, 0, 'failed import rolls back supplier and catalogue writes');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM purchase_orders WHERE id='PO-9001'")).rows[0].count, 0, 'failed import leaves no partial purchase order');
  await pool.query("UPDATE demands SET status='Approved' WHERE id='DEM-9000'");
  const repeated = await importJsonData(pool, importData);
  assert.equal(repeated.suppliers + repeated.demands + repeated.orders + repeated.allocations + repeated.shipments + repeated.audit, 0);
  assert.equal((await pool.query("SELECT status FROM demands WHERE id='DEM-9000'")).rows[0].status, 'Approved');
  assert.equal(Number((await pool.query("SELECT available_capacity FROM suppliers WHERE id='SUP-900'")).rows[0].available_capacity), 990);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), originalData, 'the actual local data.json importer source is unchanged');
});
