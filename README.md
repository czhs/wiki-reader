# wiki-reader

A local-first desktop research reading application. It imports documents from Zotero and
presents them in a VS Code–style reading workspace: draggable tabs, split panes, PDF and
archived-HTML reading, stable highlights, Tiptap notes, typed links between everything, and
full-text search that navigates straight to the source location.

There is no account, no sync service, and no telemetry, and every reading, annotation, search,
and linking feature works fully offline.

The one exception is the **librarian agent**, which needs a language model and so sends your
wiki's text to one. It is **off by default** and runs under your own credentials, through the
`claude` command-line tool installed on this machine. Before it can be turned on, the Librarian
panel shows exactly what would be sent, counted from your own library — how many documents,
highlights, questions and journal entries — along with where it goes and what it is not given.
With agents disabled, nothing in the application makes a network request: no schedule is armed,
no copy of the wiki is made, and no process is started. The librarian only ever **proposes**;
nothing it writes enters your wiki without you accepting it. See `docs/AGENTS.md`. The reviewer
agent is specified in `docs/SPEC.md` and is not yet implemented.

> **Status: milestone 3.** The reader is complete — Electron shell, database, Zotero import,
> PDF, saved-page and markdown reading, highlights, typed links, search and the graph, against
> the criteria in `docs/MILESTONE.md` and `docs/MILESTONE2.md`. Milestone 3 adds the research
> queue, the journal and the librarian (`docs/MILESTONE3.md`).
> See [Currently unsupported](#currently-unsupported).

## Setup

Requirements:

- Node 20.11 or newer
- pnpm 9 (via corepack: `corepack enable && corepack prepare pnpm@9.15.4 --activate`)
- Zotero 7 with the local API enabled
- macOS, Windows, or Linux

```bash
git clone https://github.com/czhs/wiki-reader.git
cd wiki-reader
pnpm install
node scripts/build_electron_native.mjs   # build better-sqlite3 for the Electron ABI
```

### A note on native modules

`better-sqlite3` loads a single `build/Release/better_sqlite3.node`, with no ABI component in
the path. Node (used by the test suite) and Electron use different ABIs, so a naive rebuild
for one breaks the other. `scripts/build_electron_native.mjs` builds the Electron-ABI copy,
stages it under `apps/desktop/resources/native/electron-<version>/`, and restores the
Node-ABI build. The main process opens the database with an explicit `nativeBinding` path.
Run it again after upgrading Electron.

This repository also sets `ignore-scripts=false` in `.npmrc`, because native builds require
postinstall scripts. Which packages may run them is restricted by
`pnpm.onlyBuiltDependencies` in `package.json`. Keep that allowlist narrow.

## Development

```bash
pnpm dev          # electron-vite dev server with HMR
pnpm build        # production build
pnpm test         # vitest: unit + integration
pnpm test:e2e     # playwright driving a real Electron build
pnpm typecheck    # tsc -b across the whole workspace
pnpm lint         # eslint, zero warnings tolerated
```

Milestone completion is checked by:

```bash
python3 scripts/verify_completion.py
```

It re-runs the test suites and parses the reporter output; a criterion counts as done only
when a test tagged with its ID passes. See `docs/MILESTONE.md`.

## Architecture

A pnpm monorepo. Functionality is separated by domain, and the package boundary is also the
security boundary.

```
apps/desktop/           Electron app: main, preload, renderer
packages/shared-types   IPC contracts, domain types, zod schemas (no runtime deps)
packages/document-model Entities, ID minting, DocumentAdapter, anchoring, internal links
packages/database       better-sqlite3, migrations, repositories        [main only]
packages/zotero-adapter Zotero local API client and mapping             [main only]
packages/search         FTS5 chunking, query building, result mapping   [main only]
packages/workbench      Dockview shell, command + keybinding registry, navigation history
packages/pdf-reader     PDF.js + react-pdf-highlighter-extended
packages/html-reader    Mozilla Readability + sandboxed-iframe original view
packages/annotations    Annotation panels and anchor-resolution UI
packages/note-editor    Tiptap with DocumentLink / AnnotationLink / NoteLink / EmbeddedExcerpt
packages/shared-ui      Minimal primitives
workers/text-extraction Utility process for PDF text extraction
workers/indexing        FTS5 indexing job runner
```

Two rules hold the design together:

1. **Readers are interchangeable.** Everything above `DocumentAdapter` speaks in
   `DocumentLocation`, `AnnotationAnchor`, and `ReaderSelection`. No code outside
   `pdf-reader` and `html-reader` touches a PDF.js viewport or a DOM Range. Adding EPUB
   support means implementing the interface and adding an anchor variant.
2. **Panels never talk to each other.** Every cross-panel action goes through the command
   registry, so a keybinding, a context menu, the command palette, and a link click all
   reach the same code path.

### Anchoring

Highlights are anchored to *text*, not pixels. A PDF anchor stores the page index,
page-relative rectangles, the selected text, the text immediately before and after it, a
hash of the page's normalized text, and the revision's content hash. When the page is
unchanged the offsets are authoritative; when it changed, the quote plus its context
relocates the highlight, and the stale geometry is discarded rather than drawn in the wrong
place. When the text is genuinely gone, resolution returns `null` and the UI shows a broken
anchor instead of silently guessing.

HTML anchors follow the W3C Web Annotation model: `TextQuoteSelector` plus
`TextPositionSelector`, over consistently normalized text, with the snapshot hash and reader
mode recorded. A DOM range is kept only as a last-resort fallback, never as the sole anchor.

## Security model

| Setting | Value |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` |
| `webSecurity` | never disabled |

The main process owns the filesystem, SQLite, Zotero communication, ingestion, extraction,
indexing, and settings. The renderer owns only presentation.

The preload exposes exactly two functions — a typed `invoke` and a typed `subscribe`. There
is no raw `ipcRenderer`, no filesystem handle, no database handle, and no shell access. Every
IPC payload is validated against a zod schema in the main process *before* dispatch, and all
`ipcMain.handle` registrations live in one router module so the validation cannot be
bypassed. Errors cross the boundary as a structured `{code, message, remedy}` envelope, never
as a stack trace.

File bytes reach the renderer through a custom `rrfile://` protocol. `rrfile://<fileId>`
resolves an internal file ID through the database to a path, checks that path against the
allowed roots, and streams the bytes with range support. The renderer never receives or
constructs a filesystem path, and PDF.js still gets the range requests it needs.

Archived web pages are treated as hostile input: rendered script-disabled in a sandboxed
iframe, with a restrictive CSP, no Node access, and blocked navigation.

## Database

SQLite via better-sqlite3, with foreign keys on and explicit forward migrations from the
first commit. Files live on disk; SQLite stores metadata, paths, hashes, extracted text, and
indexes.

```bash
pnpm --filter @wr/database exec node ./dist/cli.js migrate   # apply pending migrations
pnpm --filter @wr/database exec node ./dist/cli.js status    # show applied versions
```

Migrations are numbered SQL files under `packages/database/src/migrations/`. They are applied
in order inside a transaction and recorded in `schema_migrations`. To add one, create the
next numbered file — never edit an applied migration.

Search uses FTS5. Every indexed row carries a `locator` describing exactly where the text
came from, which is what lets a search result open the right PDF page or article section.
The chunk table is designed so `sqlite-vec` can attach embeddings to existing rows later
without re-chunking; no embeddings ship today.

## Zotero integration

wiki-reader **never modifies `zotero.sqlite`**. It reads through Zotero's local HTTP API.

Enable it in **Zotero → Settings → Advanced → Miscellaneous → "Allow other applications on
this computer to communicate with Zotero"**. The API is then served at
`http://localhost:23119/api/`.

```bash
curl "http://127.0.0.1:23119/api/users/0/items?limit=1"   # 200 = ready
```

- `403` — Zotero is running but the local API is disabled; enable the setting above.
- Connection refused — Zotero is not running.

The adapter maps Zotero parent item keys to external document references, attachment keys to
external file references, collection keys to collections, and Zotero tags and metadata onto
the corresponding domain records. Zotero keys are stored in `external_references` and are
never used as internal primary IDs, so a re-import cannot fork your annotations.

Import is one-way. Re-running it is idempotent: records are matched by external reference and
skipped when the Zotero item version and file hash are unchanged.

## Currently unsupported

Deliberately out of scope so far:

- EPUB and other formats
- Semantic or vector search (`sqlite-vec` is designed for, not implemented). Note that the
  librarian deliberately has no retrieval step either — it reads whole documents, because
  ranking chunks by similarity decides what is related before the model has seen it
- The reviewer agent, hypotheses as first-class entities, and the bulletin board
- Writing anything back to Zotero; synchronization is one-way
- Zotero group libraries
- The link graph view
- User-editable keybindings file (the registry supports it; there is no UI or file loader)
- Mobile, web, or headless operation

## Licensing

See `THIRD_PARTY_NOTICES.md`. In short: this project is MIT-licensed and deliberately
contains no code copied from Zotero or SingleFile, both of which are AGPL. Interoperating
with Zotero's HTTP API is not derivation.
