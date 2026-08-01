# Database

SQLite via better-sqlite3. **The migrations in `packages/database/src/migrations/` are the
authoritative schema** — this file holds conventions and gotchas, not a table listing that
would drift from them.

## Conventions

- Text ids, minted by `@wr/document-model`, never autoincrement integers. Stable across
  machines and independent of Zotero internals.
- `created_at` / `updated_at` are ISO-8601 UTC strings.
- Foreign keys are ON. Multi-record writes run in a transaction.
- Soft delete only where a row must survive its own deletion (annotations). Everything else
  deletes for real.
- No SQL outside `packages/database`. Repositories expose intent, not queries.
- Files live on disk. The database stores metadata, paths, hashes, extracted text and indexes.

## Connection

`openDatabase()` sets WAL, `foreign_keys=ON`, and a busy timeout. It takes a `nativeBinding`
path because better-sqlite3 is compiled per ABI: vitest loads the Node build, Electron loads a
separately staged one under `apps/desktop/resources/native/electron-<version>/`. They never
overwrite each other. Mass failures here mean an ABI mismatch, not a code bug — see `.nvmrc`.

## Migrations

Forward-only, numbered, each in its own file, applied in one transaction and recorded in
`schema_migrations`. Running the migrator twice applies nothing (`T01`).

Never edit an applied migration — add another. A migration that widens a column type must also
decide what existing values become; narrowing a free-form string to an enum without that step
is how the W11 colour change broke 17 tests.

## Full-text search

FTS5 external-content tables over `document_chunks`, plus annotations and notes. Chunking is
structural — PDF by page, HTML and markdown by heading — because a result is only useful if it
carries enough location to reveal the source (`T08`).

Rebuild the index from `document_chunks`; never hand-write into an FTS shadow table.

## Links

One typed directed edge table. `origin` distinguishes `manual` from `derived` — the wikilink
re-index sweep deletes only `derived` rows for the document being indexed. Deleting by
`source_id` alone destroys manual links and still passes a test that only checks wikilinks
work (`W07`).

Indexed on `(source_type, source_id)`, `(target_type, target_id)`, `type`, and the
type-prefixed pairs, so a neighbourhood query never loads the graph (`W10`).

A `question-references-…` edge is what a notebook collecting a paper or a highlight *is*. It
also appears as a block in `questions.body`, written by the main process — the edge is what
every query reads and the block is what the researcher sees. Migration 014 dropped
`card_positions`: the desk board it belonged to is retired (`P06`).

## Natural keys

`journal_entries` is keyed `(notebook_id, date)` — a real natural key, not a minted id.
Blanking a day deletes the row, and an edge that pointed at "the 4th in this notebook" must
mean the same day when it is written again. A journal endpoint in `links` is therefore
`<notebook id>:<date>`; `journalEntityId` / `parseJournalEntityId` in `@wr/shared-types` are
the only places that shape is spelled out.

`questions` is the notebooks table. The name is kept on purpose: the word retired from the
interface in milestone 5, and renaming a released schema would change nothing the researcher
sees while invalidating every migration checksum below it.

## The database is an index

Markdown documents are files on disk; their rows are derived and rebuildable. Where a file and
a row disagree, the file wins.
