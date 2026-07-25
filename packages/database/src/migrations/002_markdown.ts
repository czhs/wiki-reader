/**
 * Migration 002 — markdown documents and the wiki corpus.
 *
 * Three of the changes here widen a CHECK constraint, which SQLite cannot do in place: the
 * table is rebuilt, the rows copied, and the indexes recreated. `PRAGMA legacy_alter_table`
 * is deliberately *not* used — the rebuild is written out so a reader can see that no column
 * changes meaning and no row is dropped.
 *
 * `documents.slug` is what a `[[wikilink]]` resolves against. It is nullable because only
 * corpus files have one: a Zotero PDF is addressed by title and id, never by page name. The
 * index is not UNIQUE — two files called `Notes.md` in different folders is a real corpus,
 * and refusing to import the second would be worse than resolving the link to the first.
 */

export const MIGRATION_002_MARKDOWN = `
-- --------------------------------------------------------------------------
-- documents: allow doc_type 'markdown', add the corpus slug and source path
-- --------------------------------------------------------------------------

CREATE TABLE documents_new (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  doc_type       TEXT NOT NULL
                 CHECK (doc_type IN ('pdf', 'webpage', 'markdown', 'note', 'other')),
  authors_json   TEXT NOT NULL DEFAULT '[]',
  abstract       TEXT,
  published_date TEXT,
  source         TEXT NOT NULL,
  slug           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

INSERT INTO documents_new
  (id, title, doc_type, authors_json, abstract, published_date, source, slug,
   created_at, updated_at, deleted_at)
SELECT id, title, doc_type, authors_json, abstract, published_date, source, NULL,
       created_at, updated_at, deleted_at
  FROM documents;

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

CREATE INDEX documents_updated_idx ON documents(updated_at DESC);
CREATE INDEX documents_live_idx    ON documents(deleted_at, title);
CREATE INDEX documents_slug_idx    ON documents(slug) WHERE slug IS NOT NULL;

-- --------------------------------------------------------------------------
-- document_chunks: markdown sections are a chunk kind
-- --------------------------------------------------------------------------

CREATE TABLE document_chunks_new (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_id  TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
  kind         TEXT NOT NULL
               CHECK (kind IN ('pdf-page', 'html-section', 'markdown-section', 'note-block')),
  page_index   INTEGER,
  section_path TEXT,
  char_start   INTEGER NOT NULL CHECK (char_start >= 0),
  char_end     INTEGER NOT NULL CHECK (char_end >= char_start),
  text         TEXT NOT NULL,
  UNIQUE (revision_id, chunk_index)
);

INSERT INTO document_chunks_new
SELECT id, document_id, revision_id, chunk_index, kind, page_index, section_path,
       char_start, char_end, text
  FROM document_chunks;

DROP TABLE document_chunks;
ALTER TABLE document_chunks_new RENAME TO document_chunks;

CREATE INDEX document_chunks_document_idx ON document_chunks(document_id, chunk_index);
CREATE INDEX document_chunks_page_idx     ON document_chunks(document_id, page_index);

-- --------------------------------------------------------------------------
-- annotation_anchors: markdown is an anchor kind
-- --------------------------------------------------------------------------

CREATE TABLE annotation_anchors_new (
  id            TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL UNIQUE REFERENCES annotations(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('pdf', 'html', 'markdown')),
  anchor_json   TEXT NOT NULL,
  page_index    INTEGER,
  section_path  TEXT,
  text_hash     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

INSERT INTO annotation_anchors_new
SELECT id, annotation_id, kind, anchor_json, page_index, section_path, text_hash,
       content_hash, created_at
  FROM annotation_anchors;

DROP TABLE annotation_anchors;
ALTER TABLE annotation_anchors_new RENAME TO annotation_anchors;

CREATE INDEX annotation_anchors_page_idx ON annotation_anchors(page_index);

-- --------------------------------------------------------------------------
-- Wanted pages
--
-- A [[slug]] that names no document is an ordinary part of writing a wiki, not an error, so
-- it is recorded rather than dropped: the graph shows it as a page worth writing, and it
-- disappears by itself once a file with that slug is imported. Rows are owned by the
-- indexing pass for one document and replaced wholesale on re-index, which is why the
-- primary key is (document_id, slug) and there is no surrogate id.
-- --------------------------------------------------------------------------

CREATE TABLE wanted_pages (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (document_id, slug)
);

CREATE INDEX wanted_pages_slug_idx ON wanted_pages(slug);
`;
