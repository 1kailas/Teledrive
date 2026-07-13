/**
 * TeleDrive Worker — Auth Routes
 *
 * Handles JWT verification and user session management.
 * These routes are NOT protected by the auth middleware.
 */

import { Hono } from 'hono';
import * as jose from 'jose';
import type { AppType } from '../index.js';
import { TelegramService } from '../services/telegram.js';

export const authRoutes = new Hono<AppType>();

/**
 * GET /api/auth/bot-info
 * Returns the bot's numeric ID (public, no auth needed).
 * The bot ID is the number before the ":" in the bot token.
 */
authRoutes.get('/bot-info', (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  const botId = TelegramService.getPrimaryBotId(botToken);
  return c.json({ success: true, data: { botId } });
});

async function verifyTelegramAuth(data: any, botToken: string): Promise<boolean> {
  const { hash, ...rest } = data;
  if (!hash) return false;

  const dataCheckArr = [];
  for (const key of Object.keys(rest).sort()) {
    dataCheckArr.push(`${key}=${rest[key]}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const encoder = new TextEncoder();
  const secretKeyHash = await crypto.subtle.digest('SHA-256', encoder.encode(botToken));
  
  const key = await crypto.subtle.importKey(
    'raw',
    secretKeyHash,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(dataCheckString));
  const hexSignature = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return hexSignature === hash;
}

/**
 * POST /api/auth/telegram-login
 * Verifies Telegram Web Login data and returns a JWT token.
 */
authRoutes.post('/telegram-login', async (c) => {
  try {
    const data = await c.req.json();
    
    // 1. Verify Telegram payload
    const isValid = await verifyTelegramAuth(data, c.env.TELEGRAM_BOT_TOKEN);
    if (!isValid) {
      return c.json({ success: false, error: 'Invalid Telegram authentication data' }, 401);
    }

    // 2. Check auth_date to prevent replay attacks
    // In production: 5 minutes. In development: 24 hours.
    const now = Math.floor(Date.now() / 1000);
    const maxAge = c.env.ENVIRONMENT === 'production' ? 300 : 86400;
    if (now - Number(data.auth_date) > maxAge) {
      return c.json({ success: false, error: 'Authentication data expired' }, 401);
    }

    // 3. Security: Check if user matches TELEGRAM_CHAT_ID 
    // (Only the admin can log in to their own TeleDrive)
    if (data.id.toString() !== c.env.TELEGRAM_CHAT_ID.toString()) {
      return c.json({ success: false, error: 'Unauthorized user' }, 403);
    }

    // 4. Upsert user in DB
    const userId = data.id.toString();
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!existing) {
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, telegram_chat_id, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`
      )
        .bind(userId, null, c.env.TELEGRAM_CHAT_ID)
        .run();
    }

    // 5. Generate JWT token
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const token = await new jose.SignJWT({
      sub: userId,
      name: [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(secret);

    return c.json({
      success: true,
      data: { token }
    });
  } catch (err: any) {
    return c.json({ success: false, error: 'Login failed', message: err.message }, 500);
  }
});

/**
 * POST /api/auth/dev-login
 * Fallback login using the JWT_SECRET as a password for local dev.
 */
authRoutes.post('/dev-login', async (c) => {
  try {
    const { password } = await c.req.json<{ password?: string }>();
    if (!password) {
      return c.json({ success: false, error: 'Password required' }, 400);
    }

    if (password !== c.env.JWT_SECRET) {
      return c.json({ success: false, error: 'Invalid passcode (must match JWT_SECRET)' }, 401);
    }

    const userId = c.env.TELEGRAM_CHAT_ID.toString();
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();

    if (!existing) {
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, telegram_chat_id, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`
      )
        .bind(userId, null, c.env.TELEGRAM_CHAT_ID)
        .run();
    }

    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const token = await new jose.SignJWT({
      sub: userId,
      name: 'Admin Developer',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(secret);

    return c.json({
      success: true,
      data: { token }
    });
  } catch (err: any) {
    return c.json({ success: false, error: 'Dev login failed', message: err.message }, 500);
  }
});

/**
 * POST /api/auth/verify
 * Verify a JWT token and return the user info.
 */
authRoutes.post('/verify', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Missing Authorization header' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });

    if (!payload.sub) {
      return c.json({ success: false, error: 'Invalid token' }, 401);
    }

    return c.json({
      success: true,
      data: {
        id: payload.sub,
        name: typeof payload.name === 'string' ? payload.name : null,
        email: typeof payload.email === 'string' ? payload.email : null,
      },
    });
  } catch (err: any) {
    return c.json({ success: false, error: 'Invalid or expired token', message: err.message }, 401);
  }
});

/**
 * GET /api/auth/me
 * Returns the current user info (requires valid JWT in header).
 */
authRoutes.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });

    if (!payload.sub) {
      return c.json({ success: false, error: 'Invalid token' }, 401);
    }

    const user = await c.env.DB.prepare(
      'SELECT id, email, created_at FROM users WHERE id = ?'
    )
      .bind(payload.sub)
      .first<{ id: string; email: string | null; created_at: string }>();

    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...user,
        name: typeof payload.name === 'string' ? payload.name : null,
      },
    });
  } catch (err: any) {
    return c.json({ success: false, error: 'Invalid or expired token', message: err.message }, 401);
  }
});
