# Next action

## Now

**`U06`, then the milestone-3 audit. Do not emit the promise until both are done.**
`U01`–`U05`, `U07` and `U08` are done and gated. Everything else in milestone 3 was already
green.

## `U06` — the one criterion left

> A highlight's comment can be written and read back from the reader itself — E2E.

The editing already exists and is tested: `packages/annotations/src/HighlightPopover.tsx` has
the comment field (`highlight-comment`, `highlight-comment-save`), and the seven `[W11]` tests
in `tests/integration/highlight-color.test.ts` drive it through
`renderer/annotation-actions.ts`, which is the single definition of what those edits do.

**What is missing is the way in.** Nothing in the reader points at the popover — the criterion
says *from the reader itself*, so the test to write is: highlight some text in the PDF reader,
open the comment from the highlight, type, save, and read it back without going through the
annotations sidebar. Check how `PdfReaderView` surfaces a click on an existing highlight before
adding anything; the affordance may be most of the way there already.

Model the test on `tests/e2e/reader.spec.ts`'s `[M11]`, which already turns a real text
selection into a stored highlight.

## Then the audit

**The verifier will say complete and be wrong about exactly one check.**

Its audit gate is satisfied by `reports/AUDIT.md` naming a commit reachable from HEAD; that
commit is `4420cea`, a milestone 2 one, and the file's own title is "milestones 1 and 2".
**Nobody has read milestone 3.** Do not take the promise on that.

The audit brief is in `docs/LOOP.md`. Point it at the librarian, where the new risk is:

1. **`A03` is the load-bearing one.** With agents off, is there *any* path from a fresh launch
   to `materialise()`, a spawn, or `scheduler.start()`? The E2E asserts `<agentRoot>/wiki`
   never appears; ask whether that is the only observable.
2. **`agent:accept` writes a file and mints a document** — the one channel that writes outside
   the database. Can it write outside the workspace? Can a proposal decided twice make two
   documents?
3. **The workspace root is a fixed `SwappableRoots` entry**, so `rrfile://` serves anything
   under it, `.runs/` staging included. Is that the intended blast radius?
4. **Weak-assertion sweep on the new tags.** `A05` and `A10` are one Playwright test each;
   mutate the handler and confirm each actually fails.

## What just changed (U01–U05, U07)

- **`main/menu.ts`** is new and load-bearing: Electron's default macOS menu owns `Cmd+W` on
  Window → Close, and a menu accelerator is consumed *before* the renderer's keydown listener.
  Installed in `index.ts` before the first window. `menu.test.ts` asserts no item binds `Cmd+W`.
- **`wr.closeTab` / `wr.closeGroup`** in `COMMAND_IDS`, bound unconditionally — a `when` clause
  that stopped matching on an empty workspace would hand the key back to Chromium.
- **The four left sidebars share one slot.** `toggleSidebarState` / `normaliseSidebars` /
  `openLeftSidebar` in `packages/workbench/src/layout.ts` own the rule; `deserializeWorkspace`
  applies it too, so a workspace saved with all four open cannot restore the stacked layout.
  `App.tsx` renders a single `<LeftSidebar>`. `revealInLibrary` goes through `normaliseSidebars`.
- `#subjectOr` gives a command a message a person can act on; the graph button uses it (`U05`).

## Traps

- **Dockview hides an inactive tab's × until hover** (`visibility: hidden`). A Playwright
  `click()` will not reveal it — hover the tab first. This is dockview's normal model, not the
  `U03` defect, which was about *reach*: the × landed at x=1681 in a strip ending at 1441.
- **Dockview relayouts from a ResizeObserver.** After closing a sidebar the reader's new width
  arrives a frame later — poll, don't read `boundingBox()` immediately.
- **The recorded transcript cannot produce a proposal.** `librarian-stream.jsonl` predates the
  front matter the task now asks for. Tests stage proposals through the real `AgentWorkspace`
  and `ProposalReader` — see `tests/e2e/support/librarian.ts`.
- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string. See `main/handlers.ts`.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- E2E env: `WR_DATABASE_PATH`, `WR_ZOTERO_DATA_DIR`, `WR_MARKDOWN_ROOT`, `WR_AGENT_ROOT`,
  `WR_BACKGROUND` — all real runtime modes, no test-only branch in the app.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build any of milestone 4 — `docs/MILESTONE4.md` is written and its tags
are deliberately **not** armed in the verifier; arming them now would make it demand milestone 4
of a loop working on milestone 3. Show an Electron window. Let the renderer send or receive a
filesystem path. Emit the promise before the audit.
