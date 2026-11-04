import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { loadConfig, maskToken, REPO_ROOT, type AppConfig } from '../config.js';
import { BotApiClient, TelegramError } from '../telegram/botApi.js';
import { spawnSync } from 'node:child_process';

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const ok = (m: string) => console.log(`  ✔ ${m}`);
const bad = (m: string) => console.log(`  ✖ ${m}`);
const info = (m: string) => console.log(`  - ${m}`);

let failures = 0;
const check = (cond: boolean, good: string, badMsg: string) => {
  if (cond) ok(good);
  else {
    bad(badMsg);
    failures++;
  }
};

function which(bin: string, args: string[] = ['-version']): boolean {
  try {
    const r = spawnSync(bin, args, { timeout: 10_000, stdio: 'ignore' });
    return !r.error;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('TeleDrive doctor\n');

  let config: AppConfig;
  try {
    config = loadConfig();
    ok('configuration valid');
  } catch (e) {
    bad((e as Error).message);
    process.exit(1);
  }

  console.log('\nTelegram bot-api server:');
  let reachable = false;
  const probeToken = config.botTokens[0];
  if (probeToken) {
    const probe = new BotApiClient(config.telegramBotApiUrl, probeToken);
    const t0 = Date.now();
    try {
      await probe.getMe();
      reachable = true;
      ok(`reachable at ${config.telegramBotApiUrl} (${Date.now() - t0} ms)`);
    } catch (e) {
      bad(`not reachable at ${config.telegramBotApiUrl}: ${(e as Error).message}`);
    }
  }

  console.log('\nBots:');
  const clients: { id: string; client: BotApiClient }[] = [];
  for (const token of config.botTokens) {
    const client = new BotApiClient(config.telegramBotApiUrl, token);
    const masked = maskToken(token);
    try {
      const me = await client.getMe();
      clients.push({ id: String(me.id), client });
      ok(`${masked} -> @${me.username} (id ${me.id})`);
      const member = await client.getChatMember(config.channelId, me.id);
      check(
        member.status === 'administrator',
        `  is channel administrator`,
        `  NOT an administrator in the channel (status: ${member.status})`,
      );
      if (member.can_post_messages === false) bad('  lacks can_post_messages');
      if (member.can_delete_messages === false) info('  lacks can_delete_messages (deletions will fail)');
    } catch (e) {
      const msg = e instanceof TelegramError ? `${e.code} ${e.message}` : (e as Error).message;
      bad(`${masked} failed: ${msg}`);
    }
  }

  console.log('\nChannel:');
  if (clients.length > 0) {
    try {
      const chat = await clients[0]!.client.getChat(config.channelId);
      ok(`channel ${config.channelId}: "${chat.title ?? chat.id}"`);
    } catch (e) {
      bad(`cannot read channel ${config.channelId}: ${(e as Error).message}`);
    }

    console.log('\nWrite test:');
    const tmpFile = path.join(os.tmpdir(), `teledrive-doctor-${crypto.randomBytes(4).toString('hex')}.bin`);
    fs.writeFileSync(tmpFile, crypto.randomBytes(64));
    try {
      const msg = await clients[0]!.client.sendDocument({
        chatId: config.channelId,
        filePath: tmpFile,
        caption: '#teledrive doctor test (safe to delete)',
      });
      ok(`sent test document (message ${msg.message_id})`);
      const recheck = await clients[0]!.client.getFile(msg.document!.file_id);
      check(!!recheck.file_path && fs.existsSync(recheck.file_path), 'getFile returned a local path', 'getFile path missing');
      await clients[0]!.client.deleteMessage(config.channelId, msg.message_id);
      ok('deleted test document');
    } catch (e) {
      bad(`write test failed: ${(e as Error).message}`);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }

  console.log('\nFilesystem:');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
    const st = fs.statfsSync(config.dataDir);
    ok(`DATA_DIR ${config.dataDir} writable, ${Math.floor((st.bavail * st.bsize) / 1024 / 1024)} MiB free`);
  } catch (e) {
    bad(`DATA_DIR ${config.dataDir} not writable: ${(e as Error).message}`);
  }
  try {
    fs.accessSync(config.telegramBotApiDir, fs.constants.R_OK);
    ok(`TELEGRAM_BOT_API_DIR ${config.telegramBotApiDir} readable`);
  } catch {
    info(`TELEGRAM_BOT_API_DIR ${config.telegramBotApiDir} not readable (cache eviction will be limited)`);
  }

  console.log('\nMedia tools:');
  if (which(config.ffmpegPath || 'ffmpeg')) ok('ffmpeg found');
  else info('ffmpeg missing (optional: video thumbnails disabled)');
  if (which(config.ffprobePath || 'ffprobe')) ok('ffprobe found');
  else info('ffprobe missing (optional: falling back to built-in audio/video metadata parser)');
  if (which('pdftoppm', ['-v']) || which(path.join(REPO_ROOT, 'bin', 'pdftoppm'), ['-v'])) ok('pdftoppm found');
  else info('pdftoppm missing (pdf thumbnails disabled)');

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('doctor crashed:', e);
  process.exit(1);
});
