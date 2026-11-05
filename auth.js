const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);
const ROLES = ['Buyer', 'Supplier', 'Procurement Manager', 'Logistics Provider', 'Administrator'];
const ISSUER = 'demandbridge';
const AUDIENCE = 'demandbridge-api';
const PASSWORD_N = 16384;
const PASSWORD_R = 8;
const PASSWORD_P = 1;
const PASSWORD_BYTES = 64;
const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_HASH = crypto.scryptSync('demandbridge-invalid-user-placeholder', DUMMY_SALT, PASSWORD_BYTES, {
  N: PASSWORD_N, r: PASSWORD_R, p: PASSWORD_P, maxmem: 64 * 1024 * 1024,
});
const DUMMY_PASSWORD_HASH = `scrypt$${PASSWORD_N}$${PASSWORD_R}$${PASSWORD_P}$${DUMMY_SALT.toString('base64url')}$${DUMMY_HASH.toString('base64url')}`;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createAuth({ secret = process.env.AUTH_TOKEN_SECRET, now = () => Date.now(), ttlSeconds = 900 } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('AUTH_TOKEN_SECRET must contain at least 32 bytes of secret material.');
  }

  function sign(input) {
    return crypto.createHmac('sha256', secret).update(input).digest();
  }

  return {
    issue(user) {
      const issuedAt = Math.floor(now() / 1000);
      const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const payload = base64url(JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: user.id,
        email: user.email,
        role: user.role,
        iat: issuedAt,
        exp: issuedAt + ttlSeconds,
        jti: crypto.randomUUID(),
      }));
      const content = `${header}.${payload}`;
      return `${content}.${sign(content).toString('base64url')}`;
    },

    verify(token) {
      if (typeof token !== 'string' || token.length > 4096) throw new Error('Invalid bearer token.');
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid bearer token.');
      const content = `${parts[0]}.${parts[1]}`;
      const signature = Buffer.from(parts[2], 'base64url');
      if (!safeEqual(signature, sign(content))) throw new Error('Invalid bearer token.');
      let header;
      let claims;
      try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch { throw new Error('Invalid bearer token.'); }
      const nowSeconds = Math.floor(now() / 1000);
      if (header.alg !== 'HS256' || header.typ !== 'JWT' || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
          typeof claims.sub !== 'string' || typeof claims.email !== 'string' || !ROLES.includes(claims.role) ||
          !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > nowSeconds + 30 ||
          claims.exp <= nowSeconds || claims.exp <= claims.iat || claims.exp - claims.iat > 3600) {
        throw new Error('Invalid or expired bearer token.');
      }
      return claims;
    },
  };
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Password must be between 12 and 1024 characters.');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, PASSWORD_BYTES, { N: PASSWORD_N, r: PASSWORD_R, p: PASSWORD_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${PASSWORD_N}$${PASSWORD_R}$${PASSWORD_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const [algorithm, n, r, p, saltText, hashText, extra] = encoded.split('$');
  if (algorithm !== 'scrypt' || extra !== undefined || n !== String(PASSWORD_N) || r !== String(PASSWORD_R) || p !== String(PASSWORD_P)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltText, 'base64url');
    expected = Buffer.from(hashText, 'base64url');
  } catch { return false; }
  if (salt.length !== 16 || expected.length !== PASSWORD_BYTES) return false;
  const actual = await scryptAsync(password, salt, PASSWORD_BYTES, { N: PASSWORD_N, r: PASSWORD_R, p: PASSWORD_P, maxmem: 64 * 1024 * 1024 });
  return safeEqual(actual, expected);
}

module.exports = { createAuth, hashPassword, verifyPassword, DUMMY_PASSWORD_HASH, ROLES };
