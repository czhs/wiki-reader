# Next action

## Now

**The desk board.** `N06` — a question's page holds hand-placed cards and the arrangement
survives restart — and `N07` — a dropped file becomes a card without leaving the researcher's
disk. Both E2E, both on the notebook panel that now exists
(`apps/desktop/src/renderer/notebook-panel.tsx`).

Fieldstation's rule is worth copying: positions are stored **only once a card has been
dragged**. A default position is not a decision and should not be recorded as one. A dropped
file stays where it is on disk — the board records a reference, because a notebook that copies
gigabytes of PDFs into its own store has stopped being local-first in the way that matters.

After notebooks: library curation `B01`–`B04`, then `G`, then `K`.

**Done so far in milestone 4:** `N01`–`N05` (migration 007, the page, hypotheses as entities,
evidence as ordinary typed links) and `N08` (the door from the queue).

## What exists now, so you don't rebuild it

- `question:notebook` returns the whole page in one call: `{ question, body, hypotheses }`,
  each hypothesis carrying `supporting`/`opposing` as **resolved** links (title, location,
  `broken`). The panel needs one round trip, not four.
- `body` is markdown source. `question:writeNotebook` stores it byte for byte.
- An unwritten page reads as `blankNotebook()` from `@wr/document-model`; the row stays empty.
  Do not start storing the template — `[N01]` asserts it is not stored.
- Front matter (`description`, `tags`, `coverFileId`) goes through `question:update`, because
  it is the same row the queue draws. `coverFileId` is a `document_files` id, never a path.
- `notebookSections()` parses a body's sections from the AST, for an outline.
- The panel is a Dockview tab (`kind: 'notebook'`, keyed by question id in
  `panelSubjectKey` — keyed by kind alone, the second question revealed the first one's page).
  It sets its own tab title once the page loads.
- The queue row's title is the door: `queue-open-<id>` runs `COMMAND_IDS.openNotebook`.
- **Setting a cover has no UI yet.** The page displays one and the channel stores one; picking
  a local image is the same mechanism `B02` and `G04` need, so it lands with them.

## The one hard part of `N07`, already scouted

A dropped file has a path, and **the renderer must never see one**. `File.path` is gone in
Electron 32+; `webUtils.getPathForFile(file)` replaced it and exists in 33.4.11
(`electron.d.ts:17709`). The bridge exposes exactly one `invoke` and one `subscribe`, and that
invariant is not negotiable — so do **not** add a third function.

The shape that keeps both: **the preload registers the `dragover`/`drop` listeners itself.**
Preload shares the DOM but not the renderer's JS world, so it can call `getPathForFile` and
forward the path over the existing `wr:invoke` channel; the renderer learns about the new card
from the channel's answer, never from a path. The precedent for "main knows the path, the
renderer knows a name" is the notes-folder chooser (`index.ts:127-136`, `corpus:folder`).

`B02` needs the same mechanism plus `dialog.showOpenDialog`, so build it once.

## Traps

- **A cover is a file id.** The renderer builds `rrfile://<id>`; `[N03]` asserts no path
  reaches it. Do not add a path field to make the panel simpler.
- **A race test that only fails half the time is not a guard.** The accept race reproduced 3
  times in 6 as a plain `Promise.allSettled` pair; it is on a gate now, and the first gate
  released its writer too early to open the window at all. Check both directions by mutation.
- **A failing Playwright test is very slow here.** A green suite is ~2 minutes; one failure can
  push a file past 15. Long durations mean failures, not a hang.
- **A main-process string ending in the bare word `import`, followed by another string
  literal, breaks the build** — electron-vite's CJS shim lands inside the string.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **A fix is not delivered until `pnpm package` has run** and `/Applications/wiki-reader.app`
  is replaced. If a report contradicts a green criterion, check the installed build's date.

## Also open

Seven minor audit findings, recorded in `docs/SECURITY.md` and `reports/AUDIT.md`, in the
order they are worth doing. `11` — a child that ignores SIGTERM wedges the librarian
permanently (`runner.ts:175-215` settles only on `close`/`error`, so `busy` stays true and
every later pass is refused) — is the only one that breaks a feature outright. Then `13` (no
cap on harvested proposals), `14` (`A03`'s observable is sound by ordering, not
construction), `8`, `10`, `12`, `15`.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 4 — `docs/SPEC.md` is still later. Show an Electron
window. Let the renderer send or receive a filesystem path. Modify `~/Zotero/zotero.sqlite`:
milestone 4 edits the library, which is the first time that invariant has anything to resist.
