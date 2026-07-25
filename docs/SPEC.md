# Frozen product specification

This document is the authoritative specification for wiki-reader. It is frozen: change it
only on explicit user authorization, and record any change in `state/DECISIONS.md`.

---

## Product goal

A local-first desktop application for a **living research wiki that grows out of reading**.

This is the standalone successor to Field Station's in-browser wiki annotator (the Read tab:
`assets/js/annotate.js` over vendored Hypothesis anchor libraries, persisting to
`wiki/annotations/annotations.json`). That version was constrained to vanilla ES modules with
no framework and no CDN because it had to live inside a static Jekyll site. A desktop
application is not subject to those constraints, and the requirements below assume they are
gone. What does *not* change is the purpose.

The purpose is not document management. It is that reading, annotating, linking, and
**agent-assisted synthesis** happen in one place, over a corpus the user owns, so that a body
of understanding accumulates instead of a pile of PDFs. Users can:

- Ingest sources into a wiki: papers from a named Zotero collection, saved web pages from a
  URL list, and hand-authored markdown
- Read PDFs, archived web snapshots, and markdown in one workspace
- Highlight passages in one of six preset colors, comment on them, and link them to each
  other, to documents, and to notes
- Cross-link the corpus with `[[wikilinks]]` and `#tags` that resolve into a navigable graph
- Arrange documents in draggable tabs and split panes, with layout remembered
- Search everything and navigate straight to the source location
- Run a **librarian agent** that sweeps the corpus, connects sources to research questions,
  logs contradictions, and surfaces open threads — without ever editing the source of record
- Run a **reviewer agent** that critiques a research journal Socratically

The application should feel like a combination of Zotero, VS Code, Obsidian, and a research
assistant that has actually read everything.

## The wiki corpus

The corpus is a directory of markdown and downloaded source files that the user owns and can
read, diff, and commit outside this application. The database indexes it; the database is not
the source of record. If the database is deleted, the corpus survives and can be re-indexed.

### Ground truth versus agent workspace

The single most important structural rule, inherited from Field Station's librarian contract:

- **Ground truth** — `INSTRUCTIONS.md`, `reviewer/`, and every `*/ground-truth/` folder.
  Ingested source text, downloaded pages, Zotero-imported papers, and media bytes. Agents
  **read but never write** these. Neither does the application, except through an ingestion
  job that adds new files and never modifies or deletes ones it did not write.
- **Agent workspace** — every `**/claude/` folder. Agents own these completely.
- **Sanctioned exceptions** — the bulletin board (`bulletin/board.json`) is agent-writable.
  Any future exception must be named explicitly in this specification.

This boundary must be enforced by the application, not merely by instructions to the agent.
An agent tool call that would write outside the workspace or a sanctioned exception is
refused at the tool boundary and logged. Field Station's own instructions concede the
boundary is honor-based because the tooling can write anywhere; here it must not be.

### Organization

- `<project>/` — one folder per research question.
- `<project>/ground-truth/` — ingested source text for that project.
- `**/claude/` — agent notes: connection maps, contradiction logs, open threads, orientation.
- Research questions and journals are markdown documents in the corpus, not database rows.

### Ingestion

Three sources, all one-way into ground truth, none of them destructive:

1. **Zotero** — a *named collection* (not the whole library) maps to one project's
   ground-truth folder. Attachment text is extracted to markdown alongside the original file.
2. **URL list** — a `sources.txt` of saved-page URLs is fetched to archived snapshots plus
   extracted markdown.
3. **Hand-dropped files** — `.md` and `.txt` placed in a ground-truth folder by the user.

Sync never deletes a file it did not write. Re-ingesting an unchanged source is a no-op
detected by content hash.

## Presentation fidelity

**The reader shows each document in its original form.** This is a governing principle, not a
preference, and it outranks convenience in every design decision below.

A PDF renders as the PDF — the actual file, through PDF.js, with a real text layer over it.
A saved web page renders as the page: its own HTML, images, CSS, and layout, looking like what
was saved. Zotero's snapshots are faithful, and that fidelity is the entire reason the
snapshot was taken rather than a URL bookmarked.

