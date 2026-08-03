# wiki-reader — project invariants

Local-first Electron research reader. Imports from Zotero; reads PDFs, saved web pages and
markdown in a Dockview workspace; stable annotation anchors; typed links between entities;
FTS5 search that navigates to source locations; a graph of the connections.

**At the start of every context, read `state/NEXT_ACTION.md`.** It says what to do next.
Criteria are `docs/MILESTONE8.md`; milestones 1–7 are done and still gate (mind each
milestone's Supersessions rule). `docs/AGENTS.md` is how agent prompts are written. Everything
past milestone 8 is `docs/SPEC.md` and is still later — don't build it. Grep `docs/SPEC.md`;
don't read it whole.

## Layout

```
apps/desktop/           Electron app (main / preload / renderer)
packages/shared-types   IPC contracts, domain types, zod schemas
packages/document-model Entities, ID minting, DocumentAdapter, anchors, internal links
packages/database       better-sqlite3, migrations, repositories        [MAIN ONLY]
packages/zotero-adapter Zotero local API client + mapping               [MAIN ONLY]
packages/search         FTS5 chunking, query building, result mapping   [MAIN ONLY]
packages/workbench      Dockview shell, command + keybinding registry, nav history
packages/pdf-reader     PDF.js + react-pdf-highlighter-extended
packages/html-reader    Readability + sandboxed-iframe original view
packages/markdown-reader Rendered markdown, wikilinks, headings
packages/graph          Cytoscape model + layouts, shared by main and renderer
packages/annotations    Annotation panels and anchor resolution UI
packages/note-editor    Tiptap + DocumentLink/AnnotationLink/NoteLink/EmbeddedExcerpt
packages/shared-ui      Minimal primitives
workers/text-extraction PDF text extraction
workers/indexing        FTS5 indexing job runner
```

Packages are `@wr/<dir>`; the app is `@wr/desktop`.

## Commands

```bash
pnpm install · pnpm dev · pnpm build · pnpm test · pnpm test:e2e · pnpm typecheck · pnpm lint
pnpm package          # → apps/desktop/release/mac-arm64/wiki-reader.app
python3 scripts/verify_completion.py
```

The researcher runs the bundle in `/Applications`, not the tree. A green criterion means
nothing to them until `pnpm package` has run and that bundle has been replaced.

Node is pinned in `.nvmrc` (20.19.3), pnpm 9.15.4 via corepack. Mass database-test failures
mean a Node ABI mismatch, not a code bug.

## Security — never regress

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. No `webSecurity: false`.
- Preload exposes exactly one typed `invoke` and one `subscribe`. Nothing else.
- Every IPC payload is zod-validated in the main process before dispatch. All `ipcMain.handle`
  calls live in the single router module.
- File bytes reach the renderer only via `rrfile://`, which resolves an internal file ID
  through the database and refuses paths outside allowed roots. The renderer never receives or
  builds a filesystem path.
- Archived HTML is hostile input: script-disabled, sandboxed, restrictive CSP, no navigation.

## Architecture — never regress

- Renderer packages never import `electron`, `better-sqlite3`, `@wr/database`, or
  `@wr/zotero-adapter`. The verifier enforces this.
- Only the reader packages (`pdf-reader`, `html-reader`, `markdown-reader`) touch PDF.js- or
  DOM-specific coordinates. Everything else goes through `DocumentAdapter`.
- Anchors persist text evidence (exact/prefix/suffix + hashes), never only pixel coordinates.
- Documents render in their **original form**. Extracted text is for search and anchoring, and
  is never the reading view or a silent fallback.
- All relationships are typed directed edges in `links`. No untyped backlink table.
- Panels never manipulate each other directly — everything goes through the command registry.
- Zotero item keys live in `external_references`, never as primary internal IDs.
- Never modify `~/Zotero/zotero.sqlite`. Read through the local API only.

## Background execution

Automated runs happen while someone is using this machine. `WR_BACKGROUND=1` means the window
is never shown and never takes focus; the E2E harness sets it on every launch. Never bypass it,
never call `focus()`/`shell.open*`, never run `pnpm dev` unattended.

## Checkpoint discipline

Sessions are capped at 500 turns. Hand off deliberately well before that — a fresh session with
a good NEXT_ACTION.md beats a long one. After every coherent unit of work,
update `state/`, append to `state/iteration_ledger.jsonl`, commit, and **push immediately**.
Never go >15 turns without a checkpoint. Never leave a commit unpushed.

## Docs stay short

Every doc here is read by a model with limited context, so length costs flexibility. Keep them
under ~60 lines. They hold **decisions, invariants and traps** — not descriptions of code.
Never restate a schema, a channel signature, or a field mapping that already exists as typed,
tested source: it duplicates the authority and then drifts out of date, and a stale doc is
worse than no doc. Point at the source instead. History belongs in git, not in a doc.

## State

`state/experiment_state.json` (atomic writes) · `state/NEXT_ACTION.md` · `state/DECISIONS.md` ·
`state/iteration_ledger.jsonl` · `state/MILESTONE_STATUS.json` (planning aid, not evidence).

## Testing

A criterion is done only when a test whose title contains its tag passes:
`it('[M08] restores the saved reading position after restart', …)`.
Never weaken `scripts/verify_completion.py`; strengthening is allowed.

**A feature is not done until the guide shows it.** A new command must be named by a chapter in
`packages/workbench/src/guide.ts`; a new panel widget that is a feature must be declared in
`PANEL_CONTROLS` and carry `data-control="<id>"`. Both are enforced — `guide.test.ts` and
`tests/integration/guide-controls.test.ts` fail otherwise, and the page says so in the app.

## Git

Branch `main`, remote `origin` = `https://github.com/czhs/wiki-reader.git`. Push every commit
as soon as it's made. Never commit user library data, real Zotero PDFs, or a populated database.

## Done

Emit `<promise>MILESTONE_COMPLETE</promise>` only after `verify_completion.py` exits 0, the
audit in `reports/AUDIT.md` has no unresolved critical or major findings, and HEAD is pushed.
