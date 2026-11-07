const { createHmac, randomBytes, scrypt, timingSafeEqual } = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const scryptKey = (password, salt) =>
  new Promise((resolve, reject) =>
    scrypt(String(password), salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)))
  );

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const key = await scryptKey(password, Buffer.from(salt, 'base64url'));
  const want = Buffer.from(hash, 'base64url');
  return want.length === key.length && timingSafeEqual(want, key);
}

const randomToken = () => randomBytes(32).toString('base64url');

const hmac = (key, data) => createHmac('sha256', String(key)).update(String(data)).digest('base64url');

module.exports = { hashPassword, verifyPassword, randomToken, hmac };
