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
  if (path === '/api/health' || path.startsWith('/api/auth')) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      {
        success: false,
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header',
      },
      401
    );
  }

  const token = authHeader.substring(7);

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
