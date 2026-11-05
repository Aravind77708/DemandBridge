require('./env');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createPool, applyMigrations } = require('./database');
const { Repository } = require('./database/repository');
const { normalizeText } = require('./database/matching');
const { createAuth, verifyPassword, DUMMY_PASSWORD_HASH } = require('./auth');

const DEFAULT_CORS = 'http://localhost:4173,http://127.0.0.1:4173';
const ALL_SIGNED_IN = ['Buyer', 'Supplier', 'Procurement Manager', 'Logistics Provider', 'Administrator'];
const demoAccountsAllowed = () => process.env.DEMO_AUTH_ENABLED === 'true' && ['development', 'test'].includes(process.env.NODE_ENV);

function createLoginRateLimiter({ limit = 10, windowMs = 15 * 60 * 1000, maxKeys = 10000, now = Date.now } = {}) {
  const attempts = new Map();
  return {
    consume(key) {
      const current = now();
      const record = attempts.get(key);
      if (record && record.expiresAt > current) {
        if (record.count >= limit) return Math.max(1, Math.ceil((record.expiresAt - current) / 1000));
        record.count += 1;
        return 0;
      }
      if (attempts.size >= maxKeys) {
        for (const [savedKey, saved] of attempts) {
          if (saved.expiresAt <= current || attempts.size >= maxKeys) attempts.delete(savedKey);
          if (attempts.size < maxKeys) break;
        }
      }
      attempts.set(key, { count: 1, expiresAt: current + windowMs });
      return 0;
    },
    reset(key) { attempts.delete(key); },
  };
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
    ...(process.env.NODE_ENV === 'production' ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function isNumericInput(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
}
function isPlainRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isCoordinatesValid(data) {
  const hasLatitude = data.latitude !== undefined && data.latitude !== null && data.latitude !== '';
  const hasLongitude = data.longitude !== undefined && data.longitude !== null && data.longitude !== '';
  if (hasLatitude !== hasLongitude) return false;
  if (!hasLatitude) return true;
  return isNumericInput(data.latitude) && isNumericInput(data.longitude) && Number(data.latitude) >= -90 && Number(data.latitude) <= 90 && Number(data.longitude) >= -180 && Number(data.longitude) <= 180;
}
function parseList(value) {
  if (value === undefined || value === '') return [];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!list || list.length > 50 || list.some((item) => typeof item !== 'string' || !item.trim() || item.length > 160)) return null;
  const seen = new Set();
  return list.map((item) => item.trim()).filter((item) => {
    const key = normalizeText(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function isSafeMatchObject(value, depth = 0) {
  if (!isPlainRecord(value) || depth > 5 || Object.keys(value).length > 50) return false;
  return Object.values(value).every((item) => {
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= 200)) return true;
    if (Array.isArray(item)) return item.length <= 50 && item.every((entry) => typeof entry === 'string' && entry.length <= 200);
    return isSafeMatchObject(item, depth + 1);
  });
}
const CATALOGUE_FIELDS = ['productName','category','qualityAttributes','unit','price','minimumOrderQuantity','availableCapacity','leadDays'];
function isValidCatalogueProduct(data, partial = false) {
  if (!isPlainRecord(data)) return false;
  const keys = Object.keys(data);
  if (!keys.length || keys.some((key) => !CATALOGUE_FIELDS.includes(key))) return false;
  if (!partial && CATALOGUE_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(data,key))) return false;
  for (const key of ['productName','category','unit']) {
    if (key in data && (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > ({productName:160,category:100,unit:24})[key])) return false;
  }
  if ('qualityAttributes' in data && !isSafeMatchObject(data.qualityAttributes)) return false;
  for (const key of ['price','minimumOrderQuantity','availableCapacity']) {
    if (key in data && (!isNumericInput(data[key]) || Number(data[key]) < 0 || Number(data[key]) > 100000000)) return false;
  }
  if ('leadDays' in data && (!isNumericInput(data.leadDays) || !Number.isInteger(Number(data.leadDays)) || Number(data.leadDays) < 0 || Number(data.leadDays) > 3650)) return false;
  return true;
}
function normalizeCatalogueProduct(data) {
  const output = { ...data };
  for (const key of ['price','minimumOrderQuantity','availableCapacity','leadDays']) if (key in output) output[key] = Number(output[key]);
  return output;
}
function isValidReview(data) {
  return isPlainRecord(data) && ['approve','reject'].includes(data.decision) &&
    (data.reason === undefined || (typeof data.reason === 'string' && data.reason.length <= 500)) &&
    (data.decision !== 'reject' || (typeof data.reason === 'string' && Boolean(data.reason.trim())));
}
function decodeRoutePart(value) {
  try { return decodeURIComponent(value); }
  catch { throw Object.assign(new Error('Invalid URL encoding'), { status: 400 }); }
}

function routeRoles(method, route) {
  if (method === 'GET' && route === '/api/bootstrap') return ALL_SIGNED_IN;
  if (method === 'GET' && route === '/api/suppliers') return ALL_SIGNED_IN;
  if (method === 'PATCH' && route === '/api/suppliers') return ['Supplier'];
  if (method === 'GET' && route === '/api/audit') return ['Procurement Manager', 'Administrator'];
  if (method === 'GET' && route === '/api/supplier/catalog') return ['Supplier'];
  if (method === 'POST' && route === '/api/supplier/catalog') return ['Supplier'];
  if (method === 'PATCH' && /^\/api\/supplier\/catalog\/[^/]+$/.test(route)) return ['Supplier'];
  if (method === 'GET' && route === '/api/admin/supplier-submissions') return ['Administrator'];
  if (method === 'POST' && /^\/api\/admin\/suppliers\/[^/]+\/review$/.test(route)) return ['Administrator'];
  if (method === 'POST' && /^\/api\/admin\/supplier-products\/[^/]+\/review$/.test(route)) return ['Administrator'];
  if (method === 'POST' && route === '/api/demands') return ['Buyer', 'Administrator'];
  if (method === 'POST' && route === '/api/suppliers') return ['Supplier', 'Administrator'];
  if (method === 'GET' && route.startsWith('/api/match/')) return ['Buyer', 'Procurement Manager', 'Administrator'];
  if (method === 'POST' && route === '/api/allocate') return ['Procurement Manager', 'Administrator'];
  if (method === 'POST' && /^\/api\/orders\/[^/]+\/approve$/.test(route)) return ['Procurement Manager', 'Administrator'];
  if (method === 'POST' && route === '/api/shipments') return ['Logistics Provider', 'Administrator'];
  if (method === 'PATCH' && /^\/api\/shipments\/[^/]+$/.test(route)) return ['Logistics Provider', 'Administrator'];
  return null;
}

async function getAuthenticatedUser(req, repository, auth) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) return null;
  try {
    const claims = auth.verify(match[1]);
    const user = await repository.findUserById(claims.sub);
    if (!user || user.email.toLowerCase() !== claims.email.toLowerCase() || user.role !== claims.role) return null;
    if (user.is_demo && !demoAccountsAllowed()) return null;
    return user;
  } catch { return null; }
}

