import { MIGRATION_001_INITIAL } from './001_initial.js';
import { MIGRATION_002_MARKDOWN } from './002_markdown.js';
import { MIGRATION_003_SETTINGS } from './003_settings.js';
import { MIGRATION_004_QUESTIONS } from './004_questions.js';

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
  { id: 2, name: '002_markdown', sql: MIGRATION_002_MARKDOWN },
  { id: 3, name: '003_settings', sql: MIGRATION_003_SETTINGS },
  { id: 4, name: '004_questions', sql: MIGRATION_004_QUESTIONS },
];

/** The schema version a freshly migrated database reports. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => (migration.id > max ? migration.id : max),
  0,
);
