import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * SQLite connection setup.
 *
 * The native module is compiled per ABI. Vitest runs under Node, Electron runs under its
 * own ABI, so the caller passes `nativeBinding` when the default resolution would load the
 * wrong build (see `apps/desktop/resources/native/`).
 */

export interface SqliteOpenOptions {
  /** Absolute path to the database file, or `:memory:`. */
  readonly file: string;
  /** Prebuilt `better_sqlite3.node` matching the host ABI. */
  readonly nativeBinding?: string | undefined;
  readonly readonly?: boolean | undefined;
  /** Receives every executed statement. Used by the query log in development. */
  readonly verbose?: ((message?: unknown, ...rest: unknown[]) => void) | undefined;
}

/** Pragmas applied to every connection, in order. */
const CONNECTION_PRAGMAS: readonly string[] = [
  // Referential integrity is off by default in SQLite and is per-connection.
  'foreign_keys = ON',
  // Concurrent readers during a write; irrelevant but harmless for :memory:.
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'busy_timeout = 5000',
  'temp_store = MEMORY',
  // Recursive triggers keep the FTS shadow tables consistent under cascading deletes.
  'recursive_triggers = ON',
];

export function openSqlite(options: SqliteOpenOptions): SqliteDatabase {
  const ctorOptions: Database.Options = {};
  if (options.nativeBinding !== undefined) ctorOptions.nativeBinding = options.nativeBinding;
  if (options.readonly !== undefined) ctorOptions.readonly = options.readonly;
  if (options.verbose !== undefined) ctorOptions.verbose = options.verbose;

  const db = new Database(options.file, ctorOptions);
  const isMemory = options.file === ':memory:' || options.file === '';
  for (const pragma of CONNECTION_PRAGMAS) {
    // WAL is meaningless for an in-memory database and SQLite reports an error for it.
    if (isMemory && pragma.startsWith('journal_mode')) continue;
    db.pragma(pragma);
  }
  return db;
}

/** True when the connection actually enforces foreign keys. */
export function foreignKeysEnabled(db: SqliteDatabase): boolean {
  const rows = db.pragma('foreign_keys') as ReadonlyArray<{ foreign_keys: number }>;
  return rows[0]?.foreign_keys === 1;
}

/** True when this SQLite build has the FTS5 extension compiled in. */
export function fts5Available(db: SqliteDatabase): boolean {
  const rows = db.pragma('compile_options') as ReadonlyArray<{ compile_options: string }>;
  return rows.some((row) => row.compile_options === 'ENABLE_FTS5');
}
