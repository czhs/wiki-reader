# Next action

## Now

Milestone 1 is **five E2E criteria** from done: `M06`, `M07`, `M11`, `L02`, `L08`.
`tests/e2e/shell.spec.ts` passes (5 specs: M01, M02, M05). `tests/e2e/reader.spec.ts` runs
**6 passed, 3 failed** — fix those three first:

1. `reader.spec.ts:51` (M06) — `page.evaluate` throws `Cannot read properties of undefined
   (reading 'files')`. Check the shape actually returned before asserting on it.
2. `reader.spec.ts:86` (M06) — the `"N pages"` label says 3 but `[data-testid^="pdf-page-"]`
   stably resolves 4. Either an extra page node shouldn't carry that testid, or the label
   under-counts. Decide which is wrong — loosening the assertion would hide a rendering bug.
3. `reader.spec.ts:124` (M11) — the selection doesn't become a painted, stored highlight.

The verifier marks **all** E2E criteria failing when Playwright exits non-zero, so M01/M02/M05
show red despite passing alone. Fixing these three should restore all eight.

Then milestone 2: `docs/MILESTONE2.md`, 10 criteria (`W01`–`W10`) — markdown, saved web pages
in original form, `[[wikilinks]]`, the graph. Nothing else from SPEC.md. Don't start while any
milestone-1 criterion is red.

## Toolchain — read before diagnosing database failures

Node pinned to 20.19.3 in `.nvmrc`, pnpm 9.15.4 via corepack. Homebrew's node 26 (ABI 147) and
pnpm 11 **break the build** — better-sqlite3 11.10.0 has no prebuild for ABI 147 and won't
compile against Node 26. That looks like ~93 failing database tests. **It is not a code bug.**
`loop.sh` aborts before iteration 1 if the binding can't open a database.

## Verified

`pnpm test` 330 passing · `typecheck` 0 · `lint` 0 · verifier 62/68, zero criterion failures.
E2E runs in background mode; the window is never shown.

## Useful

Selectors: `app-shell`, `activity-bar`, `dockview-container`, `library-sidebar`,
`library-item-<documentId>`, `pdf-reader`, `pdf-page-count`, `pdf-scroll`, `pdf-page-<i>`,
`pdf-highlight-<id>`, `selection-toolbar`, `create-highlight`, `bottom-panel`,
`reference-row-<i>`, `peek-overlay`, `status-bar`.

A highlight needs a real DOM selection in `.wr-pdf-page__text-layer` then `mouseup` on
`pdf-scroll`. Cmd/Ctrl-click a `ListRow` opens to the side (M07). F12 maps to `goToTarget`
only when `linkUnderCursor` is set, which the note editor sets on link hover (L02).

## Don't

Rebuild the e2e harness or the verifier. Re-run `corepack prepare`. Weaken the verifier.
Widen milestone-1 criteria to cover SPEC.md. Show an Electron window in automated runs.
