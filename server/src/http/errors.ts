export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'forbidden') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'CONFLICT', msg, details);
export const gone = (msg: string) => new AppError(410, 'GONE', msg);
export const tooLarge = (msg: string) => new AppError(413, 'PAYLOAD_TOO_LARGE', msg);
export const serviceUnavailable = (msg: string) => new AppError(503, 'SERVICE_UNAVAILABLE', msg);
export const insufficientStorage = (msg: string) => new AppError(507, 'INSUFFICIENT_STORAGE', msg);
