/**
 * Migration 011 — what a node looks like, which is not what it is called.
 *
 * A graph of forty discs is forty identical discs. A picture on one of them is what makes a
 * paper findable at a glance in a way a label at eleven pixels is not, so a node takes an
 * icon (criterion G04).
 *
 * `file_id` names a row in `document_files`, never a path — the same rule `cover_file_id`
 * follows in migration 007, and for the same reason: `rrfile://<file id>` is the only image
 * reference the renderer can be given, so a column holding a path would be a hole in that
 * rule rather than a field. The image is an ordinary local file the library was given; adding
 * it is what admitted its one path to the allow-list, which is what lets the bytes be served
 * at all.
 *
 * A table of its own rather than a column on `graph_node_names`, because `display_name` there
 * is `NOT NULL`: a node with a picture and no name would need that constraint dropped, and
 * SQLite drops a constraint only by rebuilding the table — copying every row of something the
 * researcher's library already carries, to save one indexed lookup. Names and pictures are
 * also separately given up: clearing one is a `DELETE` here rather than a column set to null
 * beside a value somebody still wants.
 *
 * `ON DELETE CASCADE`, so an icon whose file is gone is gone. Removing a document from the
 * library is a *soft* delete (migration 009) and leaves both the file row and the icon
 * standing — this fires only when the row itself is deleted, and a node pointing at a file id
 * that no longer resolves would draw a broken picture for ever.
 *
 * Keyed by `(entity_type, entity_id)` like the names, and polymorphic for the same reason: a
 * highlight is as illustrable as a paper.
 */

export const MIGRATION_011_GRAPH_NODE_ICONS = `
CREATE TABLE graph_node_icons (
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  file_id     TEXT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
) WITHOUT ROWID;

CREATE INDEX graph_node_icons_file_idx ON graph_node_icons(file_id);
`;
