# Product specification

Authoritative. Change only on explicit user authorization, and record the change in
`state/DECISIONS.md`.

## Goal

A local-first desktop reader for a research wiki. Read your sources, annotate them, link them
together, and see the connections.

Successor to Field Station's in-browser annotator (`assets/js/annotate.js` over vendored
Hypothesis anchor libraries). That version was vanilla-JS with no framework and no CDN because
it lived inside a static Jekyll site; a desktop app has no such constraint. The purpose is
unchanged: reading and linking accumulate into understanding instead of a pile of PDFs.

Users can: import from a Zotero collection · read PDFs, saved web pages and markdown in
draggable tabs and split panes · highlight in six colours and comment · link highlights,
notes and documents · cross-link with `[[wikilinks]]` and `#tags` · see it all as a graph ·
search everything and jump to the source location · restore layout and reading position.

Nothing leaves the machine.

## Presentation fidelity

**Documents render in their original form.** A PDF renders as the PDF, through PDF.js, with a
real text layer. A saved web page renders as the page — its own HTML, images and CSS — in a
sandboxed script-disabled iframe. Zotero's snapshots are faithful, and that fidelity is why
the snapshot was taken instead of a bookmark.

Extracted text, markdown conversions, and Readability's cleaned view exist for search,
anchoring and agent reading. They are **never** the reading view and never a silent fallback
when rendering fails — fail loudly instead. Where a derived view is offered it is explicit,
labelled and reversible, with the original one action away.

A user who can't tell which representation they're reading is being misled about the source.

## Document types

| Type | Rendering |
|---|---|
| **PDF** | PDF.js on the actual file, selectable text layer. Never image-only |
| **Web snapshot** | The saved page with its own resources, sandboxed, scripts off |
| **Markdown** | Escape-first renderer; `[[wikilinks]]` and `#tags` live |

Markdown is first-class because much of the corpus *is* markdown — wiki pages, research
questions, journals, notes. Markdown extracted *from* a PDF is a different thing: indexed and
searchable, but never the reading view for a document whose original exists.

Anchors should resolve across representations of one source, since both derive from the same
normalized text.

## Stack

Electron · React · TypeScript strict · electron-vite · pnpm workspaces · Dockview · PDF.js ·
react-pdf-highlighter-extended · Mozilla Readability · Tiptap · better-sqlite3 + FTS5 ·
Zotero local API.

**Graph: Cytoscape.js** (MIT, zero deps) — chosen over `force-graph` because its model runs
headless in Node, so one traversal implementation serves both main-process queries and the
rendered view. Force-directed by default; a hierarchical layout (`cytoscape-dagre`, MIT) for
citation chains.

**Markdown + wikilinks: unified/remark** — `remark-parse`, `remark-frontmatter`,
`unist-util-visit`, `github-slugger`. Matching Foam keeps the corpus readable in Foam and
Obsidian.

No OpenSumi or Theia. No semantic/vector search yet, but design search so `sqlite-vec` can be
added later.

## Process boundaries

**Main** owns: filesystem, SQLite, Zotero, ingestion, extraction, indexing, settings.
**Renderer** owns: React UI, Dockview, document presentation, selection, annotation rendering,
notes, search UI.

