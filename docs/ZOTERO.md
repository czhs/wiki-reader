# Zotero integration

wiki-reader reads a Zotero 7 library through Zotero's local HTTP API and never touches
`~/Zotero/zotero.sqlite`. Zotero holds a lock on that file while it runs, and writing to it
would corrupt a live library. The client in `packages/zotero-adapter/src/client.ts` issues GET
requests only — there is no code path that constructs any other method.

Import is one-way and idempotent. There is no synchronisation back to Zotero.

## The local API

`ZoteroLocalClient` defaults to `http://127.0.0.1:23119`, served by the running Zotero process.
Zotero's local API always addresses the local library as user 0 (`LOCAL_USER_ID`), so
`apiBase` is `http://127.0.0.1:23119/api/users/0`.

| Request | Method | Used for |
|---|---|---|
| `/connector/ping` | `probe()` | Is the Zotero process listening at all? |
| `/api/users/0/items/top?limit=1` | `probe()` | Is the local API enabled? Also reads `Last-Modified-Version` |
| `/api/users/0/collections` | `listCollections()` | paginated |
| `/api/users/0/tags` | `listTags()` | paginated; exported but not used by the importer (see [Gaps](#gaps)) |
| `/api/users/0/items/top` | `listTopItems()` | paginated; top-level items only |
| `/api/users/0/items/<key>/children` | `listChildren(key)` | paginated; attachments and child notes |
| `/api/users/0/items/<key>` | `getItem(key)` | single item |

Every request runs under an `AbortController` with a 15 s timeout. Pagination walks
`?limit=<pageSize>&start=<n>` until a short page arrives; `pageSize` is capped at 100 because
Zotero caps it there. `Total-Results` is used only as a secondary loop guard — trusting it as
the terminating condition breaks when the library changes mid-walk.

Responses are parsed with the zod schemas in `packages/zotero-adapter/src/wire.ts`. Every object
is `.passthrough()`: Zotero adds fields between versions and per item type, so the schemas are
strict only about the fields the importer actually relies on.

## The 403 precondition

Zotero's local API is served only after the user enables it. Until then every API request
answers **HTTP 403**, which is a user action to fix, not a bug — so `client.ts` gives it its own
error code and a remedy string rather than folding it into a generic HTTP failure:

| Condition | Code | Remedy surfaced to the user |
|---|---|---|
| `fetch` rejects at the socket level | `ZOTERO_UNREACHABLE` | "Start Zotero 7 and leave it running, then retry the import." |
| HTTP 403 | `ZOTERO_API_DISABLED` | `API_DISABLED_REMEDY`: "In Zotero, open Settings → Advanced and enable *Allow other applications on this computer to communicate with Zotero*." |
| any other non-2xx | `ZOTERO_HTTP_ERROR` | none; the status is in the message |

To fix a 403: in Zotero, **Settings → Advanced → Allow other applications on this computer to
communicate with Zotero**. No restart is needed.

`probe()` deliberately never throws. Conflating "not running" with "switched off" sends the user
hunting for the wrong problem, so `probe()` reports both independently:

```ts
{ running, localApiEnabled, libraryVersion, endpoint, message, remedy }
```

A ping that answers with an HTTP error still proves the process is listening, so `running` stays
true in that case. This is what the `zotero:probe` IPC channel returns verbatim.

## Item → document mapping

`packages/zotero-adapter/src/mapping.ts` is pure: wire records in, plain values out. No
filesystem, no database, no network — which is what lets the mapping tests run against recorded
fixtures and still prove the real behaviour.

| Field | Rule |
|---|---|
| `title` | `data.title`, else `data.url`, else `Untitled <itemType> (<key>)`. An untitled record still needs a stable label in the sidebar. |
| `docType` | Driven by **the bytes we actually have**, not the bibliographic item type: a PDF attachment ⇒ `pdf`, else an HTML attachment ⇒ `webpage`, else `webpage` for `webpage`/`blogPost`/`forumPost`, `note` for `note`, otherwise `other`. This decides which reader panel opens the document, so guessing from `itemType` alone would open the wrong one. |
| `authors` | Creators with `creatorType === 'author'`; if there are none, all creators. A single-field creator (`name`, used for institutions) maps to `{ family, literal }` so "European Space Agency" is never rendered as a surname. |
| `abstract` | `data.abstractNote`, trimmed, empty ⇒ `null` |
| `publishedDate` | `meta.parsedDate` (Zotero's own normalisation) preferred, else raw `data.date`. Zotero dates are free text; nothing here invents precision the source lacks. |
| `tags` | `data.tags[].tag`, trimmed, de-duplicated, sorted |
| `collectionKeys` | `data.collections` |
| `zoteroKey`, `zoteroVersion` | `data.key`, `data.version` — carried for provenance, never used as an internal id |

Items whose `itemType` is `attachment`, `note` or `annotation` are not documents
(`isImportableItem`), and trashed items (`data.deleted` true or 1) are skipped
(`isTrashed`).

### External reference storage

A Zotero key is **never** an internal primary key. `ZoteroImporter` writes one
`external_references` row per imported entity with `provider = 'zotero'`:

| `entity_type` | `external_key` | Written in |
|---|---|---|
| `document` | parent item key | `writeDocument`, same transaction as the `documents` row |
| `documentFile` | attachment item key | `importAttachments` |
| `collection` | collection key | `importCollections` |

`external_version` holds `data.version`. The unique index
`(provider, entity_type, external_key)` is the idempotency hinge; see
[Re-import](#re-import-and-idempotence).

## Attachments and file linking

`attachmentHasBytes()` is the gate: a `linked_url` attachment is a bookmark, so it can never
become a file row. The four link modes:

| `linkMode` | Meaning |
|---|---|
| `imported_url`, `imported_file` | a copy inside the Zotero storage directory |
| `linked_file` | a file left where the user put it, referenced by path |
| `linked_url` | a bookmark; no bytes, ever |

`resolveAttachmentPath()` prefers `links.enclosure.href`, the percent-encoded `file://` URL
Zotero reports as the authoritative location — it already accounts for storage layout and for
base-directory relocation. Fallbacks, in order:

1. `linked_file` with a `path` starting `attachments:` ⇒ join the configured
   `linkedBaseDir` with the remainder; `null` when no base directory is configured.
2. `linked_file` with an absolute `path` ⇒ that path.
3. Otherwise `<dataDir>/storage/<key>/<filename>`, the documented storage layout. `null` when
   there is no filename.

`mapFileRole()` then assigns the role that decides what the reader opens:

| Attachment | Role |
|---|---|
| first PDF of the item | `primary` |
| further PDFs | `supplementary` |
| HTML alongside a PDF | `original-snapshot` (kept for provenance) |
| HTML with no PDF | `primary` |
| anything else | `supplementary` |

For each attachment with bytes, `importAttachments` probes the file with `hashFileOnDisk` —
`stat()` for the size and a streamed SHA-256, because attachments can be hundreds of megabytes —
then `files.upsertByPath`. Two failure modes are counted and warned about rather than dropped,
because a silently skipped attachment is indistinguishable from one that never existed:

- `filesMissing` + `attachment <key>: no resolvable path` — the path could not be constructed.
- `filesMissing` + `attachment <key>: file missing on disk` — commonly an unsynced file.

The first PDF also enqueues an `extract-text` job (`extractionJobsQueued`), which the
`zotero:import` handler then drains.

## Re-import and idempotence

Running the import twice must update the same rows, not create a second copy of the library.

1. `writeDocument` looks the item key up in `external_references` **before** writing anything.
2. If a reference exists, `force` is false and `reference.externalVersion === item.data.version`,
   the item is `unchanged` and nothing below it runs — no tag rewrite, no collection rewrite, no
   attachment probing. This is what keeps a refresh cheap.
3. If the reference exists but its document was deleted by hand, the code falls through and
   recreates rather than failing.
4. The `documents` row and its `external_references` row are written in one transaction. A
   document without its reference would be re-imported as a duplicate on the next run.
5. Attachments are keyed by `document_files.path`, which is UNIQUE, so the same PDF on disk is
   one row however many times it is seen.
6. Collections are imported in two passes so a child appearing before its parent still gets its
   `parentId`.

`force: true` re-reads every item even when the version is unchanged, which is what makes a
repair run possible after a mapping bug is fixed.

One malformed item does not abort the library import: `import()` catches per item, pushes
`item <key>: <message>` onto `summary.warnings`, logs `zotero.import.item_failed`, and continues.

## Fixtures

`packages/zotero-adapter/test/fixtures/` holds records captured from a live Zotero 7.0.32 local
API, so mapping and duplicate-prevention tests run against the real wire format rather than an
invented one. Bibliographic metadata only: no file bytes, no attachment contents, no
credentials, and the library user id scrubbed to `000000`.

| File | Contents |
|---|---|
| `items-top.json` | 8 top-level items: 3 `journalArticle`, 3 `preprint`, 1 `webpage`, 1 `forumPost` |
| `items-children.json` | 13 children: 12 attachments (7 `application/pdf`, 5 `text/html`, 11 with an `enclosure` link, 1 `linked_url`) and 1 note |
| `collections.json` | 8 collections, 6 of them nested under a parent |
| `tags.json` | 15 tags |
| `README.md` | provenance and the `curl` commands to re-record |

`test/fixtures.ts` parses each file through the same schemas `ZoteroLocalClient` uses, so drift
between the recorded shape and the parser fails the tests instead of passing silently.
`test/fake-api.ts` serves the fixtures over the real Zotero URL shapes as a `FetchLike`, which
means the import tests drive the actual client — pagination, header handling, schema parsing and
error mapping — rather than stubbing it out. `FakeApiOptions` can force a status (to exercise
403), reject at the socket level (`offline`), or substitute the item list to simulate an
upstream edit between imports.

## Gaps

- **`linkedBaseDir` is never configured.** `ZoteroImporterOptions.linkedBaseDir` is threaded
  through `mapping.resolveAttachmentPath`, but `createServices()` in
  `apps/desktop/src/main/services.ts` does not set it. A `linked_file` attachment whose Zotero
  path uses the `attachments:` base-directory prefix therefore resolves to `null` and is counted
  as missing — unless its `enclosure` link is present, which is the common case.
- **Linked files outside the Zotero data directory cannot be opened.** `createServices()` builds
  the allowed roots from the Zotero data directory alone. A `linked_file` at, say,
  `~/Papers/foo.pdf` will import into `document_files`, but `rrfile://` refuses it with 403 and
  `ExtractionPipeline.runExtraction` throws before reading it. Adding a configurable extra root
  is the fix; `extraRoots` already exists for tests.
- **`listTags()` is unused.** Tags are derived from each item's own `data.tags`, so the
  library-level `/tags` endpoint is never called. `summary.tagsImported` counts tag assignments
  across documents, not distinct tags.
- **Child notes are not imported.** `listChildren` returns notes as well as attachments, but only
  `itemType === 'attachment'` children are consumed.
- **Deletions do not propagate.** An item removed or trashed in Zotero after a successful import
  is skipped on the next run; its `documents` row is left in place.
