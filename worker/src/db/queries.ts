/**
 * TeleDrive Worker — Database Query Helpers
 *
 * Typed helper functions for common database operations.
 * All functions take a D1Database instance and return typed results.
 */

/**
 * Generate a unique ID using crypto.randomUUID().
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Get current ISO timestamp for SQLite.
 */
export function now(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Extract file extension from filename.
 */
export function getExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) return null;
  return filename.substring(lastDot + 1).toLowerCase();
}

/**
 * Build a paginated SQL query with optional WHERE conditions.
 *
 * @param baseQuery - SELECT query without LIMIT/OFFSET
 * @param conditions - WHERE clause parts (joined with AND)
 * @param params - Bind parameters
 * @param page - Page number (1-indexed)
 * @param pageSize - Items per page
 * @param orderBy - ORDER BY clause
 */
export function buildPaginatedQuery(
  baseQuery: string,
  conditions: string[],
  params: unknown[],
  page: number = 1,
  pageSize: number = 50,
  orderBy: string = 'created_at DESC'
): { query: string; countQuery: string; params: unknown[]; offset: number } {
  let query = baseQuery;
  const countQuery = baseQuery.replace(
    /SELECT .+ FROM/,
    'SELECT COUNT(*) as total FROM'
  );

  if (conditions.length > 0) {
    const whereClause = ' WHERE ' + conditions.join(' AND ');
    query += whereClause;
  }

  query += ` ORDER BY ${orderBy}`;
  const offset = (page - 1) * pageSize;
  query += ` LIMIT ${pageSize} OFFSET ${offset}`;

  let finalCountQuery = countQuery;
  if (conditions.length > 0) {
    finalCountQuery += ' WHERE ' + conditions.join(' AND ');
  }

  return { query, countQuery: finalCountQuery, params, offset };
}
