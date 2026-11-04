import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { deleteSession, listSessions, setSetting } from '../../db/repos/misc.js';
import { hashPassword, newSession, sessionFromToken, verifyAdminPassword } from '../auth.js';
import { badRequest, unauthorized } from '../errors.js';

const loginSchema = z.object({ username: z.string(), password: z.string() });
const passwordSchema = z.object({ currentPassword: z.string(), newPassword: z.string().min(10) });

// simple hourly login throttle (per IP) on top of the per-minute rate limit
const hourly = new Map<string, { count: number; reset: number }>();
function hourlyOk(ip: string): boolean {
  const now = Date.now();
  if (hourly.size > 1000) {
    for (const [k, v] of hourly) if (v.reset < now) hourly.delete(k);
  }
  const e = hourly.get(ip);
  if (!e || e.reset < now) {
    hourly.set(ip, { count: 1, reset: now + 3600_000 });
    return true;
  }
  e.count++;
  return e.count <= 20;
}

export function authCookieOpts(ctx: AppContext): Record<string, unknown> {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    path: '/',
    maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginSchema.safeParse(req.body);
      if (!body.success) throw badRequest('username and password required');
      if (!hourlyOk(req.ip)) throw unauthorized('too many login attempts');
      const { username, password } = body.data;
      const ok =
        username === ctx.config.adminUsername &&
        await verifyAdminPassword(ctx.db, ctx.config, password);
      if (!ok) throw unauthorized('invalid credentials');
      const { sessionId, token } = newSession(ctx, req.ip, req.headers['user-agent']);
      reply.setCookie('td_session', token, authCookieOpts(ctx));
      return { username, sessionId };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) deleteSession(ctx.db, req.session.id);
    reply.clearCookie('td_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.session) throw unauthorized();
    return { username: ctx.config.adminUsername, sessionId: req.session.id };
  });

  app.get('/api/auth/sessions', async (req) => {
    const sessions = listSessions(ctx.db).map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      ip: s.ip,
      userAgent: s.user_agent,
      current: req.session?.id === s.id,
    }));
    return { sessions };
  });

  app.delete('/api/auth/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    deleteSession(ctx.db, id);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const body = passwordSchema.safeParse(req.body);
    if (!body.success) throw badRequest('currentPassword and newPassword (>=10 chars) required');
    const { currentPassword, newPassword } = body.data;
    if (!await verifyAdminPassword(ctx.db, ctx.config, currentPassword)) {
      throw unauthorized('current password is wrong');
    }
    setSetting(ctx.db, 'password_hash', await hashPassword(newPassword));
    // revoke all sessions but the current one
    for (const s of listSessions(ctx.db)) {
      if (s.id !== req.session?.id) deleteSession(ctx.db, s.id);
    }
    return { ok: true };
  });
}
