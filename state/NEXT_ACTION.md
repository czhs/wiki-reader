# Next action

## Now

Milestone 1 is **two E2E criteria** from done: `L02` and `L08`. Neither has a spec yet — the
whole E2E suite is `tests/e2e/shell.spec.ts` (M01, M02, M05) and `tests/e2e/reader.spec.ts`
(M06 ×2, M07, M11), **9 passed / 0 failed**.

Write `tests/e2e/links.spec.ts`:

1. `[L02]` — open the seeded note (`workspace.noteId`, body has two `documentLink` chips
   pointing at `workspace.referencedDocumentIds`), hover a chip so the note editor sets
   `linkUnderCursor`, press `F12`, assert the target document's reader panel opens.
   `NoteEditorView.tsx:55` is where hover sets the target; `host.ts:212` reads it.
2. `[L08]` — with an entity selected, `Shift+F12` calls `showReferences`, which opens
   `bottom-panel` (`host.ts:288`). Click `reference-row-0`, then `reference-row-1`: the
   target opens each time **and `bottom-panel` is still visible** — that is the criterion.
   `openReference` (`host.ts:322`) is shared by clicking and keyboard stepping.

Then milestone 2: `docs/MILESTONE2.md`, 10 criteria (`W01`–`W10`) — markdown, saved web pages
in original form, `[[wikilinks]]`, the graph. Nothing else from SPEC.md. Don't start while any
milestone-1 criterion is red.

## Toolchain — read before diagnosing database failures

Node pinned to 20.19.3 in `.nvmrc`, pnpm 9.15.4 via corepack. Homebrew's node 26 (ABI 147) and
pnpm 11 **break the build** — better-sqlite3 11.10.0 has no prebuild for ABI 147 and won't
compile against Node 26. That looks like ~93 failing database tests. **It is not a code bug.**
`loop.sh` aborts before iteration 1 if the binding can't open a database.

## Verified

`pnpm test` 330 passing · `typecheck` 0 · `lint` 0 · `test:e2e` 9 passed, exit 0.
E2E runs in background mode; the window is never shown.

## Useful

Selectors: `app-shell`, `activity-bar`, `dockview-container`, `library-sidebar`,
`library-item-<documentId>`, `pdf-reader`, `pdf-total-pages`, `pdf-scroll`, `pdf-page-<i>`,
`pdf-highlight-<id>`, `selection-toolbar`, `create-highlight`, `annotations-sidebar`,
`bottom-panel`, `close-bottom-panel`, `reference-row-<i>`, `peek-overlay`, `status-bar`,
`status-panel-count`, `command-find-references`.

The page-count label is `pdf-total-pages`, **not** `pdf-page-count`: that older name is a
prefix of `pdf-page-<i>`, so `[data-testid^="pdf-page-"]` counted it as an extra page.

`rr.invoke` returns the raw `IpcResult` envelope (`{ ok, value }` / `{ ok, error }`) — unwrap
it in `page.evaluate`, the way `renderer/ipc.ts` `call()` does.

To read the app's database from a spec, use `openDatabase({ file, readonly: true, migrate:
false })` **in the Playwright process** (see `readAnnotations` in `reader.spec.ts`).
`electronApplication.evaluate` cannot `require` or dynamic-`import`: the main process is ESM
and the inspector eval has no module scope.

## Don't

Rebuild the e2e harness or the verifier. Re-run `corepack prepare`. Weaken the verifier.
Widen milestone-1 criteria to cover SPEC.md. Show an Electron window in automated runs.
