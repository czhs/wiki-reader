# Next action

## Now

**`B01` is green on tests that assert the behaviour the milestone now forbids. Fix that with
`B05` — they are the same feature.** Then `K01`–`K03`, then the milestone-4 audit. `N09`–`N11`
are done; the verifier is at 146/152 with a clean tree.

### `B01` was re-specified after it was built, and nothing was rebuilt

`docs/MILESTONE4.md` was rewritten by commit `16ab5ac` (2026-07-28 23:09), *after* the
implementation in `9441870`:

- the criterion became **"A removed document leaves the library, and importing its collection
  again brings it back"** — and the verifier's own description changed with it;
- the doc says plainly: *"Whatever recorded the old behaviour goes, list included. Assert the
  round trip."*

The code and its tests still encode the old spec: the tombstone is honoured even under
`force`, `tests/integration/library-curation.test.ts` has **`[B01] a removed document is not
brought back by the next import`**, the library sidebar has a `Removed` section
(`panels.tsx:1386`) and there is a `library:restoreDocument` channel. `verify_completion.py`
matches on the *tag*, not the description, so all of it is green.

**The decision to make first.** "Importing its collection again brings it back" reads two ways:

1. *Any* import covering the item clears the tombstone — no blacklist at all, which is what
   "nothing to maintain" says, but a routine full sync then resurrects everything removed.
2. Only an import **scoped to a collection holding the item** clears it — a removal survives
   routine syncs, and naming the collection (which is exactly `B05`'s one action) is the way
   back. This is what "find the collection, import it, it returns" describes, and it makes
   `B05` the door `B01` points at.

Reading 2 is the one these two criteria fit together under; read `docs/MILESTONE4.md` lines
14–19 and 79–83 before committing to it. Either way the `Removed` list and
`library:restoreDocument` go, and the three `[B01]` tests asserting "not brought back" are
rewritten around the round trip.

### `B05` — a Zotero collection imported in one action

- **Renderer.** Each row of `ZoteroScopePicker` (`panels.tsx:990`) gets an Import action
  calling `zotero:import { collection: option.name }` — the channel already takes it. Ticking a
  row must stay a *scope* pick; importing one must not touch the remembered scope. Lift
  `ImportFromZotero`'s runner (`panels.tsx:931`) into a shared hook so the ECONNREFUSED remedy
  wording has one home.
- **How the E2E sees a real import.** Zotero is not running and the client's endpoint is fixed
  (`DEFAULT_ZOTERO_ENDPOINT`, `client.ts:24`). Bind a fixture server to an ephemeral loopback
  port — a Node `http` server whose handler delegates to `fixtureFetch`
  (`packages/zotero-adapter/test/fake-api.ts`), with `children` relocated onto the temp Zotero
  dir exactly as `createWorkspace` does — and point the app at it with a new
  **`WR_ZOTERO_ENDPOINT`**, read in `index.ts` beside `WR_ZOTERO_DATA_DIR` and passed as
  `zoteroEndpoint`. **Validate it is loopback** (127.0.0.1/localhost) so the variable cannot
  redirect the importer off-machine; Zotero's own port is a pref, so a custom local endpoint is
  honest production configuration rather than a test hook. Do *not* bind 23119: a Zotero
  someone starts would collide, and the test would read their real library.
- **What to assert.** Remove a document (`RemoveFromLibrary`), then import the collection that
  holds it in one action, and find it back in the library — `B01`'s round trip and `B05`'s one
  action on the same path. `collectionIdsForDocument` (`repositories/organisation.ts:67`) gives
  the collection to click, read before launch.

### Then

`K01`–`K03` — E2E. Linking two documents from the reader, a note made from the reader, and
every keybinding being discoverable. The mechanisms exist; nothing points at them.

## What exists now, so you don't rebuild it

- **The journal is a workspace page** (`N09`): panel kind `journal`, singleton, descriptor
  carries nothing — a page always opens on today. `COMMAND_IDS.openJournal`; the activity
  button is lit by an open journal panel. Three left sidebars now (library, questions,
  librarian).
- **The day's entry is a block notebook** (`N11`): `journal-blocks.ts` parses the day's one
  markdown document into text/code/image blocks and puts it back; every commit writes the whole
  day and re-parses the answer, so the stored markdown is the authority. The commands margin is
  the day's *code* blocks, derived — there is no command store. Test ids: `journal-block-<i>`
  (`data-block-type`), `journal-block-editor-<i>`, `journal-add-text`, `journal-add-code`,
  `journal-commands`, `journal-command-<i>`.
- **The calendar starts at `journal.projectStart()`** (`N10`) — this database's creation day
  (`MIN(schema_migrations.applied_at)`, as a *local* day), or an older entry. `firstDate` is
  gone from `journal:loggedDates`.
- **An E2E can give a workspace a past**: `seedJournalEntry(workspace, date, markdown)` in
  `tests/e2e/support/workspace.ts`, before `launchApp`.
- **A node's container is `GraphNode.parent`** (`G06`), set only when that document is in the
  same bounded answer. **Highlighting selects the highlight**, and nothing clears
  `selectedAnnotationId`, so a document-seeded graph needs a restart.
- **Card art**: `apps/desktop/src/main/card-art.ts`, one host, off by default;
  `graph-panel.tsx` must contain no `https://` and not the host — a test asserts it.

## Traps

- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 minutes; one failure can push
  a file past 15. Long durations mean failures, not a hang.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` now carries `N01`–`N11`, `B01`–`B04` and `G01`–`G06`**
  (installed 2026-07-29 00:00; the previous bundle is kept as
  `.wiki-reader-superseded-20260729-000047.app`, and the instance the researcher is running
  holds the old inodes until they restart it).

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
