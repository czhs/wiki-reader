/**
 * Migration 001 — initial schema.
 *
 * Every entity in `docs/SPEC.md` § Database gets a table here. Files live on disk; this
 * schema stores metadata, paths, hashes, extracted text and search indexes only.
 *
 * Conventions:
 *  - Primary keys are the application-minted prefixed ULIDs from @wr/document-model.
 *  - Timestamps are ISO-8601 UTC strings, so lexicographic order is chronological order.
 *  - JSON-valued columns carry a `_json` suffix and are validated with zod on read.
 *  - Soft deletion (`deleted_at`) exists only where the user can restore the record:
 *    documents, annotations and notes. Join tables are hard-deleted.
 */

export const MIGRATION_001_INITIAL = `
-- ---------------------------------------------------------------------------
-- Documents and their files
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  doc_type       TEXT NOT NULL CHECK (doc_type IN ('pdf', 'webpage', 'note', 'other')),
  authors_json   TEXT NOT NULL DEFAULT '[]',
  abstract       TEXT,
  published_date TEXT,
  source         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE INDEX documents_updated_idx ON documents(updated_at DESC);
CREATE INDEX documents_live_idx    ON documents(deleted_at, title);

CREATE TABLE document_revisions (
  id                  TEXT PRIMARY KEY,
  document_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_no         INTEGER NOT NULL,
  content_hash        TEXT NOT NULL,
  extracted_text_hash TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (document_id, revision_no)
);

CREATE INDEX document_revisions_document_idx ON document_revisions(document_id, revision_no DESC);
CREATE INDEX document_revisions_hash_idx     ON document_revisions(content_hash);

CREATE TABLE document_files (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_id  TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,
  -- Absolute path on disk. Never leaves the main process: the renderer receives
  -- rrfile://<file id> and the protocol handler resolves the path through this row.
  path         TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL CHECK (byte_size >= 0),
  content_hash TEXT NOT NULL,
  role         TEXT NOT NULL
               CHECK (role IN ('primary', 'supplementary', 'snapshot', 'original-snapshot')),
  created_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX document_files_path_idx ON document_files(path);
CREATE INDEX document_files_document_idx    ON document_files(document_id);
CREATE INDEX document_files_hash_idx        ON document_files(content_hash);

CREATE TABLE document_chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_id  TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('pdf-page', 'html-section', 'note-block')),
  page_index   INTEGER,
  section_path TEXT,
  char_start   INTEGER NOT NULL CHECK (char_start >= 0),
  char_end     INTEGER NOT NULL CHECK (char_end >= char_start),
  text         TEXT NOT NULL,
  UNIQUE (revision_id, chunk_index)
);

CREATE INDEX document_chunks_document_idx ON document_chunks(document_id, chunk_index);
CREATE INDEX document_chunks_page_idx     ON document_chunks(document_id, page_index);

-- ---------------------------------------------------------------------------
-- Annotations
-- ---------------------------------------------------------------------------

CREATE TABLE annotations (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_id   TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('highlight', 'underline', 'note-anchor')),
  color         TEXT NOT NULL,
  -- The text as selected at creation time. Embedded excerpts re-resolve by annotation
  -- id, but this column is never rewritten: it records what the user actually saw.
  selected_text TEXT NOT NULL,
  comment       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE INDEX annotations_document_idx ON annotations(document_id, deleted_at, created_at);

-- Text-based anchoring evidence. Viewport pixel coordinates are never persisted:
-- rects are page-normalized 0..1, and the quote/position/hash columns let a highlight
-- be relocated after re-extraction or a document revision.
CREATE TABLE annotation_anchors (
  id            TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL UNIQUE REFERENCES annotations(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('pdf', 'html')),
  anchor_json   TEXT NOT NULL,
  page_index    INTEGER,
  section_path  TEXT,
  -- Hash of the normalized text of the anchored page or snapshot.
  text_hash     TEXT NOT NULL,
  -- Content hash of the revision the anchor was created against.
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX annotation_anchors_page_idx ON annotation_anchors(page_index);

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------

CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_text TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE INDEX notes_updated_idx ON notes(deleted_at, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Typed directed links
--
-- Every relationship in the application is an edge here. There is deliberately no
-- untyped backlink table: direction and type are part of the primary data.
-- ---------------------------------------------------------------------------

CREATE TABLE links (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL,
  source_type          TEXT NOT NULL,
  source_id            TEXT NOT NULL,
  target_type          TEXT NOT NULL,
  target_id            TEXT NOT NULL,
  source_location_json TEXT,
  target_location_json TEXT,
  label                TEXT,
  ordinal              INTEGER,
  origin               TEXT NOT NULL CHECK (origin IN ('manual', 'derived')),
  generator            TEXT,
  metadata_json        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (type, source_type, source_id, target_type, target_id)
);

CREATE INDEX links_source_idx      ON links(source_type, source_id);
CREATE INDEX links_target_idx      ON links(target_type, target_id);
CREATE INDEX links_type_idx        ON links(type);
CREATE INDEX links_type_source_idx ON links(type, source_type, source_id);
CREATE INDEX links_type_target_idx ON links(type, target_type, target_id);

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------

CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES collections(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX collections_parent_idx ON collections(parent_id, name);

CREATE TABLE document_collections (
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, collection_id)
);

CREATE INDEX document_collections_collection_idx ON document_collections(collection_id);

CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE document_tags (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX document_tags_tag_idx ON document_tags(tag_id);

-- ---------------------------------------------------------------------------
-- Session state
-- ---------------------------------------------------------------------------

CREATE TABLE reading_positions (
  document_id   TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  location_json TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE workspace_layouts (
  name             TEXT PRIMARY KEY,
  layout_json      TEXT NOT NULL,
  panel_state_json TEXT NOT NULL DEFAULT '{}',
  updated_at       TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- External provenance
--
-- Zotero keys live here and are never used as internal primary keys. The unique
-- index is what makes re-import idempotent: refreshing an item finds the existing
-- internal entity instead of creating a duplicate.
-- ---------------------------------------------------------------------------

CREATE TABLE external_references (
  id               TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL
                   CHECK (entity_type IN ('document', 'documentFile', 'collection', 'tag')),
  entity_id        TEXT NOT NULL,
  provider         TEXT NOT NULL,
  external_key     TEXT NOT NULL,
  external_version INTEGER,
  payload_json     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (provider, entity_type, external_key)
);

CREATE INDEX external_references_entity_idx ON external_references(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Background work
-- ---------------------------------------------------------------------------

CREATE TABLE indexing_jobs (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  job_type    TEXT NOT NULL CHECK (job_type IN ('extract-text', 'index-fts')),
  status      TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error       TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);

CREATE INDEX indexing_jobs_status_idx ON indexing_jobs(status, created_at);

-- At most one outstanding job per (document, type): enqueueing twice is a no-op
-- rather than a duplicated extraction.
CREATE UNIQUE INDEX indexing_jobs_pending_idx
  ON indexing_jobs(document_id, job_type)
  WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Full-text search
--
-- search_entries is the searchable projection of every indexable entity, and holds
-- the location information a result needs to reopen its source. search_fts is an
-- external-content FTS5 index over it, so snippet() and bm25() work while deletes
-- stay indexed lookups rather than table scans.
-- ---------------------------------------------------------------------------

CREATE TABLE search_entries (
  rowid         INTEGER PRIMARY KEY,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('document', 'chunk', 'annotation', 'note')),
  entity_id     TEXT NOT NULL,
  document_id   TEXT,
  location_json TEXT,
  title         TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  -- Authors, tags and collection names: searchable, but ranked separately.
  meta          TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL,
  UNIQUE (entity_type, entity_id)
);

CREATE INDEX search_entries_document_idx ON search_entries(document_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  body,
  meta,
  content = 'search_entries',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER search_entries_ai AFTER INSERT ON search_entries BEGIN
  INSERT INTO search_fts(rowid, title, body, meta)
  VALUES (new.rowid, new.title, new.body, new.meta);
END;

CREATE TRIGGER search_entries_ad AFTER DELETE ON search_entries BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body, meta)
  VALUES ('delete', old.rowid, old.title, old.body, old.meta);
END;

CREATE TRIGGER search_entries_au AFTER UPDATE ON search_entries BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body, meta)
  VALUES ('delete', old.rowid, old.title, old.body, old.meta);
  INSERT INTO search_fts(rowid, title, body, meta)
  VALUES (new.rowid, new.title, new.body, new.meta);
END;
`;
