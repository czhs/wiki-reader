/**
 * Migration 015 — a deleted notebook goes to a bin first (criterion U11).
 *
 * Deleting was one press behind one confirmation, and it took the notebook, its journal, its
 * claims and its edges with no undo. The confirmation said what would go, which is better than
 * "are you sure?" and still not the same as being able to change your mind: the researcher's
 * verdict was that delete should put the thing somewhere, and that somewhere should be
 * emptiable on purpose.
 *
 * So this is the one column that makes that possible. `trashed_at` is *not* a fourth status:
 * a notebook in the bin is still `discarded` and still carries the reason it was dropped,
 * which is what keeps `question:delete`'s precondition — discarded before deleted — exactly
 * as it was and simply adds a second one in front of it. A null means the notebook is where
 * it was; a timestamp means it is in the bin, and when it went there.
 *
 * Nothing is destroyed by this migration and nothing is destroyed by the feature: emptying
 * the bin runs the same `questions.delete` that ran before, notebook by notebook.
 */

export const MIGRATION_015_TRASH_BIN = `
ALTER TABLE questions ADD COLUMN trashed_at TEXT;
`;
