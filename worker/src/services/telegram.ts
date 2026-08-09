/**
 * TeleDrive Worker — Telegram Bot API Service
 *
 * Handles all interactions with the Telegram Bot API:
 * - Sending files to Saved Messages
 * - Downloading files from Telegram
 * - Deleting messages
 * - Error handling with retries
 */

import type {
  TelegramResponse,
  TelegramMessage,
  TelegramFile,
} from '../types/index.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Maximum retries for transient Telegram API errors */
const MAX_RETRIES = 3;

/** Delay between retries (ms) — doubles each retry */
const BASE_RETRY_DELAY = 1000;

export class TelegramService {
  private botToken: string;
  private chatId: string;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  /**
   * Get the primary bot's numeric ID from a single or comma-separated list of tokens.
   */
  static getPrimaryBotId(botTokenConfig: string): string {
    const primaryToken = botTokenConfig.split(',')[0].trim();
    return primaryToken.split(':')[0];
  }

  /**
   * Helper to get a TelegramService instance for a specific bot token index.
   */
  static fromPool(botTokenConfig: string, chatId: string, index: number): { service: TelegramService; botIndex: number } {
    const tokens = botTokenConfig.split(',').map((t) => t.trim());
    const botIndex = index % tokens.length;
    const token = tokens[botIndex] || tokens[0];
    return { service: new TelegramService(token, chatId), botIndex };
  }

  /**
   * Helper to parse a prefixed DB value (e.g. "1:messageId") and return the corresponding service + actual value.
   * If no prefix is present, it defaults to the first bot (index 0).
   */
  static fromPrefixedValue(
    botTokenConfig: string,
    chatId: string,
    prefixedValue: string | null
  ): { service: TelegramService; value: string } {
    const tokens = botTokenConfig.split(',').map((t) => t.trim());
    if (!prefixedValue) {
      return { service: new TelegramService(tokens[0], chatId), value: '' };
    }

    const parts = prefixedValue.split(':');
    if (parts.length > 1) {
      const botIndex = parseInt(parts[0], 10);
      if (!isNaN(botIndex)) {
        const value = parts.slice(1).join(':');
        const token = tokens[botIndex % tokens.length] || tokens[0];
        return { service: new TelegramService(token, chatId), value };
      }
    }

    return { service: new TelegramService(tokens[0], chatId), value: prefixedValue };
  }

  /** Base URL for Bot API calls */
  private get apiUrl(): string {
    return `${TELEGRAM_API_BASE}/bot${this.botToken}`;
  }

  /** Base URL for file downloads */
  private get fileUrl(): string {
    return `${TELEGRAM_API_BASE}/file/bot${this.botToken}`;
  }

  /**
   * Send a file to Saved Messages via sendDocument.
   * The file is sent as a multipart/form-data upload.
   *
   * @param fileData - The file content as ArrayBuffer or Blob
   * @param fileName - Original file name
   * @param caption - Optional caption for the message
   * @returns The Telegram message containing the uploaded document
   */
  async sendDocument(
    fileData: ArrayBuffer | Blob,
    fileName: string,
    caption?: string
  ): Promise<TelegramMessage> {
    const formData = new FormData();
    formData.append('chat_id', this.chatId);

    const blob =
      fileData instanceof Blob ? fileData : new Blob([fileData]);
    formData.append('document', blob, fileName);

    if (caption) {
      formData.append('caption', caption);
    }

    // Disable notifications for chunk uploads
    formData.append('disable_notification', 'true');

    return this.callWithRetry<TelegramMessage>(async () => {
      const response = await fetch(`${this.apiUrl}/sendDocument`, {
        method: 'POST',
        body: formData,
      });

      const result: TelegramResponse<TelegramMessage> =
        await response.json();

      if (!result.ok || !result.result) {
        throw new TelegramApiError(
          result.description || 'Failed to send document',
          result.error_code || response.status,
          result.parameters?.retry_after
        );
      }

      return result.result;
    });
  }

  /**
   * Get file info (including download path) from Telegram.
   *
   * @param fileId - The Telegram file_id
   * @returns File info with the temporary file_path
   */
  async getFile(fileId: string): Promise<TelegramFile> {
    return this.callWithRetry<TelegramFile>(async () => {
      const response = await fetch(
        `${this.apiUrl}/getFile?file_id=${encodeURIComponent(fileId)}`
      );

      const result: TelegramResponse<TelegramFile> = await response.json();

      if (!result.ok || !result.result) {
        throw new TelegramApiError(
          result.description || 'Failed to get file',
          result.error_code || response.status,
          result.parameters?.retry_after
        );
      }

      return result.result;
    });
  }

