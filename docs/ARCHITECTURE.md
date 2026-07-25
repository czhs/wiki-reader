# Architecture

wiki-reader is an Electron application in a pnpm monorepo. The package boundary is also the
privilege boundary: a package either runs in the main process, where it may open files and
SQLite, or in the renderer, where it may not. `scripts/verify_completion.py`
(`check_renderer_boundary`) enforces the split by scanning renderer package sources for
imports of `electron`, `better-sqlite3`, `@wr/database`, `@wr/zotero-adapter`, `node:fs` and
`node:child_process`.

## Process model

| Process | Entry | Bundled to | Owns |
|---|---|---|---|
| main | `apps/desktop/src/main/index.ts` | `out/main` (ESM) | filesystem, SQLite, Zotero HTTP, extraction, indexing, `rrfile://` |
| preload | `apps/desktop/src/preload/index.ts` | `out/preload/index.cjs` | exactly two bridge functions plus `platform` |
| renderer | `apps/desktop/src/renderer/main.tsx` | `out/renderer` | React, Dockview, readers, annotation and search UI |

`apps/desktop/electron.vite.config.ts` forces the preload to CommonJS (`format: 'cjs'`,
`entryFileNames: 'index.cjs'`) because a sandboxed renderer can only load a CJS preload, and
marks `better-sqlite3` external in the main build so the native binding is resolved at runtime
rather than bundled.

`createWindow()` in `apps/desktop/src/main/index.ts` sets `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, `webviewTag: false`, denies every
`setWindowOpenHandler` request, and cancels `will-navigate` for any URL outside
`ELECTRON_RENDERER_URL`. See `docs/SECURITY.md`.

### Main-process modules

| File | Responsibility |
|---|---|
| `index.ts` | Electron lifecycle, window creation, native-binding path resolution, wiring |
| `services.ts` | `AppServices` container: database, Zotero client + importer, search service + indexer, extraction pipeline, logger, allowed roots, `publish` |
| `router.ts` | The single `ipcMain.handle`; zod validation, dispatch, error mapping, event publishing |
| `handlers.ts` | One plain function per IPC channel over `AppServices`; no Electron imports |
| `protocol.ts` | `rrfile://` scheme registration, request resolution, range responses, navigation lockdown |
| `paths.ts` | Allowed-roots containment test |
| `pipeline.ts` | Durable extraction queue driver (`ExtractionPipeline`) |
| `logger.ts` | One JSON object per line, with `child(scope)` prefixing |

`services.ts`, `handlers.ts` and `pipeline.ts` deliberately import no Electron API. That is
what lets the whole backend be constructed inside a vitest process against a temporary SQLite
file, so the persistence criteria are tested as real integration rather than against mocks.
Electron-specific glue is confined to `index.ts`, `router.ts` and `protocol.ts`.

Two indirections exist because of ordering constraints:

- `registerProtocolScheme()` is called at module load, before `app.whenReady()`, because
  `protocol.registerSchemesAsPrivileged` has no effect afterwards.
- `createServices({ publish })` receives a late-bound closure
  `(topic, payload) => router?.publish(...)`, because the router owns the window list and does
  not exist when services are built.

`nativeBindingPath()` resolves `better-sqlite3` to
`resources/native/electron-<version>/better_sqlite3.node` (overridable with
`WR_SQLITE_BINDING`). Node and Electron have different ABIs and `better-sqlite3` has no ABI
component in its default binding path, so the two builds are staged separately.

Environment overrides read in `index.ts`: `WR_DATABASE_PATH`, `WR_ZOTERO_DATA_DIR`,
`WR_SQLITE_BINDING`, `ELECTRON_RENDERER_URL`.

## Package graph

```
                     @wr/shared-types   (zod only; no runtime deps)
                              |
                     @wr/document-model  (ids, hashing, anchors, links, history)
                     /                 \
      main side ----+                   +---- renderer side
      @wr/database                       @wr/workbench
      @wr/zotero-adapter -> database     @wr/pdf-reader   -> workbench
      @wr/search         -> database     @wr/html-reader  -> workbench
      @wr/text-extraction-worker         @wr/annotations  -> workbench, shared-ui
      @wr/indexing-worker -> database,   @wr/note-editor  -> workbench
                             search      @wr/shared-ui
```

| Package | Side | State |
|---|---|---|
| `@wr/shared-types` | both | implemented — IPC contracts, domain schemas, location/anchor types |
| `@wr/document-model` | both | implemented — ULID minting, FNV-1a text hashes, normalization, text-quote resolution, PDF anchors, internal links, navigation history, the `DocumentAdapter` interface |
| `@wr/database` | main only | implemented — connection, migrator, repositories, entity resolver |
| `@wr/zotero-adapter` | main only | implemented — read-only local API client, mapping, idempotent importer |
| `@wr/search` | main only | implemented — chunking, query parser, FTS5 indexer, result mapping |
| `@wr/workbench` | renderer | implemented — context keys, command registry, keybinding registry, layout serialization, panel targets, entity links, parent walking |
| `@wr/text-extraction-worker` | main | implemented — PDF.js legacy build, per-page normalized text |
| `@wr/pdf-reader`, `@wr/html-reader`, `@wr/annotations`, `@wr/note-editor`, `@wr/shared-ui`, `@wr/indexing-worker` | renderer / worker | placeholders exporting `IMPLEMENTED = false` and a throwing `NotImplementedError`, so an unbuilt criterion cannot appear to pass |

