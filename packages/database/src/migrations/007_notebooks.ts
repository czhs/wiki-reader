/**
 * Migration 007 — field notebooks: the page behind a question.
 *
 * `body` is markdown **source**, stored as typed. The notebook this is migrated from began
 * by storing rendered HTML out of a `contenteditable` and had to be converted back, because
 * prose in a store that only one editor can read is prose nothing else can touch — not the
 * search index, not the librarian, not a text editor. It defaults to empty rather than to
 * the section template: the template is what a blank page *looks* like, and writing one into
 * every row would be the app putting words on the researcher's page.
 *
 * `cover_file_id` names a row in `document_files`, never a path. That is the only kind of
 * image reference the renderer can be given — `rrfile://<file id>` resolves through that
 * table — so a cover column holding a path would be a hole in the rule rather than a field.
 *
 * `hypotheses` is the point of the migration. While a claim is prose inside a body, evidence
 * can only attach to the whole page: the librarian can cite a page but not a claim, and
 * "evidence for and against" has nothing precise to hang on. With an id, a hypothesis is an
 * endpoint in `links` like everything else, and the edges are ordinary typed edges — there is
 * no second relationship mechanism here, and no evidence table.
 *
 * `ordinal` is stored for the same reason it is on `questions`: the order claims are listed
 * in is a judgement, and re-deriving it from a date would throw that judgement away.
 */

export const MIGRATION_007_NOTEBOOKS = `
ALTER TABLE questions ADD COLUMN body TEXT NOT NULL DEFAULT '';
ALTER TABLE questions ADD COLUMN description TEXT;
ALTER TABLE questions ADD COLUMN cover_file_id TEXT REFERENCES document_files(id) ON DELETE SET NULL;

CREATE TABLE question_tags (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, tag_id)
);

CREATE INDEX question_tags_tag_idx ON question_tags(tag_id);

CREATE TABLE hypotheses (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  statement   TEXT NOT NULL,
  status      TEXT NOT NULL
              CHECK (status IN ('open', 'supported', 'refuted', 'abandoned')),
  ordinal     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX hypotheses_question_idx ON hypotheses(question_id, ordinal);
`;
