# Next action

## Now

**Build the notebook panel.** `N01`–`N05` are green underneath it: migration 007, the
`question:notebook` / `question:writeNotebook` / `hypothesis:*` channels, evidence as ordinary
typed edges. Nothing in the app opens a page yet, so N01's *"edited in-app"* is only half
delivered and `N08` — the door from the queue — is what proves it.

Then `N06` (desk board, hand-placed cards, arrangement survives restart) and `N07` (a dropped
file becomes a card without leaving the researcher's disk). Both E2E, both in
`tests/e2e/`. After notebooks: library curation `B01`–`B04`, then `G`, then `K`.

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
