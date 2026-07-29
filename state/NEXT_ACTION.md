# Next action

## Now

**`K01`–`K03`, then the milestone-4 audit.** Everything else in `docs/MILESTONE4.md` is green:
the verifier is at 147/152 with a clean tree, and the only failures are those three plus
`audit: audited milestone 4`.

### `K01` — two documents linked from the reader, with a typed relationship

The edges exist (`links`, typed, directed — `link:create` and the references panel read them),
but nothing in a reader panel makes one. Decide the gesture first: the reader knows its own
`documentId`, and the other end has to be named without a file path — the library sidebar's
selection, or a picker over `library:listDocuments`. The relationship type has to be *chosen*,
not defaulted, or the criterion's "typed" is decoration.

### `K02` — a note made from the reader lands linked to what it was made from

`note:create` and `NoteLink`/`EmbeddedExcerpt` exist (`packages/note-editor`). What is missing
is the command that makes a note *from here* and writes the edge in the same action. If a
highlight is selected, the note should hang off the annotation, not just the document.

### `K03` — every action with a keybinding is discoverable without knowing the key

`packages/workbench` owns the command + keybinding registry, so the list is already data. What
does not exist is a surface that shows it (a command palette, or a shortcuts sheet). Assert the
*coverage*: every registered keybinding appears with its command's label — a test that reads
the registry and checks the rendered list is the honest version, not a hand-written table.

### Then: the milestone-4 audit

`audit: audited milestone 4` fails until `reports/AUDIT.md` is an audit of *this* milestone at a
commit reachable from HEAD. The brief is in `docs/LOOP.md`.

## What exists now, so you don't rebuild it

- **A removal is "not now"** (`B01`, `B05`, done 2026-07-29). The tombstone in
  `external_references` stands, but a **whole-library** import (`force` included) passes a
  removed item over while an import **scoped to a collection holding it** restores it —
  `ImportSummary.documentsRestored` counts them, and `index-fts` is re-queued. There is no
  `Removed` sidebar section, no `library:listRemoved`, no `library:restoreDocument`. Each row of
  `ZoteroScopePicker` has an Import button (`zotero-scope-import`, `data-collection`) that does
  **not** touch the remembered scope. `useZoteroImport()` in `panels.tsx` is the one runner.
- **`WR_ZOTERO_ENDPOINT`** names another *loopback* port for the Zotero API
  (`main/zotero-endpoint.ts`; refused values are logged and the default stands). The E2E suite
  serves the recorded fixtures over a real socket with it: `startZoteroApi(workspace.zoteroChildren)`
  in `tests/e2e/support/zotero-api.ts`, and `launchApp(workspace, { WR_ZOTERO_ENDPOINT })`.
- **The journal is a workspace page** (`N09`–`N11`): panel kind `journal`, a day is a block
  notebook over one markdown document, the commands margin is derived from its code blocks.
- **An E2E can give a workspace a past**: `seedJournalEntry(workspace, date, markdown)` before
  `launchApp`.
- **A node's container is `GraphNode.parent`** (`G06`), set only within one bounded answer.

## Traps

- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 minutes; one failure can push
  a file past 15. Long durations mean failures, not a hang.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` carries `N01`–`N11`, `B01`–`B05`, `G01`–`G06`** (installed
  2026-07-29 00:29). The running instance holds the old inodes until the researcher restarts it.
  Three `.wiki-reader-superseded-*.app` bundles are beside it, ~347M each — deletable once the
  app has been restarted, but that is theirs to say.

## Also open

Seven minor audit findings, in `docs/SECURITY.md` and `reports/AUDIT.md`. `11` — a child that
ignores SIGTERM wedges the librarian permanently (`runner.ts:175-215`) — is the only one that
breaks a feature outright. Then `13`, `14`, `8`, `10`, `12`, `15`.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 4. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
