import { EventEmitter } from 'node:events';
import { BotApiClient, TelegramError, type TgUser } from './botApi.js';
import { toLocal, toRemote, type PathMap } from './pathMap.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { PartRow } from '../types.js';
import { bumpBotStats, upsertBot } from '../db/repos/misc.js';
import { maskToken } from '../config.js';

export interface BotEntry {
  id: string; // numeric bot id (token prefix), never an index
  token: string;
  username: string | null;
  firstName: string | null;
  healthy: boolean;
  canDelete: boolean;
  lastError: string | null;
  inFlight: number;
  lastUsed: number;
  /** flood-wait: not selectable for uploads until this time (ms) */
  cooldownUntil: number;
  client: BotApiClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BotPool {
  readonly bots = new Map<string, BotEntry>();
  private emitter = new EventEmitter();
  private channelTitle: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly pathMap: PathMap | null,
  ) {
    this.emitter.setMaxListeners(1000);
  }

  /** Probe every token; mark healthy bots that are admins in the channel. */
  async init(): Promise<void> {
    await Promise.all(this.config.botTokens.map((t) => this.probe(t)));
    const configuredIds = this.config.botTokens.map((t) => t.split(':')[0] ?? t);
    if (configuredIds.length > 0) {
      const placeholders = configuredIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM bots WHERE bot_id NOT IN (${placeholders})`).run(...configuredIds);
    }
    const healthy = this.healthyCount();
    if (healthy === 0) {
      this.logger.error('no healthy bots — uploads will return 503 until a bot becomes healthy');
    } else {
      this.logger.info({ healthy, total: this.bots.size }, 'bot pool ready');
    }
  }

  private async probe(token: string): Promise<void> {
    const id = token.split(':')[0] ?? token;
    const existing = this.bots.get(id);
    const client = existing?.client ?? new BotApiClient(this.config.telegramBotApiUrl, token);
    const entry: BotEntry = existing ?? {
      id,
      token,
      username: null,
      firstName: null,
      healthy: false,
      canDelete: false,
      lastError: null,
      inFlight: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      client,
    };
    try {
      const me: TgUser = await client.getMe();
      entry.username = me.username ?? null;
      entry.firstName = me.first_name ?? null;
      const member = await client.getChatMember(this.config.channelId, me.id);
      if (member.status !== 'administrator') {
        throw new Error(`bot is ${member.status} in the channel, needs administrator`);
      }
      if (member.can_post_messages === false) {
        throw new Error('bot administrator lacks can_post_messages');
      }
      entry.canDelete = member.can_delete_messages !== false;
      if (!entry.canDelete) {
        this.logger.warn({ bot: maskToken(token) }, 'bot lacks can_delete_messages — deletions may fail');
      }
      entry.healthy = true;
      entry.lastError = null;
      upsertBot(this.db, {
        botId: id,
        username: entry.username ?? undefined,
        firstName: entry.firstName ?? undefined,
        healthy: true,
      });
    } catch (e) {
      entry.healthy = false;
      entry.lastError = e instanceof TelegramError ? `${e.code} ${e.message}` : (e as Error).message;
      upsertBot(this.db, {
        botId: id,
        username: entry.username ?? undefined,
        firstName: entry.firstName ?? undefined,
        healthy: false,
        lastError: entry.lastError,
      });
      this.logger.warn({ bot: maskToken(token), err: entry.lastError }, 'bot unhealthy');
    }
    this.bots.set(id, entry);
  }

  async recheckHealth(): Promise<void> {
    await Promise.all([...this.bots.values()].map((b) => this.probe(b.token)));
  }

  healthyCount(): number {
    return [...this.bots.values()].filter((b) => b.healthy).length;
  }

  healthyBots(): BotEntry[] {
    return [...this.bots.values()].filter((b) => b.healthy);
  }

  /** Healthy bot able to delete channel messages (prefers canDelete). */
  deletionBot(): BotEntry | undefined {
    const healthy = this.healthyBots();
    return healthy.find((b) => b.canDelete) ?? healthy[0];
  }

  clientFor(botId: string): BotApiClient | undefined {
    return this.bots.get(botId)?.client;
  }

  entry(botId: string): BotEntry | undefined {
    return this.bots.get(botId);
  }

  /** Total parallel upload slots across healthy bots. */
  uploadCapacity(): number {
    return Math.max(1, this.healthyCount() * this.config.botMaxConcurrentUploads);
  }

  /** Effective server-side Telegram upload concurrency (TELEGRAM_UPLOAD_CONCURRENCY=0 → auto). */
  effectiveUploadConcurrency(): number {
    return this.config.telegramUploadConcurrency > 0 ? this.config.telegramUploadConcurrency : this.uploadCapacity();
  }

  /**
   * Acquire the healthy, non-cooling bot with fewest in-flight uploads (tie:
   * least recently used), respecting BOT_MAX_CONCURRENT_UPLOADS. Waits until
   * one frees up or a flood-wait expires. `avoid` skips a bot when others are
   * available (used to move a rate-limited part to a different bot).
   */
  async acquire(avoid?: string, isCancelled?: () => boolean): Promise<BotEntry> {
    for (;;) {
      if (isCancelled?.()) throw new Error('upload cancelled');
      const healthy = this.healthyBots();
      if (healthy.length === 0) throw new Error('no healthy bots');
      const now = Date.now();
      const free = healthy
        .filter((b) => b.inFlight < this.config.botMaxConcurrentUploads && b.cooldownUntil <= now)
        .sort((a, b) => a.inFlight - b.inFlight || a.lastUsed - b.lastUsed);
      const candidate = free.find((b) => b.id !== avoid) ?? free[0];
      if (candidate) {
        candidate.inFlight++;
        candidate.lastUsed = now;
        return candidate;
      }
      const nextCool = Math.min(...healthy.map((b) => (b.cooldownUntil > now ? b.cooldownUntil : Infinity)));
      const wait = Number.isFinite(nextCool) ? Math.min(Math.max(nextCool - now, 50), 1000) : 1000;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(t);
          this.emitter.off('released', finish);
          resolve();
        };
        const t = setTimeout(finish, wait);
        this.emitter.once('released', finish);
      });
    }
  }

  /** Telegram flood-wait for one bot: keep it out of rotation, others carry on. */
  cooldown(botId: string, retryAfterSec: number): void {
    const b = this.bots.get(botId);
    if (!b) return;
    b.cooldownUntil = Math.max(b.cooldownUntil, Date.now() + (retryAfterSec + 1) * 1000);
    this.logger.warn({ bot: maskToken(b.token), retryAfterSec }, 'bot rate-limited; routing uploads to other bots');
  }

  release(bot: BotEntry): void {
    bot.inFlight = Math.max(0, bot.inFlight - 1);
    this.emitter.emit('released');
  }

  markUnhealthy(botId: string, error: string): void {
    const b = this.bots.get(botId);
    if (!b) return;
    b.healthy = false;
    b.lastError = error;
    upsertBot(this.db, { botId, username: b.username ?? undefined, healthy: false, lastError: error });
  }

  async getChannelTitle(): Promise<string | null> {
    if (this.channelTitle) return this.channelTitle;
    const bot = this.healthyBots()[0];
    if (!bot) return null;
    try {
      const chat = await bot.client.getChat(this.config.channelId);
      this.channelTitle = chat.title ?? null;
      return this.channelTitle;
    } catch {
      return null;
    }
  }

  /** Map a local path for a file:// upload. */
  remotePath(localPath: string): string {
    return toRemote(this.pathMap, localPath);
  }

  /** Map a bot-api file_path to a local path. */
  localPath(remotePath: string): string {
    return toLocal(this.pathMap, remotePath);
  }

  /**
   * Owner fallback: when parts.bot_id is gone/unhealthy, another bot forwards
   * the original channel message to itself to obtain a usable file_id, then
   * deletes the forwarded copy. message_id stays unchanged.
   */
  async reassignPart(part: PartRow): Promise<PartRow> {
    if (!part.message_id) throw new Error('part has no message_id');
    // spread reassignments: least recently used healthy bot
    const bot = this.healthyBots().sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!bot) throw new Error('no healthy bots for reassignment');
    bot.lastUsed = Date.now();
    const fwd = await bot.client.forwardMessage({
      chatId: this.config.channelId,
      fromChatId: this.config.channelId,
      messageId: part.message_id,
    });
    const doc = fwd.document;
    if (!doc) throw new Error('forwarded message has no document');
    this.db
      .prepare('UPDATE parts SET bot_id = ?, tg_file_id = ?, tg_file_unique_id = ? WHERE blob_id = ? AND idx = ?')
      .run(bot.id, doc.file_id, doc.file_unique_id, part.blob_id, part.idx);
    try {
      await bot.client.deleteMessage(this.config.channelId, fwd.message_id);
    } catch (e) {
      this.logger.warn({ err: (e as Error).message, messageId: fwd.message_id }, 'failed to delete forwarded copy');
    }
    this.logger.info({ blobId: part.blob_id, idx: part.idx, bot: maskToken(bot.token) }, 'part reassigned to healthy bot');
    return { ...part, bot_id: bot.id, tg_file_id: doc.file_id, tg_file_unique_id: doc.file_unique_id };
  }

  /** Resolve a usable client + file_id for a part, reassigning if the owner bot is unavailable. */
  async clientForPart(part: PartRow): Promise<{ bot: BotEntry; part: PartRow }> {
    if (part.bot_id) {
      const b = this.bots.get(part.bot_id);
      if (b?.healthy) return { bot: b, part };
    }
    const reassigned = await this.reassignPart(part);
    const bot = this.bots.get(reassigned.bot_id!)!;
    return { bot, part: reassigned };
  }

  recordUpload(botId: string, bytes: number): void {
    bumpBotStats(this.db, botId, bytes);
  }

  // ---- throughput tracking (used to estimate progress of in-flight transfers) ----
  private rates = new Map<string, number>(); // `${kind}:${botId}` -> bytes/s (EWMA)

  /**
   * Record a completed Telegram transfer. The local Bot API gives no progress
   * callbacks, so measured throughput is the only basis for live estimates.
   * Tiny transfers are dominated by latency and are ignored.
   */
  recordTransfer(botId: string, kind: 'up' | 'down', bytes: number, ms: number): void {
    if (bytes < 1024 * 1024 || ms < 500) return;
    const rate = bytes / (ms / 1000);
    const key = `${kind}:${botId}`;
    const prev = this.rates.get(key);
    this.rates.set(key, prev ? prev * 0.6 + rate * 0.4 : rate);
  }

  /** Estimated bytes/s for a bot (falls back to the mean of all bots), or null if unknown. */
  estimatedRate(botId: string | null, kind: 'up' | 'down'): number | null {
    if (botId) {
      const r = this.rates.get(`${kind}:${botId}`);
      if (r) return r;
    }
    const all = [...this.rates.entries()].filter(([k]) => k.startsWith(`${kind}:`)).map(([, v]) => v);
    return all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;
  }
}

export { sleep };
