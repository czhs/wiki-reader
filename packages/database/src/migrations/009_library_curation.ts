/**
 * Migration 009 — a removal is a fact, not the absence of a row.
 *
 * Taking a paper out of the library is the researcher saying "this is not part of what I am
 * working on". Implemented as `DELETE FROM documents` that statement survives exactly until
 * the next Zotero import, which finds an item it has no record of and dutifully creates it
 * again — the library re-grows what was pruned and the researcher has to prune it forever.
 *
 * So the removal is written down where the import already looks. `external_references` is the
 * table that answers "have I seen this Zotero key before?", and `removed_at` extends the
 * answer from yes/no to yes/no/**yes, and it was removed on purpose**. The importer reads it
 * before writing anything, so a tombstoned key is skipped whole — no document row, no
 * attachments, no extraction job — including on a `force` run.
 *
 * The tombstone stays on the *reference*, not on the document, because the reference is the
 * only thing that outlives the removal in a form the import can recognise. It is also why
 * removal is a soft delete: the document row keeps hanging on to the annotations and links the
 * researcher made, which are their work and not Zotero's to take away (criterion B03), and
 * restoring is clearing two fields rather than an import that cannot bring back a highlight.
 *
 * Nothing here writes to Zotero. A removal is local, and `~/Zotero/zotero.sqlite` is never
 * opened at all (criterion B04).
 */

export const MIGRATION_009_LIBRARY_CURATION = `
ALTER TABLE external_references ADD COLUMN removed_at TEXT;

-- The import asks "is this key tombstoned?" once per item, and a scoped import over a large
-- library asks it hundreds of times. The unique index already covers the lookup itself; this
-- one makes "what has been removed?" — the restore list — an index scan rather than a table
-- scan over every reference in the library.
CREATE INDEX external_references_removed_idx
  ON external_references(removed_at)
  WHERE removed_at IS NOT NULL;
`;