Derived representations — extracted text, markdown conversions of a PDF or web page,
Readability's cleaned article view — exist so the corpus can be searched, anchored, and read
by an agent. They are **never** the primary presentation. The application must never silently
substitute a derived view for the original, and must never present one in a way that could be
mistaken for the source.

Where a derived view is genuinely useful it is offered as an explicit, clearly labelled,
reversible choice, with the original one action away. A user who cannot tell which
representation they are reading is being misled about what the source says.

This applies to agents too: an agent citing a source cites the original file by path, and its
claims must be checkable against the document as saved.

## Document types

Three first-class types, all annotatable through the same `DocumentAdapter`:

| Type | Rendering | Notes |
|---|---|---|
| **PDF** | PDF.js rendering the actual file, with a selectable text layer | Never an image-only render; never replaced by its extracted text |
| **Web snapshot** | The saved page as saved, with its own resources, in a sandboxed script-disabled iframe | Readability is an optional alternate view, never the default |
| **Markdown** | Escape-first renderer; `[[wikilinks]]` and `#tags` live | Only where markdown *is* the original |

The third row is narrower than it looks. Markdown is a first-class type because much of the
corpus is *natively* markdown — wiki pages, research questions, journals, agent notes, and
hand-dropped `.md` files. Those render as markdown because that is what they are.

The markdown extracted *from* a PDF or a web snapshot is a different thing: a derived
artifact, indexed and searchable and readable by agents, but never the reading view for a
document whose original exists. Opening such a document opens the PDF or the snapshot.

Anchors should survive across *representations* of the same source where feasible — a
highlight created on a PDF's text layer should re-locate in that document's extracted
markdown, since both derive from the same normalized text. That equivalence is what lets an
agent work over extracted text while the user reads the original, with both referring to the
same passage.

## Required stack

Electron, React, TypeScript strict mode, electron-vite, pnpm workspaces, Dockview (tabs,
splits, floating panes, layout persistence), PDF.js (rendering + text extraction),
react-pdf-highlighter-extended (PDF annotations), Mozilla Readability (cleaned webpage
rendering), a markdown renderer that is escape-first and XSS-safe, Tiptap (notes), SQLite via
better-sqlite3, SQLite FTS5, Zotero local API.

**Graph rendering: Cytoscape.js** (`cytoscape`, MIT, zero runtime dependencies, ships CJS +
ESM + UMD builds). Chosen over `force-graph` — which is what Foam and Field Station both use —
for one architectural reason: Cytoscape separates its graph *model* from its renderer and runs
**headless in Node**. The link-query rule below requires neighbourhood queries to execute in
the main process without shipping the whole graph to the renderer, and Cytoscape is the option
that lets the same model and the same traversal code serve both sides.

**Markdown and wikilink parsing: the unified/remark stack** — `remark-parse` with
`remark-frontmatter`, walked via `unist-util-visit`, plus `github-slugger` for slug
generation. This is the stack Foam uses, and matching it means `[[wikilink]]` semantics behave
the way anyone arriving from Foam or Obsidian expects. Parse to an AST; never resolve
wikilinks with a bare regex over raw text, which is how `[[…]]` inside a code fence ends up as
a spurious edge.

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

## Highlight interaction

Identical across PDF, web snapshot, and markdown.

Select text → a highlight is created in the currently chosen color. Click an existing
highlight → a small popover to edit its comment, change its color, delete it, copy its
internal link, or link it to another highlight or document.

Six preset colors, carried over from Field Station's annotator so existing highlights import
without a lossy color mapping: `default`, `tan`, `spruce`, `ochre`, `clay`, `signal`. Color is
semantic to the user, so it is stored as the name — never as a hex value resolved at creation
time, which would break under theming.

A highlight that carries a link renders a badge. Activating the badge jumps to the target,
loading it into the other pane if it is not already open.

Highlights whose anchors no longer resolve are not deleted. They are retained, marked
orphaned, and listed so the user can re-anchor or discard them.

## PDF annotations

Anchors must include: page index, normalized bounding rectangles, selected text, text before
the selection, text after the selection, page text hash, document revision or content hash.
Do not persist only viewport pixel coordinates.

The application must render saved highlights, scroll to a highlight, open a highlight in
another split, attach a note to a highlight, and copy a stable internal link.

Internal links: `annotation://<id>`, `document://<id>`, `note://<id>`. Internal application
links, not public URLs.

