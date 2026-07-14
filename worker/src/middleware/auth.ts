/**
 * TeleDrive Worker — JWT Authentication Middleware
 *
 * Validates JWT tokens from the Authorization header.
 * Uses the `jose` library for standards-compliant JWT verification.
 * Skips auth routes and health checks.
 */

import { createMiddleware } from 'hono/factory';
import * as jose from 'jose';
import type { AppType } from '../index.js';

export const authMiddleware = createMiddleware<AppType>(async (c, next) => {
  // Skip auth for preflight requests
  if (c.req.method === 'OPTIONS') {
    return next();
  }

  // Skip auth for public routes (auth routes handled by separate router)
  const path = c.req.path;
  if (path === '/api/health' || path.startsWith('/api/auth') || path.startsWith('/api/share/public/')) {
    return next();
  }

  let token = '';
  const authHeader = c.req.header('Authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    // Fallback: check query parameter (e.g. for media tags or iframes)
    const queryToken = c.req.query('token');
    if (queryToken) {
      token = queryToken;
    }
  }

  if (!token) {
    return c.json(
      {
        success: false,
        error: 'Unauthorized',
        message: 'Missing or invalid token in Authorization header or query parameter',
      },
      401
    );
  }

  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });

    if (!payload.sub) {
      return c.json(
        {
          success: false,
          error: 'Unauthorized',
          message: 'Invalid token: missing subject',
        },
        401
      );
    }

    // Verify user exists in database to prevent foreign key errors (e.g. after database resets)
    const userExists = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(payload.sub)
      .first();

    if (!userExists) {
      if (payload.sub.toString() === c.env.TELEGRAM_CHAT_ID.toString()) {
        await c.env.DB.prepare(
          `INSERT INTO users (id, email, telegram_chat_id, created_at, updated_at)
           VALUES (?, ?, ?, datetime('now'), datetime('now'))`
        )
          .bind(payload.sub, null, c.env.TELEGRAM_CHAT_ID)
          .run();
      } else {
        return c.json(
          {
            success: false,
            error: 'Unauthorized',
            message: 'User record not found in database',
          },
          401
        );
      }
    }

    // Set user info on context for downstream handlers
    c.set('userId', payload.sub);
    if (payload.email && typeof payload.email === 'string') {
      c.set('userEmail', payload.email);
    }

    await next();
  } catch (error) {
    const message =
      error instanceof jose.errors.JWTExpired
        ? 'Token expired'
        : error instanceof jose.errors.JWTClaimValidationFailed
          ? 'Token validation failed'
          : 'Invalid token';

    return c.json(
      {
        success: false,
        error: 'Unauthorized',
        message,
      },
      401
    );
  }
});
