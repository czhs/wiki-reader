# Next action

## Now

**`G05`, `G06`, then `K01`–`K03`.** `G01`–`G04` are green. `docs/MILESTONE4.md` order.

- `G05` — integration. Card art off by default, one allow-listed host, cached to disk, **and
  the second request must not leave the machine**. The main process fetches; the renderer never
  does. `README.md` must name both network exceptions. A fetched icon needs a `document_files`
  row to be servable — decide where the cached file's document lives (a library row per icon
  would be noise; `state/DECISIONS.md` 2026-07-28 leaves this open on purpose).
- `G06` — E2E. Compound nodes. The work is in the query returning parentage, not in drawing.
  `GraphNode` would grow a `parentId`; `graph.ts`'s traversal already knows an annotation's
  document (`EntityResolver.describe` returns `documentId`).
- `K01`–`K03` — E2E. Linking two documents from the reader, a note made from the reader, and
  every keybinding being discoverable. The mechanisms exist; nothing points at them.

## What exists now, so you don't rebuild it

- **A node's picture is `graph_node_icons`** (migration 011), keyed by `(entity_type,
  entity_id)` and holding a `document_files` id — never a path, exactly like a notebook's
  `cover_file_id`. `graph:setNodeIcon` refuses a file whose mime type is not an image;
  `graph:iconChoices` feeds the toolbar's Icon picker. `GraphNode.iconFileId` is what the panel
  draws, clipped into the disc, with `data-icon-loaded` set only once the bytes arrive.
- **The image gets into the library by drop**, not by naming a path: `dropFileOn` in
  `tests/e2e/support/drop.ts` is the shared mechanism for all three drop criteria.
- **A node's name is `graph_node_names`, never `documents.title`** (migration 010). `GraphNode`
  carries `displayName` beside `title`; `graph:setNodeName` with `null` clears it.
- **The graph's view state is split in two on purpose.** `graph.view.settings` (spacing, labels,
  depth) is application-wide; `graph.view.viewports` is keyed by `seedType seedId`, 64 most
  recent. Both behind `GraphViewRepository`. `depth` is **not** on `LinkGraphPanelSchema`.
- **The panel keeps the old graph on screen while it re-queries**, so changing a setting adjusts
  the view instead of blanking it.
- **A removal is a tombstone.** `removed_at` on `external_references` (migration 009).

## Traps

- **Never accept a filesystem path on a `wr:invoke` channel.** `wr:drop` is the exception and is
  not on the bridge.
- **`no-useless-assignment`** fires on `let x = ''` filled inside a `try` and read after it.
  Declare `let x: T | undefined`. `pnpm lint` is a verifier gate — run it after writing tests.
- **React registers `wheel` passively on the root**; the graph attaches its own `{passive:false}`
  listener. Keep it that way.
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 minutes; one failure can push
  a file past 15. Long durations mean failures, not a hang.
- **A main-process string ending in the bare word `import`, followed by another string
  literal, breaks the build** — electron-vite's CJS shim lands inside the string.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` carries `N01`–`N08` and `B01`–`B04`, not `G01`–`G04`.**
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
