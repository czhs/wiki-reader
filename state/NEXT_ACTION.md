# Next action

## Now

**`G03`, then `G04`, `G05`, `G06`, then `K`.** `G01`/`G02` are green. `docs/MILESTONE4.md` order.

- `G03` — integration. A display name is **not** `documents.title`: the next import overwrites
  the title silently. Give the node its own name — a column, or a `graph.displayName` entry
  keyed by entity beside `graph.view.settings` — and assert the document's title is unchanged
  after setting one, *and* still unchanged after a re-import.
- `G04` — E2E. An icon from a local image, served over `rrfile://`. `LocalFileLibrary.add`
  already admits one path and mints a document; an icon is that plus a reference from the node.
- `G05` — integration. Card art off by default, one allow-listed host, cached to disk, **and
  the second request must not leave the machine**. The main process fetches; the renderer never
  does. `README.md` must name both network exceptions.
- `G06` — E2E. Compound nodes. The work is in the query returning parentage, not in drawing.
  `GraphNode` would grow a `parentId`; `graph.ts`'s traversal already knows an annotation's
  document (`EntityResolver.describe` returns `documentId`).

## What exists now, so you don't rebuild it

- **The graph's view state is persisted, and split in two on purpose.** `graph.view.settings`
  (spacing, labels, depth) is application-wide; `graph.view.viewports` is keyed by
  `seedType seedId` and holds the 64 most recently moved. Both are `settings` rows behind
  `GraphViewRepository` (`packages/database/src/repositories/graph-view.ts`), reached on
  `graph:getView` / `graph:setViewSettings` / `graph:setViewport`. See `state/DECISIONS.md`.
- **`depth` is gone from `LinkGraphPanelSchema`** and from `openLinkGraph`'s args. The panel's
  query depth is the persisted setting. Don't put a second copy back on the descriptor.
- **The panel keeps the old graph on screen while it re-queries**, so changing a setting adjusts
  the view instead of blanking it. Only a panel with no graph at all shows the loading state.
- **A removal is a tombstone.** `removed_at` on `external_references` (migration 009);
  `library:listRemoved` / `library:restoreDocument` put it back.

## Traps

- **Never accept a filesystem path on a `wr:invoke` channel.** The renderer can invoke any
  channel in the contract; a path parameter is an arbitrary-file-read. `wr:drop` is the
  exception and is not on the bridge.
- **`no-useless-assignment`** fires on `let x = ''` filled inside a `try` and read after it.
  Declare `let x: T | undefined` instead. `pnpm lint` is a verifier gate.
- **React registers `wheel` passively on the root**, so `onWheel` cannot `preventDefault`.
  The graph attaches its own listener with `{ passive: false }` — keep it that way.
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 minutes; one failure can push
  a file past 15. Long durations mean failures, not a hang.
- **A main-process string ending in the bare word `import`, followed by another string
  literal, breaks the build** — electron-vite's CJS shim lands inside the string.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` carries `N01`–`N08` and `B01`–`B04`, not `G01`/`G02`.**
  Repackage and replace it before claiming any later fix is delivered.

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
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
