import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { Logger } from './logger.js';
import type { AppContext } from './context.js';
import { BotPool } from './telegram/botPool.js';
import { parsePathMap } from './telegram/pathMap.js';
import { PartCache } from './services/partCache.js';
import { PartQueue } from './services/partQueue.js';
import { EventBus } from './services/events.js';
import { detectTools } from './services/media.js';
import { Scheduler } from './services/scheduler.js';
import { applyPersistedSettings } from './services/settings.js';

/** Wire up all services for a config. pool.init() must still be called. */
export function createContext(config: AppConfig, db: Db, logger: Logger): AppContext {
  // Runtime settings saved from the Settings screen win over env defaults so a
  // restart keeps the part size / concurrency the user picked.
  applyPersistedSettings(config, db);
  const pathMap = parsePathMap(config.telegramBotApiPathMap);
  const pool = new BotPool(config, db, logger, pathMap);
  const cache = new PartCache(config, db, pool, logger);
  const bus = new EventBus();
  const tools = detectTools(config, logger);
  const ctx: AppContext = {
    config,
    db,
    logger,
    pool,
    cache,
    queue: undefined as unknown as AppContext['queue'],
    bus,
    tools,
    pathMap,
    startedAt: Date.now(),
  };
  ctx.queue = new PartQueue(ctx);
  return ctx;
}

export { Scheduler };
