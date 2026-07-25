# Database

SQLite through `better-sqlite3`, main process only. Files live on disk; this schema stores
metadata, paths, hashes, extracted text and search indexes. `packages/database/src/index.ts`
states the boundary, and both ESLint and `check_renderer_boundary()` in
`scripts/verify_completion.py` enforce it.

## Conventions

- Primary keys are application-minted prefixed ULIDs (see [ID scheme](#id-scheme)).
- Timestamps are ISO-8601 UTC strings, so lexicographic order is chronological order. They come
  from an injectable `Clock` (`packages/database/src/clock.ts`) — no repository calls
  `Date.now()` directly, because tests need deterministic ordering without sleeping.
- JSON-valued columns carry a `_json` suffix and are validated with zod on read
  (`packages/database/src/mappers.ts`). Schema drift or a hand-edited row surfaces as a
  validation error at the repository boundary rather than as a mystery `undefined` three layers
  up.
- Soft deletion (`deleted_at`) exists only where the user can restore the record: `documents`,
  `annotations`, `notes`. Join tables are hard-deleted.

## Connection

`openSqlite()` in `packages/database/src/connection.ts` applies these pragmas to every
connection, in order:

| Pragma | Why |
|---|---|
| `foreign_keys = ON` | SQLite defaults it off, and it is per-connection |
| `journal_mode = WAL` | concurrent readers during a write; skipped for `:memory:`, where SQLite errors on it |
| `synchronous = NORMAL` | |
| `busy_timeout = 5000` | |
| `temp_store = MEMORY` | |
| `recursive_triggers = ON` | keeps the FTS shadow tables consistent under cascading deletes |

`nativeBinding` is passed explicitly because Node (vitest) and Electron have different ABIs and
`better-sqlite3` resolves a single `build/Release/better_sqlite3.node` with no ABI component in
the path. `foreignKeysEnabled()` and `fts5Available()` are exported so a test can assert the
build actually has what the schema needs.

## Migrations

`packages/database/src/migrator.ts`, forward-only.

`MIGRATIONS` in `packages/database/src/migrations/index.ts` is an ordered list of
`{ id, name, sql }`. `runMigrations()`:

1. Creates `schema_migrations (id, name, checksum, applied_at)` if absent and reads it.
2. For each migration in id order, computes `textHash(migration.sql)` (the FNV-1a variant from
   `@wr/document-model`, not a cryptographic hash — it answers "did this text change?").
3. If the id is already recorded and the checksum differs, throws `MigrationChecksumError`. A
   released migration is never edited; correcting the schema means adding a new one, and this is
   what stops two machines silently diverging.
4. Otherwise runs `BEGIN` / `db.exec(sql)` / insert into `schema_migrations` /
   `PRAGMA user_version = <id>` / `COMMIT`, rolling back on any failure. The transaction is
   driven explicitly because `better-sqlite3` refuses a multi-statement `exec` inside its
   prepared-transaction wrapper.

Applying is idempotent: a current database applies nothing. `PRAGMA user_version` equals the
highest applied id, and `LATEST_SCHEMA_VERSION` is what a fresh database reports.
`openDatabase({ migrate: false })` skips the run, for inspecting an existing file.

## Tables

Migration 001 (`packages/database/src/migrations/001_initial.ts`) creates all of the following.

### Documents and files

**`documents`** — one row per bibliographic record. `id` (PK, `doc_…`), `title`, `abstract`,
`published_date` (free text, may be partial: `2015`, `1987-04`), `doc_type` ∈ {`pdf`,
`webpage`, `note`, `other`}, `authors_json` (CSL-ish `{ family, given?, literal? }[]`, default
`'[]'`), `source` (provenance, e.g. `zotero`), `created_at`, `updated_at`, `deleted_at`.
Indexes: `documents_updated_idx(updated_at DESC)`, `documents_live_idx(deleted_at, title)`.

**`document_revisions`** — what anchors and chunks hang off.

| Column | Notes |
|---|---|
| `id` | PK, `drv_…` |
| `document_id` | → `documents(id)` ON DELETE CASCADE |
| `revision_no` | UNIQUE with `document_id` |
| `content_hash` | SHA-256 of the file bytes this revision describes |
| `extracted_text_hash` | nullable |

A revision is created at *extraction* time rather than at import, so the content hash and the
extracted text always describe the same bytes.

**`document_files`** — the bytes on disk.

| Column | Notes |
|---|---|
| `id` | PK, `dfl_…`; this is the id in an `rrfile://` URL |
| `document_id` | → `documents(id)` CASCADE |
| `revision_id` | → `document_revisions(id)` ON DELETE SET NULL |
| `path` | absolute, **UNIQUE**; never leaves the main process |
| `mime_type`, `byte_size` (≥0), `content_hash` | |
| `role` | `primary` \| `supplementary` \| `snapshot` \| `original-snapshot` |

The unique index on `path` is what makes re-import cheap: the same PDF on disk is one row
however many times the library is refreshed.

**`document_chunks`** — the searchable unit and the thing a result points at.

| Column | Notes |
|---|---|
| `id` | PK, `chk_…` |
| `document_id` | CASCADE |
| `revision_id` | CASCADE; UNIQUE with `chunk_index` |
| `kind` | `pdf-page` \| `html-section` \| `note-block` |
| `page_index`, `section_path` | nullable, per kind |
| `char_start`, `char_end` | `char_end >= char_start`; offsets **within the page**, not the document, so re-extracting one page does not invalidate the others |
| `text` | |

### Annotations

**`annotations`** — `id`, `document_id` (CASCADE), `revision_id` (SET NULL),
`kind` ∈ {`highlight`, `underline`, `note-anchor`}, `color`, `selected_text`, `comment`,
timestamps, `deleted_at`. `selected_text` is never rewritten: it records what the user actually
saw, even after an embedded excerpt re-resolves the annotation by id.

**`annotation_anchors`** — the text-based evidence, one row per annotation (`annotation_id` is
UNIQUE and cascades). `kind` ∈ {`pdf`, `html`}; `anchor_json` holds the full
`AnnotationAnchor` — quote (exact/prefix/suffix), position offsets, page-normalized 0..1 rects,
hashes; `page_index` and `section_path` are denormalized for indexed ordering; `text_hash` is
the hash of the anchored page's or snapshot's normalized text; `content_hash` is that of the
revision the anchor was made against.

Viewport pixel coordinates are never persisted. Rects are page-relative so they survive zoom,
window size and DPI; the quote and hashes are what let a highlight be relocated after
re-extraction.

### Notes

**`notes`** — `id`, `title`, `content_json` (Tiptap/ProseMirror, verbatim), `content_text`
(flattened, what FTS indexes), timestamps, `deleted_at`.

### Links

**`links`** — every relationship in the application is a typed directed edge here. There is
deliberately no untyped backlink table: direction and type are primary data.

| Column | Notes |
|---|---|
| `id` | PK, `lnk_…` |
| `type` | open-ended string; `KNOWN_LINK_TYPES` in `packages/shared-types/src/domain.ts` lists the ones the app mints |
| `source_type`/`source_id`, `target_type`/`target_id` | UNIQUE together with `type` |
| `source_location_json`, `target_location_json` | `DocumentLocation` |
| `label`, `ordinal` | ordinal orders siblings under a parent |
| `origin` | `manual` \| `derived` |
| `generator` | which importer or parser produced a derived edge |
| `metadata_json` | |

Indexes `links_source_idx`, `links_target_idx`, `links_type_idx`, `links_type_source_idx`,
`links_type_target_idx` come straight from `docs/SPEC.md` § Database indexes. There are no
foreign keys on the endpoints — an edge may reference an entity type that has no table (`heading`,
`figure`, `citation`, `excerpt`), and a dangling endpoint is surfaced as `broken: true` rather
than prevented.

### Organisation and session state

| Table | Shape |
|---|---|
| `collections` | `id`, `name`, `parent_id` → `collections(id)` ON DELETE SET NULL, timestamps |
| `document_collections` | `(document_id, collection_id)` composite PK, both CASCADE |
| `tags` | `id`, `name` UNIQUE |
| `document_tags` | `(document_id, tag_id)` composite PK, both CASCADE |
| `reading_positions` | `document_id` PK (CASCADE), `location_json`, `updated_at` — one row per document, so reopening restores where you were |
| `workspace_layouts` | `name` PK, `layout_json`, `panel_state_json` (default `'{}'`), `updated_at` |

### External provenance

**`external_references`** — `id`, `entity_type` ∈ {`document`, `documentFile`, `collection`,
`tag`}, `entity_id`, `provider`, `external_key`, `external_version`, `payload_json`, timestamps.
`UNIQUE (provider, entity_type, external_key)` is what makes re-import idempotent: refreshing an
item finds the existing internal entity instead of creating a duplicate. Zotero keys live here
and are never internal primary keys.

### Background work

**`indexing_jobs`** — `id`, `document_id` (CASCADE), `job_type` ∈ {`extract-text`, `index-fts`},
`status` ∈ {`queued`, `running`, `complete`, `failed`}, `attempts` (≥0), `error`, `created_at`,
`started_at`, `finished_at`.

A partial unique index enforces at most one outstanding job per document and type:

```sql
CREATE UNIQUE INDEX indexing_jobs_pending_idx
  ON indexing_jobs(document_id, job_type)
  WHERE status IN ('queued', 'running');
```

Failures are retained with their error text. Silent indexing failure is the one bug that makes
search quietly incomplete.

## Full-text search

**`search_entries`** is the searchable projection of every indexable entity, and holds the
location a result needs to reopen its source:

| Column | Notes |
|---|---|
| `rowid` | INTEGER PK — the join key to the FTS table |
| `entity_type` | `document` \| `chunk` \| `annotation` \| `note` |
| `entity_id` | UNIQUE with `entity_type` |
| `document_id` | nullable — notes have none |
| `location_json` | the `DocumentLocation` to reveal |
| `title`, `body`, `meta` | `meta` holds authors, tags and collection names: searchable, ranked separately |
| `updated_at` | |

**`search_fts`** is an external-content FTS5 index over it:

```sql
CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body, meta,
  content = 'search_entries',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);
```

External content means the text is stored once, in `search_entries`, and FTS5 keeps only the
index — so `snippet()` and `bm25()` still work while deletes stay indexed lookups rather than
table scans. External-content tables do not maintain themselves, so three triggers do it:

| Trigger | Action |
|---|---|
| `search_entries_ai` AFTER INSERT | `INSERT INTO search_fts(rowid, title, body, meta)` |
| `search_entries_ad` AFTER DELETE | `INSERT INTO search_fts(search_fts, rowid, …) VALUES ('delete', …)` with the **old** values |
| `search_entries_au` AFTER UPDATE | the `'delete'` row with old values, then a plain insert with new values |

The `'delete'` command must be given the old column values verbatim; that is why the delete
trigger carries all three text columns.

The index is a projection, never a source of truth: `SearchIndexRepository.rebuild()` issues
`INSERT INTO search_fts(search_fts) VALUES('rebuild')` and reconstructs it from
`search_entries`. Ranking uses `bm25(search_fts, 8.0, 1.0, 2.0)` in
`packages/search/src/search-service.ts`.

## ID scheme

`mintId(kind)` in `packages/document-model/src/ids.ts` produces
`<prefix>_<10 chars of timestamp><16 chars of randomness>` in lowercase Crockford base32
(`0123456789abcdefghjkmnpqrstvwxyz` — no `i`, `l`, `o`, `u`). Lexicographic order matches
creation order, which makes `ORDER BY id` cheap and gives stable pagination without a separate
sort column. Randomness comes from Web Crypto, present in both Node and the sandboxed renderer.

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `doc` | document | `not` | note |
| `dfl` | documentFile | `lnk` | link |
| `drv` | documentRevision | `col` | collection |
| `chk` | documentChunk | `tag` | tag |
| `ann` | annotation | `ext` | externalReference |
| `anc` | annotationAnchor | `job` | indexingJob |

`packages/shared-types/src/ids.ts` brands each type, so a `DocumentId` cannot be passed where an
`AnnotationId` is expected, and validates the shape as `<prefix>_<26 chars>`. The `rrfile://`
handler re-applies the `dfl_` form as a regex before touching the database.

## Repositories

`WikiReaderDatabase` (`packages/database/src/database.ts`) exposes one repository per concern.
No SQL is written anywhere else — not in IPC handlers, not in the renderer, not in workers.
`db.transaction(fn)` wraps `better-sqlite3`'s transaction; nested calls join the outer one.

| Property | Class | Owns |
|---|---|---|
| `documents` | `DocumentsRepository` | `documents` CRUD, filtered listing (collection / tag / title `LIKE` with wildcards escaped), soft delete, live count |
| `revisions` | `DocumentRevisionsRepository` | `document_revisions`; `createIfChanged` returns the existing revision for an unchanged content hash so re-import does not fork history |
| `files` | `DocumentFilesRepository` | `document_files`; `upsertByPath`, `primaryForDocument` (primary, then snapshot, then anything), `setRevision`. Also exports `toDocumentFileRef`, the only place a path is stripped and an `rrfile://` URL substituted |
| `chunks` | `DocumentChunksRepository` | `document_chunks`; `replaceForRevision` deletes and reinserts atomically — re-extraction is not additive |
| `annotations` | `AnnotationsRepository` | `annotations` + `annotation_anchors` + the `annotation-belongs-to-document` edge, all in one transaction. An annotation without anchoring evidence could never be rendered again, so a partial write must not survive |
| `notes` | `NotesRepository` | `notes`; `listForAnnotation` / `listForDocument` join through the link table |
| `links` | `LinksRepository` | `links`; `create` is idempotent on `(type, source, target)`; `findReferences` (L03), `findByType` with document/collection/tag scoping (L04), `counts`, and endpoint resolution for display |
| `collections` | `CollectionsRepository` | `collections` and `document_collections` membership |
| `tags` | `TagsRepository` | `tags` (unique by name) and `document_tags` |
| `readingPositions` | `ReadingPositionsRepository` | `reading_positions` upsert / get / clear |
| `layouts` | `WorkspaceLayoutsRepository` | `workspace_layouts`; the Dockview blob is stored verbatim and handed back unchanged |
| `externalReferences` | `ExternalReferencesRepository` | `external_references`; `resolveEntityId(provider, type, key)` is the idempotency hinge for import |
| `jobs` | `IndexingJobsRepository` | `indexing_jobs`; `enqueue` (reuses a pending job), `claimNext` (transactional claim + `attempts + 1`), `complete`, `fail`, `requeue`, `counts`, `listFailed` |
| `searchIndex` | `SearchIndexRepository` | write side of `search_entries` only. Nothing here parses queries — that is `@wr/search` |
| `library` | `LibraryRepository` | the sidebar projection: document + file refs + tags + collection ids + annotation count + `hasExtractedText` |
| `entities` | `EntityResolver` | not a table — resolves `(entityType, entityId)` to title, document, excerpt and location for link results, the peek widget and `goToParent`, returning `null` for an unresolvable pair so callers can surface a broken link |
