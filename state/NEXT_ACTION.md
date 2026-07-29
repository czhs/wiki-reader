# Next action

## Now

**Library curation, `B01`–`B04`.** The whole notebook section of milestone 4 is green
(`N01`–`N08`). Next in `docs/MILESTONE4.md`'s order: a library you curate, then `G`, then `K`.

- `B01` — deleting the row is the obvious implementation and it is wrong: the next Zotero
  import sees an item it has no record of and recreates it. Write a tombstone in
  `external_references` and have the importer honour it. Assert remove **then re-import**.
- `B02` — **most of this already exists.** `LocalFileLibrary.add()` in
  `apps/desktop/src/main/local-files.ts` adds a file where it lies and admits its path. What is
  missing is the way in: `dialog.showOpenDialog` in `index.ts` (refused in background mode, as
  `chooseNotesFolder` is) and a control in the library sidebar.
- `B03` — soft-delete, as `deleted_at` already does elsewhere. Annotations and links are the
  researcher's own work and are not Zotero's to take away.
- `B04` — hash `~/Zotero/zotero.sqlite` before and after every one of the above.

## What exists now, so you don't rebuild it

- **A card is an edge.** `question:notebook` returns `{ question, body, hypotheses, cards }`;
  a card's identity is its `linkId`, and `link:delete` takes it off the board with the
  position cascading. There is no cards table and there must not be one.
- **A position is only what a hand chose.** `question:placeCard` is called at the end of a
  drag and nowhere else; `position: null` means never moved. Nothing writes `card_positions`
  on render.
- **A file added from disk is not copied.** `LocalFileLibrary.add(path)` is idempotent by
  path, mints a document with `source: 'local'`, queues extraction for a PDF, and admits that
  one path — remembered in settings under `library.admittedFiles` and restored by
  `localFiles.restore()` in `createServices`.
- **The drop is the preload's.** `webUtils.getPathForFile` there, forwarded on `wr:drop`,
  which the bridge does not expose. `receiveDrop` in `handlers.ts` ingests, attaches the card
  and publishes `notebook:changed`.

## Traps

- **Never accept a filesystem path on a `wr:invoke` channel.** The renderer can invoke any
  channel in the contract; a path parameter is an arbitrary-file-read (name it, add it to the
  library, read it back over `rrfile://`). `B02`'s dialog must stay in the main process.
- **Admit files, never their folders.** `SwappableRoots.admit` takes one path. The `[N07]`
  test asserts a sibling in the same folder is still refused after a restart.
- **`setPointerCapture` on pointerdown kills the click** — the compatibility mouse events get
  retargeted at the capturing element, so a button inside it never fires. Capture on movement.
- **A failing Playwright test is very slow here.** A green suite is ~2 minutes; one failure can
  push a file past 15. Long durations mean failures, not a hang.
- **A main-process string ending in the bare word `import`, followed by another string
  literal, breaks the build** — electron-vite's CJS shim lands inside the string.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` was repackaged at the end of this session**, carrying
  `N01`–`N08`. Replace it again before claiming any later fix is delivered.

## Also open

Seven minor audit findings, in `docs/SECURITY.md` and `reports/AUDIT.md`. `11` — a child that
ignores SIGTERM wedges the librarian permanently (`runner.ts:175-215`) — is the only one that
breaks a feature outright. Then `13`, `14`, `8`, `10`, `12`, `15`. Milestone 4 needs its own
audit before the gate can pass (`audit: audited milestone 4` fails until then).

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 4. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `B01`–`B04` are the first work
that has anything to resist.
