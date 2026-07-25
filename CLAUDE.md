# wiki-reader — project invariants

Local-first Electron research reading app. Imports from Zotero, reads PDFs and archived HTML
in a VS Code-style Dockview workspace, with stable annotation anchors, typed links between
entities, and FTS5 search that navigates directly to source locations.

**Read these at the start of every new context:**

1. `state/experiment_state.json` — canonical machine state
2. `state/NEXT_ACTION.md` — what to do next
3. `state/MILESTONE_STATUS.json` — which criteria are already verified
4. `docs/MILESTONE.md` — acceptance criteria
5. `docs/SPEC.md` — frozen specification (grep it; do not read it whole)

## Repository layout

```
apps/desktop/          Electron app (main / preload / renderer)
packages/shared-types  IPC contracts + domain types + zod schemas (no runtime deps)
packages/document-model Entities, ID minting, DocumentAdapter, anchors, internal links
packages/database      better-sqlite3, migrations, repositories        [MAIN ONLY]
packages/zotero-adapter Zotero local API client + mapping              [MAIN ONLY]
packages/search        FTS5 chunking, query building, result mapping   [MAIN ONLY]
packages/workbench     Dockview shell, command + keybinding registry, nav history
packages/pdf-reader    PDF.js + react-pdf-highlighter-extended adapter
packages/html-reader   Readability + sandboxed-iframe adapter
packages/annotations   Annotation panels and anchor resolution UI
packages/note-editor   Tiptap + DocumentLink/AnnotationLink/NoteLink/EmbeddedExcerpt
packages/shared-ui     Minimal primitives (no design system)
workers/text-extraction Utility process: PDF text extraction
workers/indexing        FTS5 indexing job runner
```

Package names are `@wr/<dir>`; the desktop app is `@wr/desktop`.

## Commands

```bash
pnpm install
pnpm dev             # electron-vite dev
pnpm build
pnpm test            # vitest, unit + integration
pnpm test:e2e        # playwright driving real Electron
pnpm typecheck
pnpm lint
python3 scripts/verify_completion.py
```

## Security invariants — never regress

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- No `webSecurity: false`, no remote module, no arbitrary IPC.
- Preload exposes exactly one typed `invoke` and one `subscribe`. Nothing else.
- Every IPC payload is validated with zod in the main process *before* dispatch. All
  `ipcMain.handle` calls live in the single router module; nowhere else.
- File bytes reach the renderer only via the `rrfile://` protocol, which resolves an internal
  file ID through the database and refuses paths outside allowed roots. The renderer never
  receives or builds a filesystem path.
- Archived HTML renders script-disabled, sandboxed, with a restrictive CSP and blocked
  navigation. Treat it as hostile input.

## Architectural invariants

- Renderer packages must never import `electron`, `better-sqlite3`, `@wr/database`, or
  `@wr/zotero-adapter`. The verifier enforces this.
- Application code outside `packages/pdf-reader` and `packages/html-reader` must not touch
  PDF.js-specific or DOM-specific coordinates. Go through `DocumentAdapter`.
- Annotation anchors persist text-based evidence (exact/prefix/suffix + hashes), never only
  viewport pixel coordinates.
- All relationships are typed directed edges in `links`. No untyped backlink table.
- Panels never manipulate each other directly. Everything goes through the command registry.
- Zotero item keys live in `external_references`. They are never primary internal IDs.
- Never modify `~/Zotero/zotero.sqlite`. Read through the local API only.

## Where canonical state lives

- Machine state: `state/experiment_state.json` (atomic writes only)
- Next action: `state/NEXT_ACTION.md`
- Decisions: `state/DECISIONS.md`
- Per-iteration history: `state/iteration_ledger.jsonl`
- Criterion cache: `state/MILESTONE_STATUS.json` (planning aid; not evidence)

## Testing rule

A criterion counts as done only when a test whose title contains its tag passes:

```ts
it('[M08] restores the saved reading position after restart', () => { ... });
```

Never weaken `scripts/verify_completion.py` to make it pass. Strengthening is allowed.

## Git

Branch `main`, remote `origin` = `https://github.com/czhs/wiki-reader.git`.
Never commit user library data, real Zotero PDFs, or a populated application database.

## Completion rule

Emit `<promise>MILESTONE_COMPLETE</promise>` only after
`python3 scripts/verify_completion.py` exits 0, the independent audit in `reports/AUDIT.md`
has no unresolved critical or major findings, and HEAD is pushed to `origin/main`.
