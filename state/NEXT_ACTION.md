# Next action

## Now

**The milestone-3 audit. Every criterion is tagged and green; nothing else is left to build.**
`U06` was the last one. Do not emit the promise until the audit lands.

## The audit — the one thing between here and done

**The verifier will say complete and be wrong about exactly one check.**

Its audit gate is satisfied by `reports/AUDIT.md` naming a commit reachable from HEAD; that
commit is `4420cea`, a milestone 2 one, and the file's own title is "milestones 1 and 2".
**Nobody has read milestone 3.** Do not take the promise on that.

The brief is in `docs/LOOP.md`. Point it at the librarian, where the new risk is:

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

When it is written, `reports/AUDIT.md` needs `Audited-commit: <sha>` naming a real ancestor of
HEAD, a `## Findings` section, and no placeholder text. Unresolved critical or major findings
block completion.

## What just changed (U06)

Clicking a highlight opens its comment, in the reader, without the sidebar.

- **`PdfReaderView` hit-tests the click coordinates** against the rectangles it just painted.
  The overlay stays `pointer-events: none` on purpose — giving it pointer events would make the
  text under a highlight unselectable, so you could never highlight a passage twice.
- **`MarkdownReaderView` delegates one `onClick`** and reads `data-annotation-id` off the
  `<mark>` under the pointer, which keeps `render.tsx` a pure function of the source.
- Both guard on `!selection.isCollapsed`: the click that *ends a drag* must not open whatever
  the pointer stopped over.
- **`ReaderHighlightEditor`** in `panels.tsx` is shared by both panels and drives
  `createAnnotationEdits` — the same definition the sidebar uses. That is the `[W11]` lesson:
  a second copy of those handlers is how the tests all stayed green while the panel was dead.
- `.wr-reader-popover` floats bottom-centre like `.wr-selection-bar`, for the same reason —
  taking height from the scroller reflows the page being read (`[UX03]`).

## Traps

- **`aria-hidden` + `pointer-events: none` means `locator.click()` will hang** on a painted PDF
  highlight. Click its coordinates with `window.mouse.click` instead — see `clickHighlight`.
- **A failing Playwright test is very slow on this machine** (screenshot + error context). A
  full green suite is ~2 minutes; one failure can push a single file past 15. Long durations in
  a log mean failures, not a hung machine.
- **Dockview hides an inactive tab's × until hover** (`visibility: hidden`) — hover first.
- **Dockview relayouts from a ResizeObserver** — poll, don't read `boundingBox()` immediately.
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
