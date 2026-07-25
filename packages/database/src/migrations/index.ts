import { MIGRATION_001_INITIAL } from './001_initial.js';

/**
 * A forward-only schema migration.
 *
 * Migrations are never edited once released: correcting the schema means adding a new
 * entry. The migrator records the checksum of every applied statement so an edited
 * migration is detected instead of silently diverging between machines.
 */
export interface Migration {
  /** Monotonically increasing, matches `PRAGMA user_version` after it is applied. */
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: '001_initial', sql: MIGRATION_001_INITIAL },
];

/** The schema version a freshly migrated database reports. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => (migration.id > max ? migration.id : max),
  0,
);