  /**
   * Download a file from Telegram using its file_path.
   *
   * @param filePath - The file_path from getFile response
   * @returns The file content as a Response (streamable)
   */
  async downloadFile(filePath: string): Promise<Response> {
    const url = `${this.fileUrl}/${filePath}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new TelegramApiError(
        `Failed to download file: ${response.statusText}`,
        response.status
      );
    }

    return response;
  }

  /**
   * Send a photo to Saved Messages (used for thumbnails).
   * Telegram auto-compresses the image, making it perfect for previews.
   *
   * @param photoData - The image content as ArrayBuffer or Blob
   * @param fileName - File name for the photo
   * @param caption - Optional caption
   * @returns The Telegram message containing the photo
   */
  async sendPhoto(
    photoData: ArrayBuffer | Blob,
    fileName: string,
    caption?: string
  ): Promise<TelegramMessage> {
    const formData = new FormData();
    formData.append('chat_id', this.chatId);

    const blob =
      photoData instanceof Blob ? photoData : new Blob([photoData]);
    formData.append('photo', blob, fileName);

    if (caption) {
      formData.append('caption', caption);
    }

    formData.append('disable_notification', 'true');

    return this.callWithRetry<TelegramMessage>(async () => {
      const response = await fetch(`${this.apiUrl}/sendPhoto`, {
        method: 'POST',
        body: formData,
      });

      const result: TelegramResponse<TelegramMessage> =
        await response.json();

      if (!result.ok || !result.result) {
        throw new TelegramApiError(
          result.description || 'Failed to send photo',
          result.error_code || response.status,
          result.parameters?.retry_after
        );
      }

      return result.result;
    });
  }

  /**
   * Get the URL for a photo thumbnail from Telegram.
   * Returns the smallest photo size for fast loading.
   *
   * @param photoMessage - The Telegram message containing the photo
   * @returns Download URL for the thumbnail
   */
  async getPhotoUrl(fileId: string): Promise<string> {
    const fileInfo = await this.getFile(fileId);
    if (!fileInfo.file_path) {
      throw new TelegramApiError('File path unavailable', 404);
    }
    return `${this.fileUrl}/${fileInfo.file_path}`;
  }

  /**
   * Delete a message from Saved Messages.
   *
   * @param messageId - The Telegram message_id to delete
   * @returns true if deleted successfully
   */
  async deleteMessage(messageId: number): Promise<boolean> {
    return this.callWithRetry<boolean>(async () => {
      const response = await fetch(`${this.apiUrl}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          message_id: messageId,
        }),
      });

      const result: TelegramResponse<boolean> = await response.json();

      if (!result.ok) {
        // Message already deleted — not an error
        if (result.error_code === 400) {
          return true;
        }
        throw new TelegramApiError(
          result.description || 'Failed to delete message',
          result.error_code || response.status,
          result.parameters?.retry_after
        );
      }

      return true;
    });
  }

  /**
   * Verify the bot token is valid.
   */
  async verifyToken(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/getMe`);
      const result: TelegramResponse = await response.json();
      return result.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Retry wrapper for transient errors (rate limits, network issues).
   * Uses exponential backoff.
   */
  private async callWithRetry<T>(
    fn: () => Promise<T>,
    retries = MAX_RETRIES
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry client errors (4xx except 429)
        if (
          error instanceof TelegramApiError &&
          error.statusCode >= 400 &&
          error.statusCode < 500 &&
          error.statusCode !== 429
        ) {
          throw error;
        }

        // Last attempt — throw
        if (attempt === retries) {
          throw error;
        }

        // If 429 Rate Limit, sleep for the requested retry_after duration plus a 500ms safety buffer
        if (error instanceof TelegramApiError && error.statusCode === 429 && error.retryAfter) {
          const delay = error.retryAfter * 1000 + 500;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Exponential backoff
        const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error('Retry failed');
  }
}

/**
 * Custom error class for Telegram API errors.
 */
export class TelegramApiError extends Error {
  public statusCode: number;
  public retryAfter?: number;

  constructor(message: string, statusCode: number, retryAfter?: number) {
    super(message);
    this.name = 'TelegramApiError';
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}
