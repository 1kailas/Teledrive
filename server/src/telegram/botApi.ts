import { Agent, request } from 'undici';
import { maskToken } from '../config.js';

export class TelegramError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgChat {
  id: number;
  title?: string;
  type: string;
}

export interface TgChatMember {
  status: string;
  can_post_messages?: boolean;
  can_delete_messages?: boolean;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumb?: { file_id: string; file_unique_id: string; width?: number; height?: number };
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  document?: TgDocument;
  caption?: string;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_429_RETRIES = 8;
const MAX_5XX_RETRIES = 5;

/**
 * Client for a self-hosted telegram-bot-api server running in --local mode.
 * Uploads use file:// paths (no multipart) and may take many minutes for
 * 2 GB documents, hence the disabled header/body timeouts.
 */
export class BotApiClient {
  private readonly agent: Agent;
  readonly botId: string;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    this.botId = token.split(':')[0] ?? '';
  }

  get masked(): string {
    return maskToken(this.token);
  }

  async close(): Promise<void> {
    await this.agent.close().catch(() => {});
  }

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  /**
   * @param opts.retry429 when false, a 429 is thrown immediately (with retryAfter)
   *   so the caller can move the work to another bot instead of sleeping.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: { retry429?: boolean } = {}): Promise<T> {
    let attempt429 = 0;
    let attempt5xx = 0;
    for (;;) {
      let status = 0;
      let text = '';
      try {
        const res = await request(this.url(method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          dispatcher: this.agent,
          headersTimeout: 0,
          bodyTimeout: 0,
        });
        status = res.statusCode;
        text = await res.body.text();
      } catch (e) {
        if (attempt5xx++ < MAX_5XX_RETRIES) {
          await sleep(Math.min(1000 * 2 ** (attempt5xx - 1), 8000));
          continue;
        }
        throw new TelegramError(0, `network error calling ${method}: ${(e as Error).message}`);
      }

      let payload: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        // A proxy may return an HTML error page (commonly 413/502). Keep the
        // status and a short body so callers can classify it correctly.
        const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
        if (status >= 500 && attempt5xx++ < MAX_5XX_RETRIES) {
          await sleep(Math.min(1000 * 2 ** (attempt5xx - 1), 8000));
          continue;
        }
        throw new TelegramError(status, `HTTP ${status}: ${snippet || 'empty response'}`);
      }

      if (status === 200 && payload.ok) return payload.result as T;

      const code = payload.error_code ?? status;
      const description = payload.description ?? `HTTP ${status}`;
      if (code === 429) {
        if (opts.retry429 === false || attempt429++ >= MAX_429_RETRIES) {
          throw new TelegramError(code, description, payload.parameters?.retry_after);
        }
        const wait = (payload.parameters?.retry_after ?? 1) * 1000 + 500;
        await sleep(wait);
        continue;
      }
      if (status >= 500 || code >= 500) {
        if (attempt5xx++ < MAX_5XX_RETRIES) {
          await sleep(Math.min(1000 * 2 ** (attempt5xx - 1), 8000));
          continue;
        }
      }
      throw new TelegramError(code, description, payload.parameters?.retry_after);
    }
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe');
  }

  getChat(chatId: string | number): Promise<TgChat> {
    return this.call<TgChat>('getChat', { chat_id: chatId });
  }

  getChatMember(chatId: string | number, userId: number): Promise<TgChatMember> {
    return this.call<TgChatMember>('getChatMember', { chat_id: chatId, user_id: userId });
  }

  sendDocument(p: { chatId: string | number; filePath: string; caption?: string; retry429?: boolean }): Promise<TgMessage> {
    return this.call<TgMessage>('sendDocument', {
      chat_id: p.chatId,
      document: `file://${p.filePath}`,
      caption: p.caption,
      disable_notification: true,
      disable_content_type_detection: true,
    }, { retry429: p.retry429 });
  }

  getFile(fileId: string): Promise<TgFile> {
    return this.call<TgFile>('getFile', { file_id: fileId });
  }

  forwardMessage(p: { chatId: string | number; fromChatId: string | number; messageId: number }): Promise<TgMessage> {
    return this.call<TgMessage>('forwardMessage', {
      chat_id: p.chatId,
      from_chat_id: p.fromChatId,
      message_id: p.messageId,
      disable_notification: true,
    });
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    try {
      await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (e) {
      if (e instanceof TelegramError && /message to delete not found/i.test(e.message)) return;
      throw e;
    }
  }

  /** deleteMessages batch (<=100 ids) with per-message fallback when unsupported. */
  async deleteMessages(chatId: string | number, messageIds: number[]): Promise<{ failed: { id: number; error: string }[] }> {
    const failed: { id: number; error: string }[] = [];
    for (let i = 0; i < messageIds.length; i += 100) {
      const batch = messageIds.slice(i, i + 100);
      try {
        await this.call('deleteMessages', { chat_id: chatId, message_ids: batch });
      } catch (e) {
        const desc = e instanceof TelegramError ? e.message : String(e);
        if (e instanceof TelegramError && (e.code === 404 || /method (not found|is not available)/i.test(desc))) {
          for (const id of batch) {
            try {
              await this.deleteMessage(chatId, id);
            } catch (e2) {
              failed.push({ id, error: (e2 as Error).message });
            }
          }
        } else if (e instanceof TelegramError && /message to delete not found/i.test(desc)) {
          // whole batch reported missing -> treat as success
        } else {
          // Retry individually so one bad id doesn't block the batch.
          for (const id of batch) {
            try {
              await this.deleteMessage(chatId, id);
            } catch (e2) {
              failed.push({ id, error: (e2 as Error).message });
            }
          }
        }
      }
    }
    return { failed };
  }

  pinChatMessage(chatId: string | number, messageId: number): Promise<unknown> {
    return this.call('pinChatMessage', {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  }

  /** Cloud API only — used by the bots:logout CLI against https://api.telegram.org. */
  logOut(): Promise<unknown> {
    return this.call('logOut');
  }
}
