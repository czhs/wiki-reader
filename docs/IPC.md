# IPC reference

Every request from the renderer to the main process travels on one Electron channel,
`wr:invoke`, and every event travels back on one channel, `wr:event`. The application-level
channel name rides inside the envelope. This is the complete surface; there is no other path.

- Contract: `packages/shared-types/src/ipc.ts` (`IPC_CHANNELS`, `IPC_TOPICS`)
- Bridge: `apps/desktop/src/preload/index.ts`
- Transport, validation, dispatch: `apps/desktop/src/main/router.ts`
- Handler bodies: `apps/desktop/src/main/handlers.ts`

## Calling convention

```ts
const result = await window.rr.invoke('library:getDocument', { documentId });
if (result.ok) { use(result.value.item); } else { show(result.error); }
```

`RendererBridge` (bottom of `packages/shared-types/src/ipc.ts`) types `invoke<K>` so the
request and response are correlated with the channel key. The preload wraps the call as
`ipcRenderer.invoke('wr:invoke', { channel, request })`.

In the main process, `dispatch()` validates in this order: envelope shape → channel is an own
key of `IPC_CHANNELS` → `contract.request.safeParse(request ?? {})` → handler. Because parsing
happens before dispatch, handlers receive requests with all schema defaults already applied.
`request` may be omitted entirely for channels whose schema is `z.object({})`.

## Error envelope

```ts
type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

interface IpcError {
  code: IpcErrorCode;
  message: string;
  details?: Record<string, unknown>;  // safe structured context, never a stack trace
  remedy?: string;                    // a concrete action the user can take
}
```

The router never rejects. `toIpcError()` in `router.ts` maps thrown values:

| Thrown | Result |
|---|---|
| `HandlerError` (`handlers.ts`) | its own `code`, `message`, optional `details` / `remedy` |
| `ZoteroError` (`packages/zotero-adapter/src/client.ts`) | its own `code` and `remedy` |
| `ZodError` | `INVALID_REQUEST`, `details.issues` listing `path: message` per failure |
| `Error` whose message contains `SQLITE_` | `DATABASE_ERROR`, "The database rejected the operation." |
| anything else | `INTERNAL`, "The operation failed." — the real message may name a path or a SQL fragment, so it goes to the log instead |

### Error codes

| Code | Raised by |
|---|---|
| `INVALID_REQUEST` | unknown channel, malformed envelope, or failed zod validation |
| `NOT_FOUND` | the `notFound()` helper in `handlers.ts`, for a missing document / file / annotation / note / link |
| `CONFLICT` | declared; not raised at this commit |
| `ZOTERO_UNREACHABLE` | `ZoteroLocalClient.request` when `fetch` throws — Zotero is not running |
| `ZOTERO_API_DISABLED` | HTTP 403 from the local API — see `docs/ZOTERO.md` |
| `ZOTERO_HTTP_ERROR` | any other non-2xx from the local API |
| `FILE_MISSING`, `FILE_FORBIDDEN` | declared; the equivalent refusals surface as `rrfile://` HTTP statuses rather than as IPC errors |
| `EXTRACTION_FAILED` | declared; extraction failures are recorded in `indexing_jobs.error` and reported over `indexing:progress` instead |
| `DATABASE_ERROR` | SQLite constraint and similar failures |
| `UNSUPPORTED` | declared; not raised at this commit |
| `INTERNAL` | anything unmapped |

## Channels

### Zotero

| Channel | Request | Response | Handler |
|---|---|---|---|
| `zotero:probe` | `{}` | `{ running, localApiEnabled, libraryVersion: number\|null, endpoint, message, remedy: string\|null }` | Calls `ZoteroLocalClient.probe()` and logs the outcome. Never throws — a disabled API is reported, not raised. |
| `zotero:import` | `{ force?: boolean = false }` | `ImportSummary` (see below) | Runs `ZoteroImporter.import({ force })`, publishes `library:changed` with `reason: 'import'`, then kicks a fire-and-forget `pipeline.drain()` so the response returns without waiting for PDF parsing. |

`ImportSummary` fields, all non-negative integers except the last two: `itemsSeen`,
`documentsCreated`, `documentsUpdated`, `documentsUnchanged`, `filesLinked`, `filesMissing`,
`collectionsImported`, `tagsImported`, `extractionJobsQueued`, `durationMs`,
`warnings: string[]`.

### Library

| Channel | Request | Response | Handler |
|---|---|---|---|
| `library:listDocuments` | `{ collectionId?, tag?, query?, limit = 200 (≤1000), offset = 0 }` | `{ items: LibraryItem[], total }` | `db.library.list(...)`. `query` is a case-insensitive `LIKE` on the title with wildcards escaped; it is *not* full-text search. |
| `library:getDocument` | `{ documentId }` | `{ item: LibraryItem }` | `db.library.get`; `NOT_FOUND` when absent. |
| `library:listCollections` | `{}` | `{ collections: Collection[] }` | `db.collections.list()`, ordered by name. |
| `library:listTags` | `{}` | `{ tags: Tag[] }` | `db.tags.list()`, ordered by name. |

