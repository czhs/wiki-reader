# Next action

## Now

**The graph you can work, `G01`–`G06`.** `B01`–`B04` are green, so the library section of
milestone 4 is done. Next in `docs/MILESTONE4.md`'s order: `G`, then `K`.

- `G01`/`G02` — E2E. The graph panel is `apps/desktop/src/renderer/graph-panel.tsx`
  (Cytoscape). Pan/zoom state and the settings (spacing, labels, depth) need somewhere to
  live: `workspace_layouts.panel_state_json` already exists and is per-panel, or `settings`
  if the view should be one view rather than one per panel. Decide, then write it down.
- `G03` — a display name is **not** `documents.title`: the next import overwrites the title
  silently. A separate column or a `graph.displayName` setting keyed by entity; assert the
  document's title is unchanged after setting one.
- `G04` — an icon from a local image, served over `rrfile://`. `LocalFileLibrary.add` already
  admits one path and mints a document; an icon is that plus a reference from the node.
- `G05` — card art off by default, one allow-listed host, cached to disk, **and the second
  request must not leave the machine**. The main process fetches; the renderer never does.
  `README.md` must name both network exceptions.
- `G06` — compound nodes. The work is in the query returning parentage, not in drawing.

## What exists now, so you don't rebuild it

- **A removal is a tombstone.** `removed_at` on `external_references` (migration 009).
  `db.library.remove()` soft-deletes the document, tombstones its provider keys and drops its
  search entries in one transaction; `ZoteroImporter.writeDocument` reads the tombstone before
  the version check **and before `force`**, and skips the item whole.
- **A removal keeps the work.** Annotations, links and board positions are untouched;
  `library:listRemoved` lists what went, `library:restoreDocument` puts it back and clears the
  tombstone. Adding a removed file again restores it rather than doing nothing.
- **A file arrives two ways.** `library:addFiles` opens the dialog in the main process
  (refused in background mode, like `chooseNotesFolder`); a drop on the library sidebar sends
  `questionId: null` on `wr:drop`, marked by `data-wr-drop-library`.
- **The graph already hides removed documents** — `SOFT_DELETED` in
  `packages/database/src/repositories/graph.ts` covers `documents`.

## Traps

- **Never accept a filesystem path on a `wr:invoke` channel.** The renderer can invoke any
  channel in the contract; a path parameter is an arbitrary-file-read.
- **A dialog cannot be driven in background mode** — the E2E suite sets `WR_BACKGROUND=1` and
  a modal would wedge an unattended run. That is why `B02`'s E2E goes in through the drop and
  the dialog is covered by integration with the chooser injected.
- **A nested `<button>` is invalid markup** and browsers move it out of the row. `ListRow`
  takes an `action` rendered beside it, never inside.
- **A failing Playwright test is very slow here.** A green suite is ~2 minutes; one failure can
  push a file past 15. Long durations mean failures, not a hang.
- **A main-process string ending in the bare word `import`, followed by another string
  literal, breaks the build** — electron-vite's CJS shim lands inside the string.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` still carries `N01`–`N08` only.** Repackage before
  claiming `B01`–`B04` are delivered to the researcher.

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
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` now hashes it before and
after every library edit and will catch it.
