import { TelegramService } from '../services/telegram.js';

/**
 * Find files stuck in 'uploading' state for over 24 hours, delete their
 * uploaded chunks from Telegram, and delete their DB records.
 */
export async function cleanupAbandonedUploads(
  db: D1Database,
  botToken: string,
  chatId: string
): Promise<{ deletedFiles: number; deletedChunks: number }> {
  // 1. Find all files with upload_status = 'uploading' that are older than 24 hours
  const { results: abandonedFiles } = await db.prepare(
    `SELECT id, name FROM files 
     WHERE upload_status = 'uploading' 
       AND created_at < datetime('now', '-24 hours')`
  )
    .all<{ id: string; name: string }>();

  if (abandonedFiles.length === 0) {
    return { deletedFiles: 0, deletedChunks: 0 };
  }

  let deletedChunksCount = 0;

  for (const file of abandonedFiles) {
    // 2. Find all chunks for this file that have been successfully uploaded to Telegram
    const { results: chunks } = await db.prepare(
      `SELECT telegram_message_id FROM chunks 
       WHERE file_id = ? AND telegram_message_id IS NOT NULL`
    )
      .bind(file.id)
      .all<{ telegram_message_id: string }>();

    // 3. Delete messages from Telegram (best-effort)
    for (const chunk of chunks) {
      try {
        const { service: telegram, value: msgId } = TelegramService.fromPrefixedValue(
          botToken,
          chatId,
          chunk.telegram_message_id
        );
        await telegram.deleteMessage(Number(msgId));
        deletedChunksCount++;
      } catch (err) {
        console.error(`Failed to delete message for chunk of abandoned file ${file.name}:`, err);
      }
    }

    // 4. Delete DB rows for this file (chunks are deleted cascade)
    await db.batch([
      db.prepare('DELETE FROM chunks WHERE file_id = ?').bind(file.id),
      db.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(file.id),
      db.prepare('DELETE FROM files WHERE id = ?').bind(file.id),
    ]);
  }

  console.log(`Cleaned up ${abandonedFiles.length} abandoned uploads and ${deletedChunksCount} chunks.`);
  return { deletedFiles: abandonedFiles.length, deletedChunks: deletedChunksCount };
}