`LibraryItem` = `{ document, files: DocumentFileRef[], tags: string[], collectionIds,
annotationCount, hasExtractedText }`. Every `DocumentFileRef` carries `url: rrfile://<fileId>`
and no `path`.

### Documents

| Channel | Request | Response | Handler |
|---|---|---|---|
| `document:openFile` | `{ fileId }` | `{ file: DocumentFileRef, document }` | Looks up the file and its document; returns `toDocumentFileRef(file)`, which is what strips the filesystem path and substitutes the `rrfile://` URL. |
| `document:getReadingPosition` | `{ documentId }` | `{ position: ReadingPosition \| null }` | `db.readingPositions.get`. |
| `document:setReadingPosition` | `{ documentId, location: DocumentLocation }` | `{ position }` | Verifies the document exists, then upserts the single row for it. |
| `document:getOutline` | `{ documentId }` | `{ outline: { title, level, location }[] }` | Builds a page list from indexed `pdf-page` chunks. An un-extracted document correctly returns an empty outline; embedded PDF bookmark outlines are post-milestone. |
| `document:requestExtraction` | `{ documentId }` | `{ queued: boolean }` | `pipeline.enqueue(documentId)` then a fire-and-forget drain. `queued` is false when a job for that document was already outstanding. |

### Annotations

| Channel | Request | Response | Handler |
|---|---|---|---|
| `annotation:create` | `{ documentId, kind, color, selectedText (≥1 char), comment = null, anchor: AnnotationAnchor }` | `{ annotation: AnnotationWithAnchor }` | Resolves the document's current revision, writes annotation + anchor + the `annotation-belongs-to-document` edge in one transaction, indexes it immediately so a fresh highlight is findable at once, publishes `library:changed` with `reason: 'annotation'`. |
| `annotation:listByDocument` | `{ documentId }` | `{ annotations: AnnotationWithAnchor[] }` | Live annotations joined to their anchors, ordered by page then creation. |
| `annotation:get` | `{ annotationId }` | `{ annotation: AnnotationWithAnchor }` | `NOT_FOUND` when absent. |
| `annotation:update` | `{ annotationId, color?, comment? }` | `{ annotation: Annotation }` | Patches colour and/or comment and re-indexes. Returns the annotation without its anchor — the anchor is immutable. |
| `annotation:delete` | `{ annotationId }` | `{ deleted: boolean }` | Soft-deletes (`deleted_at`), removes the search entry, publishes `library:changed` with `reason: 'delete'`. |

### Notes

| Channel | Request | Response | Handler |
|---|---|---|---|
| `note:create` | `{ title, contentJson: unknown, contentText, attachToAnnotationId?, attachToDocumentId? }` | `{ note, links: Link[] }` | Note and its `note-references-annotation` / `note-references-document` edges are written in one transaction — a note claiming attachment without an edge would be unreachable. Indexes the note, publishes `library:changed` with `reason: 'note'`. |
| `note:get` | `{ noteId }` | `{ note }` | `NOT_FOUND` when absent. |
| `note:update` | `{ noteId, title?, contentJson?, contentText? }` | `{ note }` | Patches and re-indexes. |
| `note:list` | `{ limit = 200 (≤1000), offset = 0 }` | `{ notes, total }` | Live notes ordered by `updatedAt` descending. |
| `note:listForAnnotation` | `{ annotationId }` | `{ notes }` | Joins through `note-references-annotation` edges. |

`contentJson` is Tiptap/ProseMirror JSON, stored verbatim and opaque to the main process.
`contentText` is the flattened form the caller keeps in sync; it is what gets indexed.

### Links

All relationships are typed directed edges in `links`. There is no untyped backlink table.

