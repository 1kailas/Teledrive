import { pino, type Logger } from 'pino';

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });
}

export type { Logger };
