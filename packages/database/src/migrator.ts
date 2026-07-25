import type { Database as SqliteDatabase } from 'better-sqlite3';
import { textHash } from '@wr/document-model';
import { MIGRATIONS, type Migration } from './migrations/index.js';

/**
 * Forward-only migration runner.
 *
 * Applying migrations is idempotent: every migration already recorded in
 * `schema_migrations` is skipped. Each migration runs inside a transaction, so a failing
 * statement leaves the database at the previous version rather than half-migrated.
 */

export interface AppliedMigration {
  readonly id: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  /** Migrations applied by this call. Empty when the database was already current. */
  readonly applied: readonly number[];
  /** Schema version after the run. */
  readonly version: number;
}

export class MigrationChecksumError extends Error {
  constructor(migration: Migration, expected: string, actual: string) {
    super(
      `migration ${migration.id} (${migration.name}) was modified after it was applied: ` +
        `recorded checksum ${expected}, current ${actual}. Add a new migration instead of ` +
        `editing a released one.`,
    );
    this.name = 'MigrationChecksumError';
  }
}

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

interface SchemaMigrationRow {
  id: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export function listAppliedMigrations(db: SqliteDatabase): AppliedMigration[] {
  db.exec(SCHEMA_MIGRATIONS_DDL);
  const rows = db
    .prepare('SELECT id, name, checksum, applied_at FROM schema_migrations ORDER BY id')
    .all() as SchemaMigrationRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export function schemaVersion(db: SqliteDatabase): number {
  const rows = db.pragma('user_version') as ReadonlyArray<{ user_version: number }>;
  return rows[0]?.user_version ?? 0;
}

/**
 * Apply every migration the database has not seen yet.
 *
 * @param now injected so tests observe deterministic timestamps.
 */
export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): MigrationResult {
  const alreadyApplied = new Map(listAppliedMigrations(db).map((m) => [m.id, m]));
  const applied: number[] = [];

  const ordered = [...migrations].sort((a, b) => a.id - b.id);
  for (const migration of ordered) {
    const checksum = textHash(migration.sql);
    const previous = alreadyApplied.get(migration.id);
    if (previous !== undefined) {
      if (previous.checksum !== checksum) {
        throw new MigrationChecksumError(migration, previous.checksum, checksum);
      }
      continue;
    }

    // better-sqlite3 refuses to run a multi-statement `exec` inside a prepared
    // transaction wrapper, so the transaction is driven explicitly here.
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.id, migration.name, checksum, now());
      db.pragma(`user_version = ${migration.id}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    applied.push(migration.id);
  }

  return { applied, version: schemaVersion(db) };
}
