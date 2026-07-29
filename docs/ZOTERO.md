# Zotero

Read-only, over the local HTTP API. **Never open `~/Zotero/zotero.sqlite`** — Zotero holds a
lock on it, the schema is undocumented, and a write would damage the user's library.

`packages/zotero-adapter/src/mapping.ts` is the authoritative field mapping; it is typed and
covered by `T02`, so it is not restated here.

## The local API

`http://127.0.0.1:23119/api/users/0/...`. No API key.

The port is a Zotero preference, so `WR_ZOTERO_ENDPOINT` can name another one. **Loopback
only** — `resolveZoteroEndpoint` refuses anything else and the default stands, because this
variable names where the library is *sent*.

**403 means a user action, not a bug.** "Allow other applications on this computer to
communicate with Zotero" is off in Settings → Advanced. This blocked the project at bootstrap.
Detect it, say so usefully, and keep working — the mapping tests run against recorded fixtures
so they are never blocked by it.

Fixtures in `packages/zotero-adapter/test/fixtures/` are recorded from real responses. Extend
them by recording; never invent a shape.

## Mapping

Parent item → document, attachment → document file, collection → collection, tags → tags.
Zotero keys live in `external_references` and are never primary internal ids — the library is
someone else's namespace and it can change.

Import is one-way. Re-import is idempotent: content hashes plus external references detect
what actually changed, so refreshing does not duplicate (`T03`).

Import is scoped to a **named collection** (`W12`), not the whole library, and importing a
second collection is additive.

Scoping also decides what a removal means (`B01`). A document taken out of the library is
tombstoned in `external_references`, and a whole-library run — `force` included — passes it
over. A run **scoped to a collection holding it** lifts the tombstone and writes it back:
naming the collection is the researcher asking for what is in it. No blacklist to maintain,
and no routine sync that undoes a morning's curation.

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