## HTML annotations

**The default archived webpage view is the original snapshot**, rendered in a sandboxed,
script-disabled iframe and looking like the page that was saved. Mozilla Readability is an
optional alternate view for pages where the saved layout genuinely obstructs reading. It is
never the default, and switching to it is an explicit, labelled, reversible action.

A faithful snapshot is not one file. Zotero saves the page with its images, stylesheets, and
other resources, and the reader must load them or the "original" it presents is a broken
approximation that quietly misrepresents the source. The `rrfile://` protocol therefore has to
resolve a snapshot's relative resource references as well as its entry document, confined to
that snapshot's own directory inside the allowed roots. A resource reference that escapes the
snapshot directory is refused, and a reference to a remote origin is not fetched — a snapshot
that silently reaches the live web is neither local-first nor a faithful record of what was
saved.

Scripts never execute. There is no Node access and no navigation. The absence of scripts will
make some pages imperfect; that is the correct trade, and it is not a reason to fall back to
a cleaned view without asking.

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
`indexing_jobs`, `projects`, `agent_runs`.

The database is an index over the corpus, not the corpus. Documents, research questions,
journals, and agent notes are markdown files on disk; their rows are derived and rebuildable.
Annotations and the bulletin board round-trip to files in the corpus so that highlights and
board state survive a database rebuild and can be committed to git alongside the text they
annotate. Where a file and a row disagree, the file wins.

Requirements: foreign keys enabled; transactions around multi-record operations; created and
updated timestamps; soft deletion only where useful; explicit schema migrations; repository
classes or domain services instead of SQL scattered through UI code.

Store files outside SQLite. Store metadata, paths, hashes, extracted text, and indexes in
SQLite.

## Search

SQLite FTS5. Index: document title, authors, abstract, PDF text, cleaned article text,
markdown body text, annotation text, annotation comments, notes, agent notes, research
questions, journals, tags, collection names, project names.

Chunk documents structurally: PDF by page or detected section; HTML by heading-delimited
section; markdown by heading-delimited section; notes by logical note block.

Search results must be filterable by project and by whether the source is ground truth or
agent-written, so the user can always separate what a source said from what an agent inferred.

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

Import is scoped to **named collections**, each mapped to a project's ground-truth folder —
not a flat import of the entire library. A user's Zotero library is broader than any one line
of research, and an unscoped import buries the corpus the wiki is about. Importing additional
collections later must be additive.

Detect whether Zotero is running and give a useful error when the local API cannot be reached.

One-way import or refresh from Zotero initially. No bidirectional synchronization yet.
Avoid duplicating imported records when the same Zotero item is refreshed. Use file hashes and
external references to detect changes.

## Workspace UI

VS Code-style shell: left activity bar, library sidebar, main Dockview area, optional right
annotation/notes sidebar, bottom panel for search or indexing status, status bar.

Panel types: `LibraryPanel`, `PDFReaderPanel`, `ArticleReaderPanel`, `MarkdownReaderPanel`,
`SearchResultsPanel`, `AnnotationListPanel`, `NoteEditorPanel`, `DocumentOutlinePanel`,
`BacklinksPanel`, `GraphPanel`, `BulletinPanel`, `AgentRunPanel`.

The library sidebar is organized by **project**, not by a flat document list, and distinguishes
ground truth from agent-written notes.

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

### Wikilinks and tags

The corpus is an Obsidian-style vault. `[[slug]]` in any markdown document — a wiki page, a
research question, a journal, an agent note — is a first-class link, and `#tag` is a
first-class tag. Both are authored by hand and by agents, in plain markdown, and must remain
meaningful when the corpus is read outside this application.

Wikilinks are **derived** links, not a second link system. On indexing, every `[[slug]]` in a
document becomes a `Link` of type `note-references-document` or `note-references-note` with
`origin: "derived"`, resolving `slug` against document slugs. They participate in
`findAllReferences`, the graph view, and navigation exactly as manually created links do.

Because they are derived, re-indexing a document replaces its derived links wholesale. Never
delete a manually created link during that sweep.

An unresolved `[[slug]]` is not an error. It renders as a broken link and is listed as a
wanted page — a page someone intended to exist. That list is a research prompt, and the
librarian may act on it.

