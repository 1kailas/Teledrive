import * as crypto from 'crypto';

// The secret must match JWT_SECRET in your worker/.dev.vars or Wrangler environment
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-me';
const USER_ID = process.env.USER_ID || 'user_123';
const USER_EMAIL = process.env.USER_EMAIL || 'admin@example.com';

function generateToken() {
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };

  const payload = {
    sub: USER_ID,
    email: USER_EMAIL,
    name: 'Admin User',
    iat: Math.floor(Date.now() / 1000),
    // Token expires in 30 days
    exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
  };

  const base64UrlEncode = (obj) => {
    return Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  };

  const encodedHeader = base64UrlEncode(header);
  const encodedPayload = base64UrlEncode(payload);

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

const token = generateToken();
console.log('\n--- TeleDrive JWT Token ---');
console.log(token);
console.log('---------------------------\n');
console.log('1. Copy this token and paste it into the TeleDrive Login page.');
console.log('2. Make sure the JWT_SECRET used here matches the JWT_SECRET in your worker environment.');
