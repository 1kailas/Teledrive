/**
 * channel:find — discover the numeric id of your private channel.
 *
 * Each configured bot calls getUpdates (local Bot API URL first, then the
 * public cloud API if the local one is unreachable) and we list every
 * channel/group the bot has seen in channel_post / my_chat_member updates.
 * This is safe for a storage bot: TeleDrive never consumes updates.
 */
import { loadConfig } from '../config.js';

const mask = (t: string) => `${t.split(':')[0]}:***`;

interface TgUpdate {
  update_id: number;
  channel_post?: { chat: { id: number; title?: string; type: string } };
  my_chat_member?: { chat: { id: number; title?: string; type: string } };
}

async function getUpdates(baseUrl: string, token: string): Promise<TgUpdate[] | null> {
  try {
    const res = await fetch(`${baseUrl}/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 100 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
    return j.ok ? (j.result ?? []) : null;
  } catch {
    return null;
  }
}

export async function runChannelFind(args: string[] = []): Promise<void> {
  const tokenArg = args.find((a) => a.startsWith('--token='))?.split('=')[1];
  const cfg = loadConfig();
  const tokens = tokenArg ? [tokenArg] : cfg.botTokens;
  if (!tokens.length) {
    console.error('No bot tokens configured (TELEGRAM_BOT_TOKENS).');
    process.exitCode = 1;
    return;
  }

  const localUrl = cfg.telegramBotApiUrl.replace(/\/$/, '');
  const cloudUrl = 'https://api.telegram.org';
  const seen = new Map<string, { title?: string; type: string }>();
  let usedUrl: string | null = null;

  for (const token of tokens) {
    let updates = await getUpdates(localUrl, token);
    let via = localUrl;
    if (updates === null) {
      updates = await getUpdates(cloudUrl, token);
      via = cloudUrl;
    }
    if (updates === null) {
      console.log(`${mask(token)}: could not reach either the local Bot API or api.telegram.org`);
      continue;
    }
    usedUrl = via;
    for (const u of updates) {
      const chat = u.channel_post?.chat ?? u.my_chat_member?.chat;
      if (chat && (chat.type === 'channel' || chat.type === 'supergroup' || chat.type === 'group')) {
        seen.set(String(chat.id), { title: chat.title, type: chat.type });
      }
    }
  }

  console.log(`Updates fetched via: ${usedUrl ?? 'none'}`);
  if (seen.size === 0) {
    console.log('\nNo channels or groups seen yet.');
    console.log('Post any message in your private channel after adding every bot as an');
    console.log('admin (Post + Delete messages), then rerun:  npm run channel:find');
    return;
  }
  console.log('\nChannels/groups your bots can see:');
  for (const [id, c] of seen) {
    console.log(`  ${id}  ${c.title ?? '(untitled)'}  [${c.type}]`);
  }
  console.log('\nPut the private channel id into .env as TELEGRAM_CHANNEL_ID=<id>');
}

const invokedDirectly = process.argv[1]!.endsWith('channelFind.js') || process.argv[1]!.endsWith('channelFind.ts');
if (invokedDirectly) {
  void runChannelFind(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
