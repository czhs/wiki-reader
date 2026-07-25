/**
 * Structured logging for the main process.
 *
 * Ingestion, extraction, and indexing are the three places where a silent failure is
 * indistinguishable from an empty library, so every one of them logs a structured record
 * rather than swallowing the error. One JSON object per line: greppable, and parseable by
 * the Ralph loop's log tooling without a format-specific reader.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that prefixes every event with `scope` and merges `fields` into each record. */
  child(scope: string, fields?: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** Sink for finished records. Defaults to stdout via console. */
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * Errors are never logged as bare objects: `JSON.stringify(new Error('x'))` is `{}`, which
 * turns a real failure into an empty record. They are flattened to name + message here.
 */
function flatten(fields: LogFields): LogFields {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? `${value.name}: ${value.message}` : value;
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? 'info'];
  const now = options.now ?? ((): Date => new Date());
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });

  const make = (scope: string, bound: LogFields): Logger => {
    const write = (level: LogLevel, event: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < threshold) return;
      const record = {
        ts: now().toISOString(),
        level,
        scope,
        event,
        ...flatten(bound),
        ...flatten(fields ?? {}),
      };
      sink(JSON.stringify(record));
    };

    return {
      debug: (event, fields) => write('debug', event, fields),
      info: (event, fields) => write('info', event, fields),
      warn: (event, fields) => write('warn', event, fields),
      error: (event, fields) => write('error', event, fields),
      child: (childScope, fields) =>
        make(scope === '' ? childScope : `${scope}.${childScope}`, { ...bound, ...(fields ?? {}) }),
    };
  };

  return make('', {});
}

/** Discards everything. For tests that assert on behaviour rather than on log output. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): Logger => silentLogger,
};
