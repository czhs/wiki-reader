/**
 * Migration 012 — a journal belongs to its notebook (criteria P02, P03).
 *
 * Migration 005 keyed a day by its ISO date alone, which was right while there was one
 * journal. It stopped being right the moment the notebook became the unit of work: a week of
 * use produced days in which two lines of thought were logged on the same page, and "what did
 * I do on the 4th?" answered about the whole library instead of about the work in hand. The
 * key is therefore `(notebook_id, date)` — still natural, still not a minted id, for the
 * reason 005 gave: blanking a day deletes its row, and an edge that pointed at that day must
 * mean the same day when it is written again.
 *
 * A link endpoint follows the key: a journal entity is addressed as `<notebook id>:<date>`,
 * and the existing rows in `links` are rewritten here rather than left to resolve to nothing.
 *
 * Nothing is dropped on the way. Days written before journals had an owner are adopted by the
 * first notebook in the queue, and by a notebook created here when the library has none —
 * losing a researcher's log to a schema change would be the worst possible trade for a
 * cleaner table. The minted id is `qst_` + 26 hex characters, which is a subset of the
 * Crockford alphabet the id schema accepts, so an adopted journal's notebook is an ordinary
 * notebook in every way.
 *
 * `journal_start` is the other half. A calendar has to begin somewhere, and until now that
 * was derived from when the database file was made — a fact about the installation, not about
 * the work. It is the researcher's to set (`P03`); null means nobody has said, and the
 * calendar then starts at the notebook's own beginning.
 */

export const MIGRATION_012_NOTEBOOK_JOURNALS = `
ALTER TABLE questions ADD COLUMN journal_start TEXT
  CHECK (journal_start IS NULL
         OR journal_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

INSERT INTO questions (id, title, status, ordinal, importance, next_action,
                       discarded_reason, started_at, created_at, updated_at, body)
SELECT 'qst_' || lower(hex(randomblob(13))),
       'Field notebook',
       'active',
       0,
       NULL, NULL, NULL,
       (SELECT MIN(created_at) FROM journal_entries),
       (SELECT MIN(created_at) FROM journal_entries),
       (SELECT MAX(updated_at) FROM journal_entries),
       ''
 WHERE EXISTS (SELECT 1 FROM journal_entries)
   AND NOT EXISTS (SELECT 1 FROM questions);

CREATE TABLE journal_entries_v2 (
  notebook_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  date        TEXT NOT NULL
              CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  markdown    TEXT NOT NULL CHECK (length(trim(markdown)) > 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (notebook_id, date)
);

INSERT INTO journal_entries_v2 (notebook_id, date, markdown, created_at, updated_at)
SELECT (SELECT id FROM questions ORDER BY ordinal, id LIMIT 1),
       date, markdown, created_at, updated_at
  FROM journal_entries;

UPDATE links
   SET source_id = (SELECT id FROM questions ORDER BY ordinal, id LIMIT 1) || ':' || source_id
 WHERE source_type = 'journal'
   AND EXISTS (SELECT 1 FROM questions);

UPDATE links
   SET target_id = (SELECT id FROM questions ORDER BY ordinal, id LIMIT 1) || ':' || target_id
 WHERE target_type = 'journal'
   AND EXISTS (SELECT 1 FROM questions);

DROP TABLE journal_entries;
ALTER TABLE journal_entries_v2 RENAME TO journal_entries;

CREATE INDEX journal_entries_updated_idx  ON journal_entries(updated_at DESC);
CREATE INDEX journal_entries_notebook_idx ON journal_entries(notebook_id, date);
`;
