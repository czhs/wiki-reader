/**
 * Migration 016 — the notebook's source language, and its own header (criteria S04, S05).
 *
 * Two columns, and the first one is the migration decision made provable rather than hoped
 * for. `body_format` defaults to `'markdown'`, so **every body already written keeps saying
 * what it is** and keeps rendering through the pipeline it was written for; only notebooks
 * minted after this point are `'typst'`. Nothing is rewritten, so nothing can be lost by a
 * converter guessing wrong about somebody's paper — which is the whole of "nothing already
 * written is lost".
 *
 * `typst_header` is this notebook's own header (`S05`): the definitions it adds on top of the
 * application-wide one, which lives in `settings` because it is a preference and has nothing
 * to join to. It is a column rather than a file on disk for the same reason the body is one —
 * the renderer never receives a path, so a header the researcher cannot edit in the app is a
 * header they cannot edit at all.
 */

export const MIGRATION_016_NOTEBOOK_TYPST = `
ALTER TABLE questions ADD COLUMN body_format TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE questions ADD COLUMN typst_header TEXT NOT NULL DEFAULT '';
`;