Round-tripping is required: the internal link scheme (`document://`, `annotation://`,
`note://`) addresses entities precisely for navigation and copy-link; `[[wikilinks]]` are what
a human writes in prose. Copying an internal link to a document offers both forms.

#### Syntax

Follow Foam's syntax rather than inventing a dialect — the corpus should stay readable in
Foam, Obsidian, or a plain text editor:

| Form | Meaning |
|---|---|
| `[[slug]]` | Link to the document with that slug |
| `[[slug\|alias]]` | Same link, displayed as `alias` |
| `[[slug#Section Title]]` | Link to a heading within that document |
| `#tag` | Tag, excluding `#` inside code spans, fences, and URLs |

Parse from the markdown AST, never with a regex over raw text. A `[[…]]` inside a code fence
is code, not a link, and a `#` in a URL fragment is not a tag; both are edges the graph must
not invent.

#### Resolution

Slugs are generated with `github-slugger` so they match what Foam and GitHub produce.

Resolution is by slug across the whole corpus. When two documents in different projects share
a slug, the reference is **ambiguous**: report it, list the candidates, and let the user
disambiguate by adding path segments. Never silently pick one — a wrong edge in a research
graph is worse than a missing one, because it looks like a finding.

#### Renaming

Renaming a document rewrites the `[[wikilinks]]` that point at it, as Foam does. This edits
markdown files, so it is subject to every rule in "The wiki corpus": a rename that would touch
ground truth is refused, the edit is shown as a reviewable diff before it is applied, and it
goes through the same write mediator as everything else.

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

## Agents

Two agents operate over the corpus. They are what makes this a wiki that grows rather than a
reader that stores. Both are invoked explicitly by the user — neither runs on a timer, on
launch, or in reaction to reading.

### Execution model and the local-first exception

Agents require a language model, which means text leaves the machine unless the model is
local. This is the **only** exception to the local-first guarantee, and it must be handled
without weakening the claim elsewhere:

- Agent features are **off by default** and require explicit opt-in with the user's own
  credentials, or a local model endpoint.
- With agents disabled, every other feature works fully offline. Nothing else in the
  application may acquire a network dependency.
- Before the first run, the user is shown exactly what would be sent: which files, how many,
  approximate size.
- Provider configuration is a setting, not a hardcoded vendor. A local endpoint must be a
  first-class option.
- Every agent run is logged locally with its inputs, outputs, and file writes.
- `README.md` must state this plainly rather than claiming unqualified local-only operation.

Agents run in the **main** process, never the renderer. Corpus access is through the same
repositories the rest of the application uses.

### Tool boundary enforcement

An agent's file writes go through a mediating layer that enforces the ground-truth boundary
structurally. A write outside `**/claude/` or a sanctioned exception is **refused and
logged**, not merely discouraged by the prompt. Path traversal, symlink escape, and absolute
paths are all rejected. Every agent write is a reviewable diff before it is committed to
disk; the user can reject any hunk.

### Wiki librarian

Invoked on demand. Assumes prior state exists and builds on it rather than starting over.
Each sweep:

1. **Read** the ground truth: ingested page text, Zotero-imported papers, research questions,
   and journals.
2. **Connect** — for each source, identify which research questions it bears on and record
   the link with reasoning in a connections map under the agent workspace. Cross-link with
   `[[wikilinks]]` so the relationship becomes a graph edge, and `#tags` for themes.
3. **Organize** — maintain an orientation map; split into topic notes as the corpus grows.
   Prefer many small well-named notes over one large file.
4. **Log contradictions** — where sources or journals disagree, record the specific claims in
   tension, cited by path.
5. **Surface open threads** — promising directions the corpus implies but nobody has taken.
6. **Post to the bulletin board** — a narrow remit: "can these be connected?", "these are in
   tension", "this paper does not support its claim". Not free-form essays.

Style requirements: cite ground-truth files by relative path so a human can verify; be
explicit about uncertainty; distinguish "the source says" from "I infer".

Librarian output is a **proposal**, never a silent mutation. The user sees what changed and
accepts or rejects it.

### Reviewer

Invoked on a single research journal. Critiques it Socratically — pressure-testing claims,
asking what evidence would falsify them, identifying unexamined assumptions — grounded in the
reviewer corpus rather than in generic advice. Read-only with respect to the journal; its
critique is written to the agent workspace.

