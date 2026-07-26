/**
 * Migration 003 — application settings.
 *
 * A key/value table for the handful of choices a person makes *in the app* and expects to
 * find again after a restart: which Zotero collections an import covers, where the notes
 * folder is. They live in SQLite rather than in a JSON file beside it because there is
 * already exactly one thing to back up, and because a setting read during a migration or a
 * purge should be in the same transaction as the rows it governs.
 *
 * The value is JSON, and the *shape* of each value is not the database's business: every
 * reader parses it with a zod schema at the point of use, so a hand-edited row fails loudly
 * where it is read instead of quietly somewhere downstream.
 */

export const MIGRATION_003_SETTINGS = `
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
