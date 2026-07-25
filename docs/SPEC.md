# Frozen product specification

This document is the authoritative specification for wiki-reader. It is frozen: change it
only on explicit user authorization, and record any change in `state/DECISIONS.md`.

---

## Product goal

A local-first desktop research reading application that imports documents from Zotero and
provides a VS Code-style reading workspace. Users can:

- Browse their Zotero library
- Open PDFs and archived webpage snapshots
- Arrange documents in draggable tabs and split panes
- Highlight PDF and HTML text
- Attach notes to highlights
- Link highlights, notes, and documents together
- Search across PDFs, archived articles, annotations, and notes
- Restore their previous workspace layout and reading positions

The application should feel like a combination of Zotero, VS Code, and a local knowledge base.

## Required stack

Electron, React, TypeScript strict mode, electron-vite, pnpm workspaces, Dockview (tabs,
splits, floating panes, layout persistence), PDF.js (rendering + text extraction),
react-pdf-highlighter-extended (PDF annotations), Mozilla Readability (cleaned webpage
rendering), Tiptap (notes), SQLite via better-sqlite3, SQLite FTS5, Zotero local API.

Do not use OpenSumi or Theia. Dockview provides the workspace shell.

Do not add semantic or vector search yet. Design the search interfaces so `sqlite-vec` can be
added later.

## Process and security boundaries

The Electron **main** process owns: filesystem access, SQLite access, Zotero API
communication, document ingestion, text extraction jobs, search indexing, application
settings.

The **renderer** owns: React UI, Dockview workspace, PDF and HTML presentation, selection
interfaces, annotation rendering, notes UI, search UI.

Required: `contextIsolation: true`, `nodeIntegration: false`, renderer sandboxing, a narrow
typed preload API, IPC request/response schemas, runtime validation for IPC payloads.

Never expose raw filesystem, database, shell, or arbitrary IPC access to the renderer.

Archived websites are untrusted content. Scripts must not execute. They must not have Node
access or unrestricted navigation.

## Core domain model

Stable internal IDs independent of filesystem paths and Zotero database internals.

Entities: `Document`, `DocumentFile`, `DocumentRevision`, `DocumentChunk`, `Annotation`,
`AnnotationAnchor`, `Note`, `Link`, `Collection`, `Tag`, `ReadingPosition`,
`WorkspaceLayout`, `ExternalReference`.

Zotero item keys are external references, never primary internal IDs. A document may have
multiple files or revisions (bibliographic item + PDF attachment; blog post + archived HTML
snapshot; revised version of a previously imported PDF).

## Shared reader abstraction

Source-independent interface:

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

PDF and HTML implementations must use the same higher-level annotation and navigation APIs.
Application code outside the reader packages must not depend directly on PDF.js-specific or
DOM-specific coordinates.

## PDF annotations

Anchors must include: page index, normalized bounding rectangles, selected text, text before
the selection, text after the selection, page text hash, document revision or content hash.
Do not persist only viewport pixel coordinates.

The application must render saved highlights, scroll to a highlight, open a highlight in
another split, attach a note to a highlight, and copy a stable internal link.

Internal links: `annotation://<id>`, `document://<id>`, `note://<id>`. Internal application
links, not public URLs.

## HTML annotations

Default archived webpage view uses Mozilla Readability. Also support an original snapshot mode
in a sandboxed, script-disabled iframe for pages where the cleaned view removes important
formatting.

Robust text anchoring based on the W3C Web Annotation model: `TextQuoteSelector` (exact,
prefix, suffix) and `TextPositionSelector` (start, end). Also store snapshot content hash,
reader-mode version, optional DOM range fallback.

Do not use DOM paths or CSS selectors as the only anchor. Normalize extracted HTML text
consistently before calculating offsets.

## Notes and links

Tiptap for note editing. Support plain notes, document-linked notes, highlight-linked notes,
links between notes, embedded highlight references, backlinks.

Tiptap nodes/marks: `DocumentLink`, `AnnotationLink`, `NoteLink`, `EmbeddedExcerpt`.

An embedded excerpt resolves the current annotation by ID rather than permanently duplicating
its text. The annotation record still retains the selected text as it existed at creation.

## Database

SQLite through better-sqlite3. Migrations from the beginning.

Tables: `documents`, `document_files`, `document_revisions`, `document_chunks`, `annotations`,
`annotation_anchors`, `notes`, `links`, `collections`, `document_collections`, `tags`,
`document_tags`, `reading_positions`, `workspace_layouts`, `external_references`,
`indexing_jobs`.

Requirements: foreign keys enabled; transactions around multi-record operations; created and
updated timestamps; soft deletion only where useful; explicit schema migrations; repository
classes or domain services instead of SQL scattered through UI code.

Store files outside SQLite. Store metadata, paths, hashes, extracted text, and indexes in
SQLite.