| Channel | Request | Response | Handler |
|---|---|---|---|
| `link:create` | `{ type, sourceType, sourceId, targetType, targetId, sourceLocation?, targetLocation?, label?, ordinal?, origin = 'manual', generator?, metadata? }` | `{ link }` | `db.links.create`, which returns the existing edge when `(type, source, target)` already exists — linking two entities the same way twice is one fact, not two. |
| `link:delete` | `{ linkId }` | `{ deleted: boolean }` | Hard delete. The handler throws `NOT_FOUND` when nothing was removed, so a success always carries `true`. |
| `link:findReferences` | `{ entityType, entityId, direction = 'both', limit = 500 (≤2000) }` | `{ links: ResolvedLink[] }` | Every edge touching the entity (criterion L03). Each result is resolved against the *other* endpoint. |
| `link:findByType` | `{ type, documentId?, collectionId?, sourceType?, targetType?, direction = 'both', origin?, generator?, createdAfter?, createdBefore?, tag?, limit = 500 }` | `{ links: ResolvedLink[] }` | Every edge of one semantic type, narrowed (criterion L04). Scope filters match endpoints that are the document itself or an annotation or chunk belonging to it. Without an anchor entity, results are read source → target. |
| `link:getParent` | `{ entityType, entityId }` | `{ parent: { entityType, entityId, title, documentId, location } \| null }` | `EntityResolver.parentOf`. An explicit `child-of` edge wins; otherwise containment implied by the row is used — an annotation's parent is its document *opened at the annotation's own location*, a chunk's is its document, a document's is its first collection. |
| `link:peek` | `{ entityType, entityId }` | `{ title, entityType, documentTitle, documentId, excerpt, locationLabel, location, parentLabel, incomingCount, outgoingCount, broken }` | Everything the peek widget needs in one round trip. An entity that no longer resolves still answers, with `broken: true` and the id as the title — the widget must be able to say "this link is dead" rather than fail to open. |

`ResolvedLink` extends `Link` with `direction`, `otherTitle`, `otherType`, `otherDocumentId`,
`excerpt`, `broken`, and `otherLocation`. `locationLabel` is rendered by `locationLabel()` in
`handlers.ts`: `p. <n>` for PDF, the section path for HTML, `block <n>` for notes.

`heading`, `figure`, `citation` and `excerpt` are valid `LinkableEntityType` values but are not
persisted as first-class rows in milestone 1, so `link:peek` on one legitimately returns
`broken: true`.

### Search

| Channel | Request | Response | Handler |
|---|---|---|---|
| `search:query` | `{ query, filters = {}, limit = 100 (≤500), offset = 0 }` | `{ results: SearchResult[], total, normalizedQuery, durationMs }` | `SearchService.search`. `normalizedQuery` is the FTS5 expression actually executed, for the status bar and for debugging. An empty or operator-only query returns nothing rather than everything. |
| `search:status` | `{}` | `{ queued, running, failed, indexedDocuments, totalDocuments }` | Job counts from `indexing_jobs` plus documents having at least one indexed chunk over live document count. |

`SearchFilters`: `entityTypes`, `tags`, `collectionIds`, `authors`, `publishedAfter`,
`publishedBefore`, `documentIds` — all optional arrays/strings.

`SearchResult`: `entityType`, `entityId`, `documentId`, `title`, `snippet` (matches wrapped in
`U+E000` / `U+E001`), `plainSnippet`, `location`, `score` (bm25 sign-flipped so larger is
better).

### Workspace

| Channel | Request | Response | Handler |
|---|---|---|---|
| `workspace:loadLayout` | `{ name = 'default' }` | `{ layout: WorkspaceLayout \| null }` | `db.layouts.load(name)`. |
| `workspace:saveLayout` | `{ name = 'default', layout: unknown, panelState = {} }` | `{ saved: true }` | Upserts by name. The Dockview blob is opaque to the main process: serialized by the renderer, stored verbatim, handed back unchanged. `panelState` carries what Dockview does not model — open document, scroll position, search query. |

## Main → renderer events

Published by `Router.publish` in `router.ts`, which parses the payload against `IPC_TOPICS`
first and drops it if invalid. Delivery targets are recomputed at publish time from
`BrowserWindow.getAllWindows()`, so a window opened after startup still receives events and a
destroyed one is skipped.

| Topic | Payload | Emitted from |
|---|---|---|
| `indexing:progress` | `{ documentId, stage: 'extract'\|'chunk'\|'index'\|'done'\|'error', processed, total, message? }` | `ExtractionPipeline`'s `onProgress`, wired in `services.ts`. `stage: 'error'` carries the failure text. |
| `library:changed` | `{ reason: 'import'\|'annotation'\|'note'\|'delete', documentIds }` | `handlers.ts` after import, annotation create/delete, and note create. `documentIds` is empty for library-wide changes. |
| `zotero:importProgress` | `{ phase: 'collections'\|'items'\|'attachments'\|'done', processed, total }` | `ZoteroImporter`'s `onProgress`, wired in `services.ts`. |

Subscribe with `window.rr.subscribe(topic, handler)`, which returns an unsubscribe function.

## Adding a channel

1. Add the entry to `IPC_CHANNELS` in `packages/shared-types/src/ipc.ts` with both schemas.
2. Add the matching function to `createHandlers()` in `apps/desktop/src/main/handlers.ts` — the
   `Handlers` mapped type makes a missing one a compile error.
3. Nothing else. Do not add an `ipcMain.handle` anywhere; `check_ipc_validation()` in
   `scripts/verify_completion.py` fails the build if one appears outside `router.ts`.
