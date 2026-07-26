/**
 * Migration 005 — the research journal.
 *
 * One entry per day, keyed by the ISO date itself rather than by a minted id. The date is a
 * real natural key here: there is exactly one entry for a day, a link to "what I did on the
 * 4th" means that day and not a row that happened to be written then, and blanking an entry
 * and writing it again later should not silently break the things that pointed at it.
 *
 * The CHECK on `markdown` is the interesting one. A day with a blank entry is *unlogged* —
 * "no entry" and "an empty entry" are the same fact and must not look different in a
 * calendar — so blanking an entry deletes the row, and the schema refuses to store the empty
 * string that would make an unlogged day render as a logged one.
 */

export const MIGRATION_005_JOURNAL = `
CREATE TABLE journal_entries (
  date       TEXT PRIMARY KEY
             CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  markdown   TEXT NOT NULL CHECK (length(trim(markdown)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX journal_entries_updated_idx ON journal_entries(updated_at DESC);
`;