## Search

SQLite FTS5. Index: document title, authors, abstract, PDF text, cleaned article text,
annotation text, annotation comments, notes, tags, collection names.

Chunk documents structurally: PDF by page or detected section; HTML by heading-delimited
section; notes by logical note block.

Each result must retain enough location information to open the relevant document and reveal
the matching page, section, annotation, or note.

Support phrase search, prefix search, filters by type / tag / collection / author /
publication date, search-result snippets, highlighted matching terms, keyboard navigation
through results.

No embeddings in the initial implementation.

## Zotero integration

Do not modify `zotero.sqlite`. Use Zotero's local API to read items, attachments, collections,
tags, bibliographic metadata.

Adapter maps: Zotero parent item key -> external document reference; Zotero attachment key ->
external file reference; Zotero collection key -> collection; Zotero tags -> tags; Zotero
metadata -> document metadata.

Detect whether Zotero is running and give a useful error when the local API cannot be reached.

One-way import or refresh from Zotero initially. No bidirectional synchronization yet.
Avoid duplicating imported records when the same Zotero item is refreshed. Use file hashes and
external references to detect changes.

## Workspace UI

VS Code-style shell: left activity bar, library sidebar, main Dockview area, optional right
annotation/notes sidebar, bottom panel for search or indexing status, status bar.

Panel types: `LibraryPanel`, `PDFReaderPanel`, `ArticleReaderPanel`, `SearchResultsPanel`,
`AnnotationListPanel`, `NoteEditorPanel`, `DocumentOutlinePanel`, `BacklinksPanel`.

Users must be able to open multiple documents, split horizontally or vertically, drag tabs
between groups, close and reopen panels, restore the previous layout, open search results
beside the current document, open linked annotations in another pane.

Use a command system rather than having components directly manipulate every other component.
Example commands: `openDocument`, `openDocumentAtLocation`, `openAnnotation`, `openNote`,
`openSearch`, `splitCurrentPanel`, `toggleLibrarySidebar`, `toggleAnnotationSidebar`.

---

## VS Code-style navigation and link commands

Keyboard-first navigation similar to VS Code's symbol navigation. Documents, annotations,
notes, headings, figures, citations, and excerpts behave like navigable symbols. Links between
them behave like typed references.

### Link model

Every relationship is a typed, directed edge:

