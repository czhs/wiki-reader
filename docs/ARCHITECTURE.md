# Architecture

## Process model

**Main** owns everything stateful: filesystem, SQLite, Zotero, ingestion, extraction,
indexing, settings. **Renderer** owns presentation only — React, Dockview, document rendering,
selection, annotation UI, search UI.

The renderer is sandboxed with no Node, holds no filesystem path, and reaches main through one
validated router. It gets file bytes over `rrfile://`, which resolves an internal file id
through the database.

PDFs parse in the renderer (sandboxed, `isEvalSupported: false`) for display, and a second
independent parse runs in main for indexing. A page that throws during indexing is recorded
empty rather than aborting the document.

## Packages

`shared-types` (IPC contracts, zod) and `document-model` (entities, ids, `DocumentAdapter`,
anchors) are shared. `database`, `zotero-adapter`, `search` and `graph` are **main only** —
enforced twice, by eslint and by the verifier.

Readers (`pdf-reader`, `html-reader`, `markdown-reader`), `workbench`, `annotations`,
`note-editor` and `shared-ui` are renderer-side. Only the reader packages touch format-specific
coordinates; everything else goes through `DocumentAdapter`.

## Document flow

Zotero local API → importer maps item + attachment to `documents` / `document_files` /
`external_references` → extraction pipeline reads bytes, extracts text, writes
`document_chunks` → indexer populates FTS5.

Opening a document: renderer asks the router for metadata, gets an `rrfile://` URL for the
file id, and the matching adapter renders it. Highlights anchor on text evidence — quote plus
prefix/suffix plus hashes — so they survive re-render and re-save.

## Known gaps

- `extractPdfText` runs in-process inside `ExtractionPipeline`, not in a separate utility
  process, despite the docstring in `workers/text-extraction`.
- `@wr/indexing-worker` is a placeholder; indexing runs inside `ExtractionPipeline`.
- `document:getOutline` derives a page list from indexed chunks; embedded PDF bookmark outlines
  are not read.
