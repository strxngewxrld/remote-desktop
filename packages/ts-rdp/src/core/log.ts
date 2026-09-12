export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export interface Logger {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  trace(msg: string, ...args: unknown[]): void;
}

export type LogSink = (level: LogLevel, message: string, ...args: unknown[]) => void;

export function createLogger(level: LogLevel = 'info', sink?: LogSink): Logger {
  const emit = (l: LogLevel, msg: string, ...args: unknown[]) => {
    if (ORDER[l] > ORDER[level]) return;
    if (sink) sink(l, msg, ...args);
    else console.error(`[ts-rdp:${l}] ${msg}`, ...args);
  };
  return {
    error: (m, ...a) => emit('error', m, ...a),
    warn: (m, ...a) => emit('warn', m, ...a),
    info: (m, ...a) => emit('info', m, ...a),
    debug: (m, ...a) => emit('debug', m, ...a),
    trace: (m, ...a) => emit('trace', m, ...a),
  };
}

export const nullLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};