```ts
type LinkType =
  | "document-cites-document"
  | "note-references-document"
  | "note-references-note"
  | "note-references-annotation"
  | "annotation-references-annotation"
  | "annotation-belongs-to-document"
  | "excerpt-derived-from-annotation"
  | "child-of"
  | "related-to"
  | string;

interface Link {
  id: string;
  type: LinkType;
  sourceId: string;
  sourceType: LinkableEntityType;
  targetId: string;
  targetType: LinkableEntityType;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

Do not model all relationships as untyped backlinks. Links must retain source entity, target
entity, link type, creation time, optional source and target locations, optional display
label, optional parent-child ordering, and whether the link was created manually or derived
automatically.

### Required navigation commands

`goToTarget`, `goToParent`, `goToSource`, `goToDefinition`, `peekDefinition`,
`findAllReferences`, `findAllLinksOfType`, `findIncomingLinks`, `findOutgoingLinks`,
`openBacklinks`, `openLinkGraph`, `goBack`, `goForward`, `goToNextReference`,
`goToPreviousReference`, `copyInternalLink`, `revealInLibrary`, `openToSide`.

These must work consistently across PDF readers, HTML readers, notes, annotations, search
results, and graph views.

### Go to target (F12)

When the cursor or selection is over an internal link: open its target, reveal the precise
target location, reuse the current pane by default, allow opening beside the current pane,
record the current location in navigation history. macOS also supports Command-click;
Windows/Linux Ctrl-click.

### Peek target (Option+F12 / Alt+F12)

Inline preview like VS Code's Peek Definition, showing target title, entity type, document
metadata, relevant excerpt, page or section, parent context, incoming and outgoing link
counts. The user can open the preview target in the current pane or beside it.

### Go to parent (Command+Up / Ctrl+Up)

Every entity that belongs to a containing entity exposes a parent relationship:

```
Highlight -> containing document        Excerpt -> source annotation
Annotation note -> annotation           Heading -> containing document
Figure -> containing document           Search result -> indexed document or note
Child note -> parent note               Attachment -> Zotero parent item
```

`goToParent` resolves the immediate semantic parent, opens it at the most relevant location,
preserves the current location in navigation history, and allows repeated invocation to move
upward. Example: embedded excerpt -> annotation -> PDF page -> document -> Zotero collection.

Only bind this shortcut where it does not interfere with text editing. The keybinding system
must support context conditions.

### Find all references (Shift+F12)

Equivalent to VS Code's Find All References. Each result includes source title, source entity
type, link type, contextual excerpt, document location, direction of the relationship,
open-in-current-pane action, open-to-side action. Results appear in a reusable references
panel rather than a modal dialog.

### Find all links of this kind

Invoke on a selected link to list all links with the same semantic type. Supports optional
narrowing by current document, current collection, source entity type, target entity type,
incoming vs outgoing direction, manual vs automatically derived, date range, tag.

Command `findAllLinksOfType` opens results in a `LinkResultsPanel` supporting sorting,
grouping, filtering, keyboard navigation. Groupings: by source document, by target document,
by link type, by collection, by direction, by entity type.

### Incoming and outgoing links

Separate `findIncomingLinks` ("what refers to this?") and `findOutgoingLinks` ("what does this
refer to?"). Do not combine them into an ambiguous backlink list unless the UI clearly labels
direction.

### Navigation history

Editor-style navigation history independent of browser history:

```ts
interface NavigationLocation {
  entityId: string;
  entityType: LinkableEntityType;
  documentId?: string;
  location?: DocumentLocation;
  panelId?: string;
  selection?: ReaderSelection;
  timestamp: number;
}
```

`goBack` / `goForward`. macOS: Control+Minus, Control+Shift+Minus. Windows/Linux: Alt+Left,
Alt+Right. History retains precise locations: PDF page and scroll position, HTML text anchor,
note cursor or selected block, annotation ID, search query and selected result, active
Dockview panel.

### Next and previous reference (F4 / Shift+F4)

While viewing a references result set, the active result is revealed in its source while the
references panel remains open.

### Command palette (Command+Shift+P / Ctrl+Shift+P)

Searchable, VS Code-style. Commands discoverable by technical and natural-language names, e.g.
`Links: Find All References`, `Navigation: Go to Parent`, `Document: Open to the Side`.

### Context-aware keybindings

A keybinding registry, not hardcoded listeners inside components:

```ts
interface Keybinding {
  commandId: string;
  key: string;
  when?: ContextExpression;
  priority?: number;
}
```

Context keys include: `readerFocus`, `pdfReaderFocus`, `htmlReaderFocus`, `noteEditorFocus`,
`linkUnderCursor`, `annotationSelected`, `documentSelected`, `referencesPanelFocus`,
`searchResultsFocus`, `textInputFocus`, `canGoToParent`, `canGoBack`, `canGoForward`.

Commands activate only when their context conditions are satisfied. Users should eventually
customize shortcuts through a JSON keybindings file or settings interface. Design for this
now, even if the first milestone ships fixed defaults.

### Link decorations

Navigable internal links communicate behavior without overwhelming the reading interface:
hover preview, link-type icon, incoming-reference count, broken-link warning, Command/Ctrl
click navigation, context menu, keyboard focus, accessible labels.

Link context menu: Open, Open to the Side, Peek Target, Go to Parent, Find All References,
Find All Links of This Type, Find Incoming Links, Find Outgoing Links, Copy Internal Link,
Reveal in Library.

### Database indexes

```sql
CREATE INDEX links_source_idx ON links(source_type, source_id);
CREATE INDEX links_target_idx ON links(target_type, target_id);
CREATE INDEX links_type_idx ON links(type);
CREATE INDEX links_type_source_idx ON links(type, source_type, source_id);
CREATE INDEX links_type_target_idx ON links(type, target_type, target_id);
```

Link queries must not require loading the complete graph into the renderer.

---

## Implementation expectations

Prefer small, testable modules. Keep TypeScript strict. Avoid `any`. Do not leave core
behavior as pseudocode. Do not create fake data paths when real integration is feasible. Add
structured error handling. Add logging around ingestion and indexing. Do not silently ignore
failures. Avoid giant React components. Avoid global mutable state. Avoid importing Electron
or database code into renderer packages. Do not prematurely build a custom design system. Do
not copy AGPL code from Zotero or SingleFile. Document licensing considerations in
`THIRD_PARTY_NOTICES.md`.

## Required tests

Database migrations; Zotero item mapping; duplicate-import prevention; PDF anchor
serialization; HTML text normalization; text quote anchor resolution; search indexing; search
result location mapping; internal link parsing; workspace layout serialization. Use
integration tests where unit tests cannot meaningfully validate the behavior.

## Developer experience

Root `README.md` with setup instructions, development commands, build commands, test commands,
architecture overview, security model, database migration instructions, Zotero integration
instructions, and a list of currently unsupported features.

Root commands: `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm lint`,
`pnpm typecheck`.

## Architectural optimization priorities

1. Stable annotation anchors
2. Local-first behavior
3. Secure handling of archived web content
4. Direct navigation from search results to source locations
5. Extensibility to EPUBs and semantic search later
6. Maintainability by a small team
