/**
 * TeleDrive Worker — Database Utility Helpers
 */

/**
 * Safely execute D1 database batches in chunks of 100 statements
 * to avoid Cloudflare D1 batch size limits (max 100 statements per batch query).
 *
 * @param db - The Cloudflare D1Database binding instance
 * @param statements - Array of D1PreparedStatements to execute
 */
export async function safeBatch<T = unknown>(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<D1Result<T>[]> {
  if (statements.length === 0) {
    return [];
  }

  const BATCH_SIZE = 100;
  const results: D1Result<T>[] = [];

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    const chunkResults = await db.batch<T>(chunk);
    results.push(...chunkResults);
  }

  return results;
}