### Bulletin board

A spatial canvas of cards and typed edges, shared between the user and the librarian. Cards
are notes or media at explicit positions; edges connect them with a label. Every card and
edge records its author, and the librarian may not edit or delete cards authored by the user
unless clearly obsolete. Layout is persisted and hand-arrangeable — position carries meaning
the user assigned, so the application must never silently re-flow it.

### Graph view

A navigable graph of the corpus: documents, notes, annotations, and research questions as
nodes; typed links and derived `[[wikilinks]]` as edges. Filterable by link type, project,
tag, and entity type. Selecting a node reveals it; selecting an edge offers
`findAllLinksOfType`.

This is a required feature, not a stub.

#### Split model and renderer

Rendered with **Cytoscape.js**. The reason it is specified rather than left open is that
Cytoscape's model runs headless in Node, which lets the same graph code serve two different
jobs:

- **Main process, headless** — neighbourhood queries, traversal, and centrality against the
  link indexes. This is where "what is connected to this?" is answered.
- **Renderer** — visualization of a *bounded* subgraph the main process has already selected.

The renderer must never load the complete graph to answer a question about one node's
neighbourhood. A corpus that grows for years cannot ship its full edge set to a canvas on
every interaction, and the moment the renderer owns traversal, the link indexes stop being
the source of truth for connectivity.

Open the graph on a focus node with a depth bound, not on everything. A whole-corpus view is
a legitimate command, but it is an explicit choice with a node cap and a visible indication
of what was elided — never the default, and never a silent truncation.

#### Layout

Force-directed by default, since the organic shape of a knowledge graph is the point.
Cytoscape's built-in `cose` is sufficient to start; `fcose` or `cola` are reasonable
upgrades if quality demands it.

Offer a hierarchical layout (`dagre` or `elk`) as an alternative. Citation chains and
parent-child relationships read far better as a DAG than as a force cloud, and this is
precisely the capability `force-graph` — Foam's and Field Station's choice — does not have.

Layout must be interruptible and must not block the UI thread on a large graph.

#### Prior art

Foam (`foambubble/foam`, MIT) is the reference implementation for wikilink semantics and is
worth reading before building this. Note that its graph view uses `force-graph` with
`d3-force`, rendered through `lit` — a good fit for a VS Code webview showing a whole vault,
and a poor fit for the split model above. Take Foam's link semantics; do not copy its graph
architecture.

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
serialization; HTML text normalization; markdown text normalization; text quote anchor
resolution; anchor resolution across representations of one source; search indexing; search
result location mapping; internal link parsing; `[[wikilink]]` parsing and slug resolution;
derived-link re-indexing that preserves manual links; workspace layout serialization.

Agent behavior requires its own tests, and they must not depend on a live model:

- The tool boundary **refuses** a write outside the agent workspace — including via `..`
  traversal, a symlink, and an absolute path.
- A librarian run over a recorded fixture corpus produces connections, contradictions, and
  open threads in the workspace and leaves ground truth byte-identical.
- Agent output is presented as a reviewable diff, and rejecting it writes nothing.
- With agents disabled, no code path performs a network request.

Use integration tests where unit tests cannot meaningfully validate the behavior. Record model
interactions as fixtures; never require an API key to run the suite.

## Developer experience

Root `README.md` with setup instructions, development commands, build commands, test commands,
architecture overview, security model, database migration instructions, Zotero integration
instructions, and a list of currently unsupported features.

Root commands: `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm lint`,
`pnpm typecheck`.

## Architectural optimization priorities

1. Integrity of ground truth — the corpus is the user's, and nothing may silently rewrite it
2. Presentation fidelity — the reader shows the document as it is, never a derived substitute
3. Stable annotation anchors
4. Local-first behavior, with the agent exception explicit and opt-in
5. Secure handling of archived web content and of agent file writes
6. Direct navigation from search results to source locations
7. Extensibility to EPUBs and semantic search later
8. Maintainability by a small team

The corpus must remain legible and useful with this application uninstalled: markdown files,
`[[wikilinks]]`, and annotation sidecars in a git repository. Any design that makes the wiki
hostage to the database is wrong regardless of how well it performs.
