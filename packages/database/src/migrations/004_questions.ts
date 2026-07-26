/**
 * Migration 004 — research questions, the queue.
 *
 * A question is what the researcher is trying to find out. It is a first-class row rather
 * than front matter in a markdown file because everything else in the app already links
 * through `links`, and a question that lives in a file could only be pointed at by path.
 *
 * `ordinal` is the whole point of the table. The queue is arranged by hand and the
 * arrangement is a judgement about what to do next, so the order is *stored*: sorting by
 * `created_at` or by `importance` would silently discard it. Nothing derives it, and
 * nothing may re-sort a list that the researcher has already put in order.
 *
 * The CHECK on `discarded_reason` is deliberate. Discarding is not deleting — the reason a
 * question was dropped is the useful residue of having asked it — so a reasonless discard
 * is refused by the schema and not only by the repository above it.
 */

export const MIGRATION_004_QUESTIONS = `
CREATE TABLE questions (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'queued', 'discarded')),
  ordinal          INTEGER NOT NULL,
  importance       INTEGER,
  next_action      TEXT,
  discarded_reason TEXT,
  started_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (status <> 'discarded' OR discarded_reason IS NOT NULL)
);

CREATE INDEX questions_order_idx  ON questions(ordinal);
CREATE INDEX questions_status_idx ON questions(status, ordinal);
`;