function corsHeaders(req, origins) {
  const headers = { 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' };
  const origin = req.headers.origin;
  if (origin && origins.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  return headers;
}
function json(req, res, status, body, origins) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...securityHeaders(), ...corsHeaders(req, origins) });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function createHandler({ repository, auth = createAuth(), publicDir = path.join(__dirname, 'public'), corsOrigins = process.env.CORS_ORIGINS || DEFAULT_CORS, loginLimiter = createLoginRateLimiter() } = {}) {
  if (!repository) throw new Error('A PostgreSQL repository is required.');
  const allowedOrigins = new Set(corsOrigins.split(',').map((origin) => origin.trim()).filter(Boolean));
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...securityHeaders(), ...corsHeaders(req, allowedOrigins) });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    try {
      let authenticatedUser = null;
      if (route === '/api/health' && req.method === 'GET') {
        try { return json(req, res, 200, await repository.health(), allowedOrigins); }
        catch { return json(req, res, 503, { ok: false, db: 'postgres', error: 'Database unavailable', time: new Date().toISOString() }, allowedOrigins); }
      }
      if (route === '/api/demo-login' && req.method === 'POST') {
        const data = await readBody(req);
        if (typeof data.email !== 'string' || typeof data.password !== 'string' || data.email.length > 320 || data.password.length > 1024) {
          return json(req, res, 400, { error: 'Email and password are required' }, allowedOrigins);
        }
        const email = data.email.trim().toLowerCase();
        const retryAfter = loginLimiter.consume(email);
        if (retryAfter) {
          res.setHeader('retry-after', String(retryAfter));
          return json(req, res, 429, { error: 'Too many login attempts. Try again later.' }, allowedOrigins);
        }
        const user = await repository.findUserByEmail(email);
        const validPassword = await verifyPassword(data.password, user?.password_hash || DUMMY_PASSWORD_HASH);
        if (!user || !validPassword || (user.is_demo && !demoAccountsAllowed())) {
          return json(req, res, 401, { error: 'Invalid email or password' }, allowedOrigins);
        }
        loginLimiter.reset(email);
        const token = auth.issue(user);
        return json(req, res, 200, { token, user: { name: user.display_name, role: user.role, email: user.email } }, allowedOrigins);
      }

      const allowedRoles = routeRoles(req.method, route);
      if (route.startsWith('/api/') && route !== '/api/health' && route !== '/api/demo-login') {
        if (!allowedRoles) return json(req, res, 404, { error: 'Not found' }, allowedOrigins);
        authenticatedUser = await getAuthenticatedUser(req, repository, auth);
        if (!authenticatedUser) return json(req, res, 401, { error: 'Authentication required' }, allowedOrigins);
        if (!allowedRoles.includes(authenticatedUser.role)) return json(req, res, 403, { error: 'Insufficient role permissions' }, allowedOrigins);
      }
      if (route === '/api/bootstrap' && req.method === 'GET') return json(req, res, 200, await repository.bootstrap(authenticatedUser.role, authenticatedUser.id), allowedOrigins);
      if (route === '/api/suppliers' && req.method === 'GET') return json(req, res, 200, await repository.getSuppliers(authenticatedUser.role), allowedOrigins);
      if (route === '/api/audit' && req.method === 'GET') return json(req, res, 200, await repository.getAudit(), allowedOrigins);
      if (route === '/api/demands' && req.method === 'POST') {
        const data = await readBody(req);
        if (typeof data.item !== 'string' || !data.item.trim() || data.item.length > 160 || !isNumericInput(data.qty) || Number(data.qty) <= 0 || Number(data.qty) > 100000000 || (data.unit !== undefined && (typeof data.unit !== 'string' || data.unit.length > 24)) || (data.destination !== undefined && (typeof data.destination !== 'string' || !data.destination.trim() || data.destination.length > 160)) || (data.due !== undefined && !isValidDateOnly(data.due)) || (data.category !== undefined && (typeof data.category !== 'string' || data.category.length > 100)) || (data.qualityRequirements !== undefined && !isSafeMatchObject(data.qualityRequirements)) || !isCoordinatesValid(data)) return json(req, res, 400, { error: 'Enter an item, positive quantity, and valid optional category, quality, location, and deadline details' }, allowedOrigins);
        for (const key of ['latitude', 'longitude']) if (data[key] === '') data[key] = undefined;
        return json(req, res, 201, await repository.createDemand(data, authenticatedUser), allowedOrigins);
      }
      if (route === '/api/suppliers' && req.method === 'POST') {
        const data = await readBody(req);
        const products = parseList(data.products);
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 160 || typeof data.category !== 'string' || !data.category.trim() || data.category.length > 80 || typeof data.location !== 'string' || !data.location.trim() || data.location.length > 160 || (data.capacity !== undefined && (!isNumericInput(data.capacity) || Number(data.capacity) < 0 || Number(data.capacity) > 100000000)) || (data.price !== undefined && (!isNumericInput(data.price) || Number(data.price) < 0 || Number(data.price) > 100000000)) || (data.lead !== undefined && (!isNumericInput(data.lead) || !Number.isInteger(Number(data.lead)) || Number(data.lead) < 0 || Number(data.lead) > 3650)) || products === null || (data.qualityAttributes !== undefined && !isSafeMatchObject(data.qualityAttributes)) || (data.minimumOrderQuantity !== undefined && (!isNumericInput(data.minimumOrderQuantity) || Number(data.minimumOrderQuantity) < 0 || Number(data.minimumOrderQuantity) > 100000000)) || (data.capacityUnit !== undefined && (typeof data.capacityUnit !== 'string' || !data.capacityUnit.trim() || data.capacityUnit.length > 24)) || !isCoordinatesValid(data)) return json(req, res, 400, { error: 'Enter a name, category, location, and valid optional catalogue, inventory, quality, unit, and coordinates' }, allowedOrigins);
        for (const key of ['latitude', 'longitude']) if (data[key] === '') data[key] = undefined;
        const result = await repository.createSupplier({ ...data, products, qualityAttributes: data.qualityAttributes || {} }, authenticatedUser);
        if (result.error) return json(req, res, result.status, { error: result.error }, allowedOrigins);
        return json(req, res, 201, result, allowedOrigins);
      }
      if (route === '/api/suppliers' && req.method === 'PATCH') {
        const data = await readBody(req);
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 160 || typeof data.category !== 'string' || !data.category.trim() || data.category.length > 80 || typeof data.location !== 'string' || !data.location.trim() || data.location.length > 160 || Object.keys(data).some((key) => !['name','category','location','latitude','longitude'].includes(key)) || !isCoordinatesValid(data)) return json(req,res,400,{error:'Provide a valid supplier name, category, location, and optional coordinate pair'},allowedOrigins);
        for (const key of ['latitude','longitude']) if (data[key] === '') data[key] = undefined;
        const result = await repository.updateSupplierProfile(authenticatedUser.id,data);
        return result ? json(req,res,200,result,allowedOrigins) : json(req,res,404,{error:'Supplier profile not found for this account'},allowedOrigins);
      }
      if (route === '/api/supplier/catalog' && req.method === 'GET') return json(req,res,200,await repository.getSupplierWorkspace(authenticatedUser.id),allowedOrigins);
      if (route === '/api/supplier/catalog' && req.method === 'POST') {
        const data = await readBody(req);
        if (!isValidCatalogueProduct(data)) return json(req,res,400,{error:'Provide product name, category, quality attributes, unit, nonnegative price, MOQ, capacity, and lead time'},allowedOrigins);
        const result = await repository.createSupplierProduct(authenticatedUser.id, normalizeCatalogueProduct(data));
        if (result.error) return json(req,res,result.status,{error:result.error},allowedOrigins);
        return json(req,res,201,result,allowedOrigins);
      }
      const supplierProductMatch = route.match(/^\/api\/supplier\/catalog\/([^/]+)$/);
      if (supplierProductMatch && req.method === 'PATCH') {
        const data = await readBody(req);
        if (!isValidCatalogueProduct(data,true)) return json(req,res,400,{error:'Catalogue updates contain invalid or unsupported fields'},allowedOrigins);
        const result = await repository.updateSupplierProduct(authenticatedUser.id,decodeRoutePart(supplierProductMatch[1]),normalizeCatalogueProduct(data));
        return result ? json(req,res,200,result,allowedOrigins) : json(req,res,404,{error:'Catalogue product not found for this supplier account'},allowedOrigins);
      }
      if (route === '/api/admin/supplier-submissions' && req.method === 'GET') return json(req,res,200,await repository.getSupplierSubmissions(),allowedOrigins);
      const reviewSupplierMatch = route.match(/^\/api\/admin\/suppliers\/([^/]+)\/review$/);
      if (reviewSupplierMatch && req.method === 'POST') {
        const data = await readBody(req);
        if (!isValidReview(data)) return json(req,res,400,{error:'Choose approve or reject and provide a valid review reason'},allowedOrigins);
        const result = await repository.reviewSupplier(decodeRoutePart(reviewSupplierMatch[1]),data.decision,data.reason,authenticatedUser.id);
        return result.error ? json(req,res,result.status,{error:result.error},allowedOrigins) : json(req,res,200,result,allowedOrigins);
      }
      const reviewProductMatch = route.match(/^\/api\/admin\/supplier-products\/([^/]+)\/review$/);
      if (reviewProductMatch && req.method === 'POST') {
        const data = await readBody(req);
        if (!isValidReview(data)) return json(req,res,400,{error:'Choose approve or reject and provide a valid review reason'},allowedOrigins);
        const result = await repository.reviewSupplierProduct(decodeRoutePart(reviewProductMatch[1]),data.decision,data.reason,authenticatedUser.id);
        return result.error ? json(req,res,result.status,{error:result.error},allowedOrigins) : json(req,res,200,result,allowedOrigins);
      }
      if (route.startsWith('/api/match/') && req.method === 'GET') {
        const id = decodeRoutePart(route.slice('/api/match/'.length));
        const result = await repository.matchDemand(id, authenticatedUser.role, authenticatedUser.id);
        return result ? json(req, res, 200, result, allowedOrigins) : json(req, res, 404, { error: 'Demand not found' }, allowedOrigins);
      }
      if (route === '/api/allocate' && req.method === 'POST') {
        const { demandId } = await readBody(req);
        if (typeof demandId !== 'string' || !demandId.trim() || demandId.length > 160) return json(req, res, 400, { error: 'A valid demandId is required' }, allowedOrigins);
        const result = await repository.allocate(demandId);
        if (result.error) return json(req, res, result.status, { error: result.error, ...(result.matching ? { matching: result.matching } : {}) }, allowedOrigins);
        return json(req, res, 201, result, allowedOrigins);
      }
      const approveMatch = route.match(/^\/api\/orders\/([^/]+)\/approve$/);
      if (approveMatch && req.method === 'POST') {
        const result = await repository.approveOrder(decodeRoutePart(approveMatch[1]));
        return result ? json(req, res, 200, result, allowedOrigins) : json(req, res, 404, { error: 'Order not found' }, allowedOrigins);
      }
      if (route === '/api/shipments' && req.method === 'POST') {
        const data = await readBody(req);
        if (typeof data.orderId !== 'string' || !data.orderId.trim() || data.orderId.length > 160 || (data.carrier !== undefined && (typeof data.carrier !== 'string' || !data.carrier.trim() || data.carrier.length > 160)) || (data.destination !== undefined && (typeof data.destination !== 'string' || !data.destination.trim() || data.destination.length > 160)) || (data.eta !== undefined && !isValidDateOnly(data.eta))) return json(req, res, 400, { error: 'Enter a valid order, carrier, destination, and ETA' }, allowedOrigins);
        const result = await repository.createShipment(data);
        if (result.error) return json(req, res, result.status, { error: result.error }, allowedOrigins);
        return json(req, res, 201, result, allowedOrigins);
      }
      const shipmentMatch = route.match(/^\/api\/shipments\/([^/]+)$/);
      if (shipmentMatch && req.method === 'PATCH') {
        const data = await readBody(req);
        if (!['In transit', 'Delivered', 'Delayed'].includes(data.status)) return json(req, res, 400, { error: 'Shipment status must be In transit, Delivered, or Delayed' }, allowedOrigins);
        const result = await repository.updateShipment(decodeRoutePart(shipmentMatch[1]), data.status);
        return result ? json(req, res, 200, result, allowedOrigins) : json(req, res, 404, { error: 'Shipment not found' }, allowedOrigins);
      }
      if (route.startsWith('/api/')) return json(req, res, 404, { error: 'Not found' }, allowedOrigins);

      const candidate = path.resolve(publicDir, route === '/' ? 'index.html' : `.${decodeRoutePart(route)}`);
      const relative = path.relative(publicDir, candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return json(req, res, 403, { error: 'Forbidden' }, allowedOrigins);
      fs.readFile(candidate, (error, contents) => {
        if (error) { res.writeHead(404, securityHeaders()); return res.end('Not found'); }
        const type = candidate.endsWith('.css') ? 'text/css; charset=utf-8' : candidate.endsWith('.js') ? 'text/javascript; charset=utf-8' : candidate.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8';
        res.writeHead(200, { 'content-type': type, ...securityHeaders() });
        res.end(contents);
      });
    } catch (error) {
      if (!res.headersSent) json(req, res, error.status || 500, { error: error.status === 400 || error.status === 413 ? error.message : 'Internal server error' }, allowedOrigins);
      if (!error.status || error.status >= 500) console.error('Request failed:', error);
    }
  };
}

function createServer(options) {
  return http.createServer(createHandler(options));
}

async function start() {
  const pool = createPool();
  try {
    await applyMigrations(pool);
    await pool.query('SELECT 1');
    const repository = new Repository(pool);
    const auth = createAuth();
    const server = createServer({ repository, auth });
    const port = Number(process.env.PORT || 4173);
    const host = process.env.NODE_ENV === 'development' ? '127.0.0.1' : '0.0.0.0';
    server.listen(port, host, () => console.log(`DemandBridge API listening on http://${host}:${port}`));
    const shutdown = () => server.close(async () => { await pool.end(); process.exit(0); });
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (require.main === module) start().catch((error) => { console.error('DemandBridge startup failed:', error.message); process.exit(1); });
module.exports = { createHandler, createServer, start, routeRoles, getAuthenticatedUser, createLoginRateLimiter, securityHeaders };
