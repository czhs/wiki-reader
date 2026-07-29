/**
 * Migration 010 — what a node is called here, which is not what the document is called.
 *
 * A graph node is labelled with the title of the thing behind it, and a title imported from
 * Zotero is often the wrong label for a graph: `Attention Is All You Need` reads fine in a
 * library list and is unreadable at eleven pixels beside forty other discs. So the researcher
 * renames the node.
 *
 * The obvious implementation is to write that name into `documents.title`, and it is wrong.
 * The title is Zotero's field, refreshed from the item on every import: a name written there
 * survives until the next sync and then silently reverts, and the researcher has no way to
 * tell that is what happened (criterion G03). So the name lives here instead, in a table the
 * import has no reason to touch, and the title goes on being what Zotero says it is.
 *
 * Keyed by `(entity_type, entity_id)` rather than by document, because a node is anything the
 * graph can draw — a highlight and a note are as renameable as a paper — and there is no
 * foreign key for the same reason: the key is polymorphic. A name whose entity is gone is
 * harmless; the graph reads names for the nodes it already has.
 */

export const MIGRATION_010_GRAPH_NODE_NAMES = `
CREATE TABLE graph_node_names (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
) WITHOUT ROWID;
`;
