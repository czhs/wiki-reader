# Next action

## Now

**`N07` — a dropped file becomes a card without leaving the researcher's disk.** The board it
lands on now exists (`N06` is green): `apps/desktop/src/renderer/desk-board.tsx`, a card per
`question-references-*` edge, positions in `card_positions` written only on drag.

After `N07`: library curation `B01`–`B04`, then `G`, then `K`.

**Done in milestone 4:** `N01`–`N06`, `N08`.

## What exists now, so you don't rebuild it

- `question:notebook` returns `{ question, body, hypotheses, cards }` in one call. A card *is*
  the edge — `linkId` is its identity — so `link:delete` takes it off the board and the
  position cascades with it. There is no cards table and there must not be one.
- `question:placeCard { questionId, linkId, x, y }` records a position, and is called **only
  at the end of a drag**. `position: null` means never moved; the board lays those out with
  `defaultSpot(index)` and stores nothing. `data-placed` says which is which in the DOM.
- The board div carries `data-wr-drop-question="<questionId>"` (`DROP_QUESTION_ATTRIBUTE`)
  already — it is there for the preload's drop listener to find.
- Topic `notebook:changed { questionId, reason, added }` is declared and the panel already
  subscribes to it and reloads only its cards. **Nothing publishes it yet** — `N07` does.
- `reloadBoard()` deliberately does not call `load()`: a card arriving must not replace a
  half-typed body with what was last saved.

## The hard part of `N07`

`File.path` is gone in Electron 32+; `webUtils.getPathForFile(file)` replaced it and is
available in a sandboxed preload. So **the preload registers the `dragover`/`drop` listeners
itself** — it shares the DOM but not the renderer's JS world — reads the question id off the
`data-wr-drop-question` ancestor, and forwards paths to main.

**Do not send that path over `wr:invoke`.** The renderer can invoke any channel in the
contract, so a channel taking a path would let a compromised renderer add `~/.ssh/id_rsa` to
the library and then read it back over `rrfile://`. Use a *second* `ipcMain.handle` channel
(e.g. `wr:drop`) that the bridge does not expose — the renderer cannot address it, and the
handler still lives in `router.ts`, which is the invariant that matters ("all `ipcMain.handle`
calls in the single router module"). The bridge still exposes exactly two functions.

A dropped file is outside every allowed root, so `rrfile://` will refuse its bytes until the
path is *admitted*: persist the exact realpaths handed over by the OS picker/drop and check
them alongside the roots. Do not add the dropped file's whole directory. `B02` needs the same
admission plus `dialog.showOpenDialog`, so build it once.

## Traps

- **A card is an edge.** No cards table, no second relationship mechanism.
- **A default position is not a decision.** Nothing writes `card_positions` on render.
- **A failing Playwright test is very slow here.** A green suite is ~2 minutes; one failure can
  push a file past 15. Long durations mean failures, not a hang.
- **A main-process string ending in the bare word `import`, followed by another string
  literal, breaks the build** — electron-vite's CJS shim lands inside the string.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **A fix is not delivered until `pnpm package` has run** and `/Applications/wiki-reader.app`
  is replaced.

## Also open

Seven minor audit findings, in `docs/SECURITY.md` and `reports/AUDIT.md`. `11` — a child that
ignores SIGTERM wedges the librarian permanently (`runner.ts:175-215`) — is the only one that
breaks a feature outright. Then `13`, `14`, `8`, `10`, `12`, `15`.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 4. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite`.