`@wr/shared-types` is the only package both sides import for the IPC contract; it depends on
nothing but zod, so importing it in the renderer pulls in nothing privileged.
`@wr/document-model` is usable on both sides because it avoids `node:crypto` entirely — its
`textHash` is a synchronous FNV-1a variant (`packages/document-model/src/hash.ts`), while
SHA-256 file hashing lives only in the main process (`hashFileOnDisk` in
`packages/zotero-adapter/src/importer.ts`). The two are explicitly not interchangeable.

## Document flow: Zotero to reader panel

### 1. Probe and import

`zotero:probe` calls `ZoteroLocalClient.probe()` (`packages/zotero-adapter/src/client.ts`),
which pings `/connector/ping` and then `/api/users/0/items/top?limit=1` so that "Zotero is not
running" and "the local API is switched off" get different remedies. `zotero:import` runs
`ZoteroImporter.import({ force })` (`packages/zotero-adapter/src/importer.ts`):

1. `listCollections()` — two passes, so a child collection appearing before its parent still
   gets its `parentId`; each key upserted into `external_references`.
2. `listTopItems()`, filtered by `isImportableItem` and `!isTrashed`.
3. Per item: `listChildren(key)` for attachments, then `mapItemToDocument(item, attachments)`.
4. `writeDocument` — the `documents` row and its `external_references` row in one transaction.
   When the recorded `externalVersion` equals `item.data.version` and `force` is false the item
   is `unchanged` and nothing below runs.
5. `tags.setDocumentTags`, `collections.setDocumentCollections`.
6. `importAttachments` — `resolveAttachmentPath`, `probeFile` (size + SHA-256),
   `files.upsertByPath`, an `external_references` row per attachment, and
   `jobs.enqueue(documentId, 'extract-text')` for the first PDF.

The handler then publishes `library:changed` and calls `kickPipeline()`, a fire-and-forget
`pipeline.drain()`, so the import response returns without waiting for PDF parsing.

### 2. Extraction

`ExtractionPipeline.drain()` (`apps/desktop/src/main/pipeline.ts`) loops
`db.jobs.claimNext('extract-text')` until the queue is empty. Drains are serial, and a second
caller joins the in-flight promise rather than starting its own — two drains would race to
claim the same job and double-index it. `runExtraction` requires a primary file with
`mimeType === 'application/pdf'` whose path passes `isAllowedPath`, reads the bytes, calls
`extractPdfText` (`workers/text-extraction/src/index.ts`, PDF.js `legacy` build with
`isEvalSupported: false`), creates a revision keyed on the file's content hash via
`revisions.createIfChanged`, and points the file row at it. Progress is published on
`indexing:progress`; a failure is written to `indexing_jobs.error` rather than swallowed,
because from the UI every extraction failure looks identical — a document that never appears
in search results.

### 3. Indexing

`SearchIndexer.indexExtractedPdf` (`packages/search/src/indexer.ts`) runs one transaction:
`chunkPdfPages` splits each page at 2000 characters with 160 characters of overlap
(`packages/search/src/chunking.ts`), `chunks.replaceForRevision` rewrites the revision's
chunks, `searchIndex.removeChunksForDocument` clears stale entries, and `upsertMany` writes one
`search_entries` row per chunk carrying `location_json` — page index plus character range.
`indexDocumentRecord` adds the document's own title/abstract/authors/tags/collections row.
Triggers on `search_entries` keep the external-content `search_fts` table in step; see
`docs/DATABASE.md`.

### 4. Query

`search:query` calls `SearchService.search` (`packages/search/src/search-service.ts`).
`parseQuery` turns user text into an FTS5 expression in which every term is a quoted literal,
so no user bytes reach FTS5 unquoted. The SQL joins `search_fts` to `search_entries`, ranks
with `bm25(search_fts, 8.0, 1.0, 2.0)` (title 8, body 1, meta 2), and wraps matches in the
private-use code points `U+E000`/`U+E001` so text containing `<mark>` cannot forge a highlight.
Filters by tag, collection, author and date are SQL predicates rather than part of the MATCH
expression, because those attributes live in their own tables.

### 5. Opening in a panel

Each result carries `documentId` and a `DocumentLocation` read back out of the index row, not
recomputed — a hit stays openable even if the reader is not loaded. The renderer calls
`document:openFile`, whose handler returns `toDocumentFileRef(file)`: the file row with `path`
removed and `url: rrfile://<fileId>` substituted
(`packages/database/src/repositories/documents.ts`). The reader loads that URL;
`session.protocol.handle` in `protocol.ts` resolves the ID through the database, re-checks the
path against the allowed roots, and streams the bytes, honouring `Range` headers so PDF.js can
fetch page 200 without reading pages 1–199.

Panel placement is decided in `@wr/workbench`: `panel-targets.ts` returns a plan (current pane,
side, new tab; reuse an already-open document), `commands.ts` dispatches it — panels never call
each other — and `layout.ts` serializes the Dockview blob plus the per-panel state Dockview
does not model. That blob is persisted opaquely through `workspace:saveLayout`.

## Known gaps at this commit

- The renderer shell is still a placeholder (`apps/desktop/src/renderer/App.tsx`); mounting the
  Dockview workbench is criterion M02.
- `extractPdfText` is invoked in-process by `ExtractionPipeline`, not in a separate Electron
  utility process, despite the module docstring in `workers/text-extraction/src/index.ts`.
- `document:getOutline` returns a page list derived from indexed chunks; embedded PDF bookmark
  outlines are explicitly post-milestone.
- `@wr/indexing-worker` is a placeholder; indexing runs inside `ExtractionPipeline` today.