Required: `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer, one narrow
typed preload API, zod-validated IPC payloads. Never expose raw filesystem, database, shell or
arbitrary IPC to the renderer. Archived pages are untrusted: no scripts, no Node, no navigation.

## Domain model

Stable internal IDs independent of filesystem paths and Zotero internals. Entities:
`Document`, `DocumentFile`, `DocumentRevision`, `DocumentChunk`, `Annotation`,
`AnnotationAnchor`, `Note`, `Link`, `Collection`, `Tag`, `ReadingPosition`, `WorkspaceLayout`,
`ExternalReference`.

Zotero item keys are external references, never primary IDs. A document may have several files
or revisions.

## Reader abstraction

```ts
interface DocumentAdapter {
  render(...): unknown;
  extractText(...): Promise<ExtractedDocument>;
  createAnchor(selection: ReaderSelection): AnnotationAnchor;
  resolveAnchor(anchor: AnnotationAnchor): ResolvedLocation | null;
  revealLocation(location: DocumentLocation): Promise<void>;
  getSearchContext(location: DocumentLocation): Promise<SearchContext>;
}
```

Every document type implements it. Code outside the reader packages must not depend on
PDF.js-specific or DOM-specific coordinates.

## Anchoring

W3C Web Annotation model: `TextQuoteSelector` (exact, prefix, suffix) and
`TextPositionSelector` (start, end), plus content hash and revision. PDF anchors additionally
carry page index and normalized rectangles.

Never persist only viewport pixel coordinates. Never use DOM paths or CSS selectors as the
only anchor. Normalize text consistently before computing offsets.

## Highlights

Select text → highlight in the current colour. Click a highlight → popover to edit the
comment, change colour, delete, copy its internal link, or link it to another highlight or
document. Identical across all three document types.

Six colours, carried over from Field Station so existing highlights import losslessly:
`default`, `tan`, `spruce`, `ochre`, `clay`, `signal`. Stored by name, never as hex.

A highlight carrying a link shows a badge that jumps to the target, loading it into the other
pane if needed. Highlights whose anchors stop resolving are retained, marked orphaned, and
listed — never silently deleted.

## Notes and links

Tiptap. Plain notes, document-linked, highlight-linked, note-to-note, embedded excerpts,
backlinks. Nodes/marks: `DocumentLink`, `AnnotationLink`, `NoteLink`, `EmbeddedExcerpt`. An
embedded excerpt resolves its annotation by ID rather than duplicating text.

Every relationship is a typed directed edge with source, target, type, timestamps, optional
locations and label, and whether it was created manually or derived:

```ts
type LinkType =
  | "document-cites-document" | "note-references-document" | "note-references-note"
  | "note-references-annotation" | "annotation-references-annotation"
  | "annotation-belongs-to-document" | "excerpt-derived-from-annotation"
  | "child-of" | "related-to" | string;
```

No untyped backlink table. Index `links` on `(source_type, source_id)`, `(target_type,
target_id)`, `type`, and the type-prefixed pairs. Link queries must never load the whole graph
into the renderer.

Internal links are `document://<id>`, `annotation://<id>`, `note://<id>` — application links,
not public URLs.

### Wikilinks

`[[slug]]`, `[[slug|alias]]`, `[[slug#Section]]`, and `#tag`, following Foam so the corpus
stays readable elsewhere. Slugs via `github-slugger`.

Wikilinks are **derived** links, not a second system: indexing turns each one into a `Link`
with `origin: "derived"`, participating in references, navigation and the graph like any
other. Re-indexing replaces a document's derived links wholesale — and must never delete a
manually created one.

Parse from the markdown AST, never a regex: `[[…]]` in a code fence is code, and `#` in a URL
is not a tag. A wrong edge is worse than a missing one because it looks like a finding.

An unresolved `[[slug]]` is not an error — it's a listed wanted page, and a research prompt.
Ambiguous slugs are reported with candidates, never guessed.

## Database

SQLite via better-sqlite3, migrations from the start. Tables: `documents`, `document_files`,
`document_revisions`, `document_chunks`, `annotations`, `annotation_anchors`, `notes`,
`links`, `collections`, `document_collections`, `tags`, `document_tags`, `reading_positions`,
`workspace_layouts`, `external_references`, `indexing_jobs`.

Foreign keys on; transactions around multi-record operations; timestamps; explicit migrations;
repositories rather than SQL in UI code. Files live outside SQLite.

The database indexes the corpus; it is not the corpus. Markdown documents are files on disk,
and annotations round-trip to files so they survive a rebuild and can be committed to git.
Where a file and a row disagree, the file wins.

## Search

FTS5 over title, authors, abstract, PDF text, article text, markdown body, annotation text and
comments, notes, tags, collections. Chunk structurally — PDF by page or section, HTML and
markdown by heading, notes by block.

Every result keeps enough location to open the document and reveal the match. Support phrase
and prefix search, filters by type/tag/collection/author/date, snippets, highlighted terms,
keyboard navigation. No embeddings initially.

## Zotero

