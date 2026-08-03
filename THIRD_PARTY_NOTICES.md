# Third-party notices and licensing considerations

wiki-reader is distributed under the MIT license. This file records the licenses of
dependencies that carry obligations, and documents the deliberate choices made to avoid
copyleft contamination.

## The AGPL question: Zotero and SingleFile

Two projects in this problem space are licensed **AGPL-3.0**:

- **Zotero** — <https://github.com/zotero/zotero>
- **SingleFile** — <https://github.com/gildas-lormeau/SingleFile>

**No code from either project has been copied into this repository.** That is a standing
constraint, not an observation. Do not paste code, schema DDL, or algorithm implementations
from either project, including "just this one function".

### Why interoperating with Zotero is fine

wiki-reader communicates with Zotero exclusively over its **local HTTP API**
(`http://localhost:23119/api/`). Speaking a network protocol to a separate program that the
user chose to run does not create a derivative work of that program. The application:

- never links against Zotero code,
- never bundles or redistributes Zotero,
- never reads or writes `zotero.sqlite`,
- reads only through the documented HTTP interface.

Reading `zotero.sqlite` directly would still not be *linking*, but it would couple us to an
undocumented internal schema and risks corrupting a user's library. It is prohibited here for
engineering reasons as much as legal ones.

The Zotero **Web API data model** (item types, field names such as `itemType`,
`dateAdded`, `parentItem`) is an interface specification. Field names are used as data, not
copied as code.

### Archived webpage capture

Page archiving, when implemented, must not incorporate SingleFile code. Acceptable routes:

- Electron's own `webContents.savePage` and `capturePage`
- A purpose-written serializer using standard DOM APIs
- An MIT/BSD/Apache-licensed library

## Runtime dependency licenses

| Dependency | License | Notes |
|---|---|---|
| Electron | MIT | Bundles Chromium (BSD-3-Clause) and Node.js (MIT). Chromium ships its own extensive notices; a packaged build must include `LICENSES.chromium.html` from the Electron distribution. |
| React, React DOM | MIT | |
| Dockview | MIT | |
| PDF.js (`pdfjs-dist`) | Apache-2.0 | Requires preserving the license text and NOTICE. Mozilla-authored, but Apache-2.0, not AGPL — safe to bundle. |
| `react-pdf-highlighter-extended` | MIT | |
| `@mozilla/readability` | Apache-2.0 | Same obligations as PDF.js. Extracted from Firefox Reader Mode; Apache-2.0, not AGPL. |
| Tiptap core / react / starter-kit / pm | MIT | Tiptap's **Pro** extensions are separately licensed and commercial. Only MIT-licensed Tiptap packages may be added. |
| ProseMirror (via `@tiptap/pm`) | MIT | |
| `better-sqlite3` | MIT | |
| SQLite (bundled in `better-sqlite3`) | Public domain | No attribution required. FTS5 is part of the SQLite amalgamation. |
| `zod` | MIT | |
| `jsdom` | MIT | Test/extraction use only; not shipped to the renderer. |
| `cytoscape` | MIT | Graph view. Zero runtime dependencies. Ships CJS, ESM and UMD builds; used headless in main and rendered in the renderer. |
| Cytoscape layout extensions (`cytoscape-fcose`, `cytoscape-dagre`, `cytoscape-cola`, `cytoscape-elk`) | MIT | Only add what is used. `cytoscape-elk` pulls in `elkjs` (EPL-2.0) — see below before adopting it. |
| `remark-parse`, `remark-frontmatter`, `unist-util-visit`, `mdast-util-*` | MIT | unified/remark ecosystem, uniformly MIT. Markdown and `[[wikilink]]` parsing. |
| `github-slugger` | ISC | Permissive, MIT-compatible. Slug generation matching Foam and GitHub. |
| `@myriaddreamin/typst-ts-node-compiler` (+ its `darwin-arm64` binary) | Apache-2.0 | The Typst compiler, embedded whole (Typst 0.14) as a ~46 MB NAPI addon in the **main process only** (`S04`). Same Apache-2.0 obligations as PDF.js below. It embeds its own fonts — New Computer Modern, DejaVu Sans Mono and Libertinus — each under the SIL Open Font License, whose terms must ship with a distributed build. Nothing is fetched at compile time; `@preview/` package imports are refused before the source reaches it, because that is the one path in it that would reach the network. |
| `katex` | MIT | LaTeX in notebook and journal blocks (`S02`). Bundled, never fetched from a CDN. Used in **MathML mode only**, which is why no `katex.min.css` and none of the KaTeX fonts are shipped: those fonts carry their own terms (SIL OFL for the AMS faces) and adopting HTML output means adopting them. |

**`elkjs` is EPL-2.0, not MIT.** The Eclipse Public License is a weak/file-level copyleft: it
does not contaminate the application, but it carries source-availability obligations for the
EPL-covered files themselves and is a different obligation class from everything else here. If
a hierarchical layout is needed, prefer `cytoscape-dagre` (MIT) and only reach for
`cytoscape-elk` if dagre proves inadequate — and record the decision if so.

**Foam** (`foambubble/foam`, MIT) is referenced as prior art for `[[wikilink]]` semantics. No
code has been copied from it. If any ever is, MIT permits it with attribution, and this table
must be updated to say so explicitly.

### Apache-2.0 obligations

PDF.js, Readability and the Typst compiler are Apache-2.0. A distributed build must:

1. include a copy of the Apache License 2.0,
2. retain all copyright, patent, trademark, and attribution notices from those packages,
3. state in this file that the files are used unmodified (they are — all three are consumed as
   published npm packages with no source modifications).

Apache-2.0 is compatible with MIT distribution. It is not copyleft; it does not require
wiki-reader itself to be Apache-licensed.

### Chromium and Node.js

A packaged Electron application redistributes Chromium and Node.js. Before any public
release, copy the `LICENSE` and `LICENSES.chromium.html` files from the Electron distribution
into the packaged app's resources. This is currently **not done**, because the application is
not yet distributed as a binary.

## Development-only dependencies

TypeScript (Apache-2.0), Vite and electron-vite (MIT), Vitest (MIT), Playwright (Apache-2.0),
ESLint (MIT), `@electron/rebuild` (MIT). These are build-time tools and are not redistributed
in the packaged application, so their notices do not need to ship — but they are recorded here
for completeness.

## User content

Documents imported from a user's Zotero library remain the user's data and whatever the
rights of their original publishers are. wiki-reader stores paths and extracted text locally
and transmits nothing. Test fixtures recorded from a live Zotero library
(`packages/zotero-adapter/test/fixtures/`) contain bibliographic metadata only — no document
contents, no file bytes, and no credentials.

## Review checklist before release

- [ ] Bundle the Apache-2.0 license text for PDF.js, Readability and the Typst compiler
- [ ] Bundle the SIL OFL text for the fonts embedded in the Typst compiler
- [ ] Bundle Chromium and Node.js notices from the Electron distribution
- [ ] Re-verify no AGPL code has entered the tree
- [ ] Regenerate this table from the lockfile and reconcile differences
