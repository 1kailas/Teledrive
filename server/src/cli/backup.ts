import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, REPO_ROOT, ConfigError } from '../config.js';
import { createLogger } from '../logger.js';
import { openDb } from '../db/index.js';
import { createContext } from '../bootstrap.js';
import { runBackup } from '../services/backup.js';

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(1);
  }
  const logger = createLogger(config!.logLevel, false);
  const db = openDb(config!.dataDir);
  const ctx = createContext(config!, db, logger);
  await ctx.pool.init();
  const result = await runBackup(ctx);
  if (result) console.log(`backup uploaded: ${result.fileName} (${result.size} bytes)`);
  else console.log('backup skipped/failed (see logs)');
  db.close();
  process.exit(result ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