Never modify `zotero.sqlite`. Read through the local API only. Map parent item → document
reference, attachment → file reference, collection → collection, tags → tags, metadata →
metadata.

Import is scoped to **named collections**, not the whole library — a library is broader than
any one line of research. Additional collections import additively. One-way import/refresh; no
bidirectional sync. Detect whether Zotero is running and say so usefully. Use file hashes and
external references to avoid duplicating on refresh.

## Workspace

VS Code-style shell: activity bar, library sidebar, Dockview main area, annotation/notes
sidebar, bottom panel, status bar. Panels: `LibraryPanel`, `PDFReaderPanel`,
`ArticleReaderPanel`, `MarkdownReaderPanel`, `SearchResultsPanel`, `AnnotationListPanel`,
`NoteEditorPanel`, `DocumentOutlinePanel`, `BacklinksPanel`, `GraphPanel`.

Multiple documents, horizontal and vertical splits, tab dragging, restored layout, search
results beside the current document, linked annotations in another pane.

Panels never manipulate each other. Everything goes through a command registry with
context-aware keybindings (`readerFocus`, `linkUnderCursor`, `annotationSelected`, …), a
command palette, and editor-style navigation history.

Navigation commands — `goToTarget` (F12), `peekTarget` (Alt+F12), `goToParent`,
`findAllReferences` (Shift+F12), `findAllLinksOfType`, `findIncomingLinks`,
`findOutgoingLinks`, `goBack`/`goForward`, `goToNextReference`/`goToPreviousReference`,
`copyInternalLink`, `revealInLibrary`, `openToSide`, `openLinkGraph` — behave consistently
across every reader, notes, annotations, search results and the graph. Incoming and outgoing
links stay distinguishable; don't merge them into an ambiguous backlink list.

*(Implemented and tested in milestone 1 — `packages/workbench` and criteria `L01`–`L10` are
the detailed record.)*

## Graph

Documents, notes, annotations and research questions as nodes; typed links and derived
wikilinks as edges. Filter by link type, project, tag, entity type. Select a node to reveal
it; select an edge for `findAllLinksOfType`.

Cytoscape's model runs headless in main for neighbourhood queries and traversal; the renderer
visualizes only the bounded subgraph main selects. Open on a focus node with a depth bound. A
whole-corpus view is an explicit command with a node cap that reports what it elided — never
a silent truncation.

## Agents — later, not in scope yet

A **librarian** sweeps the corpus, connects sources to research questions with cited reasoning,
logs contradictions, and surfaces open threads. A **reviewer** critiques a research journal
Socratically. Both propose; neither mutates silently.

Two hard constraints when this is built:

- **Ground truth is never written.** Source text, ingested pages and imported papers are
  read-only; agents write only inside their own workspace. Enforce this at the tool boundary —
  refuse and log writes outside it — not by asking the agent nicely.
- **Agents are the only exception to local-first.** Off by default, the user's own credentials
  or a local endpoint, a disclosure of what would be sent before the first run. With agents
  disabled nothing in the app touches the network. `README.md` must say this plainly.

## Implementation

Small testable modules. Strict TypeScript, no `any`. No pseudocode left in place, no fake data
paths where real integration is feasible. Structured errors and logging around ingestion and
indexing; never swallow failures. No giant React components, no global mutable state. No
premature design system. Don't copy AGPL code from Zotero or SingleFile; record licensing in
`THIRD_PARTY_NOTICES.md`.

Required tests: migrations · Zotero mapping · duplicate-import prevention · PDF anchor
round-trip · HTML and markdown normalization · text-quote resolution · anchor resolution
across representations · search indexing · result location mapping · internal link parsing ·
wikilink parsing and slug resolution · derived re-indexing that preserves manual links ·
layout serialization.

## Priorities

1. Documents render as themselves — never a derived substitute
2. Stable annotation anchors
3. Local-first
4. Secure handling of archived web content
5. Search results navigate to real source locations
6. Extensible to EPUB and semantic search later
7. Maintainable by a small team

The corpus must stay useful with this application uninstalled: markdown files, wikilinks, and
annotation sidecars in a git repository. Any design that makes the wiki hostage to the
database is wrong.
