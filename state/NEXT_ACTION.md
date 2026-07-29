# Next action

## Now

**`N11`, then `B05`, then `K01`–`K03`, then the milestone-4 audit.** `N09`/`N10` are green;
the verifier is at 146/152. `docs/MILESTONE4.md` order.

- `N11` — **the day's entry as a block notebook.** The pure core is done and tested:
  `apps/desktop/src/renderer/journal-blocks.ts` (`parseBlocks`/`serializeBlocks`/`classify`/
  `codeBody`, 8 tests in `journal-blocks.test.ts`). What is left is the page: the day is still
  edited as one `<textarea data-testid="journal-entry-text">` in `journal-panel.tsx`. Replace it
  with a list of blocks — click a block to edit its markdown source, commit on blur, serialize
  the whole day and `journal:write` it, then re-parse from what came back so the stored
  document stays the authority. `+ text` and `+ code` insert; there is deliberately **no
  `+ image`** — an image block renders (`rrfile://`, bounded by the app's `img-src` CSP) but
  getting bytes into one would need the `wr:drop` path extended, which `N11` does not ask for.
  The **commands margin** is derived, not stored: the day's *code* blocks listed beside the
  notebook with copy-to-clipboard. Text/image blocks render through `renderMarkdown` from
  `@wr/markdown-reader` (no HTML strings). `[J01]`, `[J03]` and `[N10]` type into
  `journal-entry-text` and will need to drive a block instead.
- `B05` — E2E. Import a Zotero collection from the library in one action. `zotero:import`
  **already takes `{ collection }`** (`handlers.ts:363`), so the renderer work is a per-row
  action in `ZoteroScopePicker` (`panels.tsx`) that imports that one collection without
  disturbing the remembered scope. **Decide first how the E2E observes a real import**: Zotero
  is not running, the app talks to a fixed `127.0.0.1:23119`, and `zoteroFetch` is injectable
  only through `createTestServices`. Either a local HTTP server on that fixed port serving the
  recorded fixtures, or a new `WR_ZOTERO_ENDPOINT` (a production path added for a test — audit
  finding `12`'s complaint about `WR_AGENT_EXECUTABLE`).
- `K01`–`K03` — E2E. Linking two documents from the reader, a note made from the reader, and
  every keybinding being discoverable. The mechanisms exist; nothing points at them.

## What exists now, so you don't rebuild it

- **The journal is a workspace page** (`N09`): panel kind `journal`, singleton, descriptor
  carries nothing — a page always opens on today. `COMMAND_IDS.openJournal`; the activity
  button is lit by an open journal panel, not by a sidebar boolean. There are three left
  sidebars now (library, questions, librarian).
- **The calendar starts at `journal.projectStart()`** (`N10`) — the database's own creation
  day (`MIN(schema_migrations.applied_at)`, as a *local* day), or an older entry if the journal
  carries one. `journal:loggedDates` answers `projectStart`, never `firstDate`.
- **An E2E can give a workspace a past**: `seedJournalEntry(workspace, date, markdown)` in
  `tests/e2e/support/workspace.ts`, before `launchApp`.
- **A node's container is `GraphNode.parent`** (`G06`), set only when that document is in the
  same bounded answer. **Highlighting selects the highlight**, and nothing clears
  `selectedAnnotationId`, so a document-seeded graph needs a restart.
- **Card art is `apps/desktop/src/main/card-art.ts`** — one host, off by default;
  `graph-panel.tsx` must contain no `https://` and not the host: a test asserts it.
- **A removal is a tombstone** — `removed_at` on `external_references` (009).

## Traps

- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 minutes; one failure can push
  a file past 15. Long durations mean failures, not a hang.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` carries `N01`–`N08` and `B01`–`B04`, not `G01`–`G06` or
  `N09`/`N10`.** Repackage and replace it before claiming any later fix is delivered.

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
