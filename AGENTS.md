# TeleDrive — agent notes

## Stack
Node ≥20.19 + TypeScript strict ESM. Server: Fastify 5 + better-sqlite3 + undici + zod + pino + sharp, tests vitest (mock Bot API in `server/src/dev/mockBotApi.ts`). Web: React 19 + Vite 8 + Tailwind v4 (@tailwindcss/vite) + TanStack Query + Zustand + react-router v7, lint oxlint.

## Commands (repo root)
- `npm run dev:mock` — mock Bot API (8082) + server (8080) + Vite (5173); login admin/admin12345
- `npm test` · `npm run typecheck` · `npm run lint` · `npm run build`
- CLIs: `doctor`, `bots:logout -- --yes`, `hash-password`, `channel:find`, `backup` (`npm run <name> --`)

## Conventions
- Pinned deps only, prefer versions ≥7 days old, Node 20.19 compatible (check `npm view <pkg> time` + engines). No `latest`.
- API errors: `{error:{code,message}}`; DTOs camelCase; timestamps unix ms.
- Mutating requests need header `X-Requested-With: teledrive`.
- Token safety: mask as `123456:***`; never log/print `.env`/`.env.old` contents.
- ids = crypto.randomUUID; share tokens = base64url(16B); scrypt$N$r$p$salt$hash passwords.
- Tests use temp DATA_DIR + `startMockBotApi`; `loadConfig(overrides)` for byte sizes.
- Don't commit `.env`, `data/`; keep edits focused, follow existing style.
