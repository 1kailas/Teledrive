import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, maskToken, REPO_ROOT, ConfigError } from '../config.js';
import { BotApiClient } from '../telegram/botApi.js';

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

/**
 * Bots must be logged out of the cloud Bot API once before they can be used
 * with a self-hosted bot-api server. This calls logOut against
 * https://api.telegram.org for every configured token.
 */
async function main(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.log(
      'This will call logOut for every configured bot token against the CLOUD Bot API\n' +
        '(https://api.telegram.org). logOut is required once before a bot can work with a\n' +
        'self-hosted bot-api server; the bot will stop answering on the cloud API.\n\n' +
        'Run again with --yes to proceed.',
    );
    process.exit(1);
  }
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error((e as ConfigError | Error).message);
    process.exit(1);
  }
  let failed = 0;
  for (const token of config!.botTokens) {
    const client = new BotApiClient('https://api.telegram.org', token);
    try {
      await client.logOut();
      console.log(`✔ ${maskToken(token)} logged out`);
    } catch (e) {
      failed++;
      console.error(`✖ ${maskToken(token)}: ${(e as Error).message}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
