import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { Logger } from './logger.js';
import type { BotPool } from './telegram/botPool.js';
import type { PathMap } from './telegram/pathMap.js';
import type { PartCache } from './services/partCache.js';
import type { PartQueue } from './services/partQueue.js';
import type { EventBus } from './services/events.js';
import type { MediaTools } from './services/media.js';
import type { Scheduler } from './services/scheduler.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  logger: Logger;
  pool: BotPool;
  cache: PartCache;
  queue: PartQueue;
  bus: EventBus;
  tools: MediaTools;
  pathMap: PathMap | null;
  startedAt: number;
  scheduler?: Scheduler;
}
