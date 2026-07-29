# Next action

## Now

**`N09`–`N11`, then `B05`, then `K01`–`K03`, then the milestone-4 audit.** `G01`–`G06` are
green; the verifier is at 143/152. `docs/MILESTONE4.md` order.

- `N09`/`N10`/`N11` — **the journal, and it does not exist yet.** These three were added to
  `docs/MILESTONE4.md` and armed in the verifier by the last two commits, which wrote *no
  code*. Today's journal is a sidebar (`J01`–`J03`, `tests/e2e/journal.spec.ts`). `N09` moves it
  into the workspace at a reader's width; `N10` gives it every day since the project began, one
  entry per day, empty meaning unlogged, long unlogged runs collapsed; `N11` makes the day's
  entry a Jupyter-style block notebook — the page's *main* surface, calendar and jotted commands
  beside it. Concept from Field Station (`docs/MILESTONE4.md` names the two specs); storage and
  rendering are ours. One markdown document per day, blocks as a *view* over it — no second
  store, no execution.
- `B05` — E2E. Import a Zotero collection from the library in one action. Today that is two
  actions: tick it in `ZoteroScopePicker` (`panels.tsx`), then press Import. `zotero:import`
  **already takes `{ collection }`** (`handlers.ts:363`), so the renderer work is a per-row
  action that imports that one collection without disturbing the remembered scope — share the
  ECONNREFUSED wording with `ImportFromZotero` rather than copying it. **Decide first how the
  E2E observes a real import**: Zotero is not running, the app talks to a fixed
  `127.0.0.1:23119` (`DEFAULT_ZOTERO_ENDPOINT`), and `zoteroEndpoint`/`zoteroFetch` are
  injectable only through `createTestServices` — `index.ts` reads no env var for either. So it
  is a local HTTP server on that fixed port serving the recorded fixtures (real client, real
  HTTP, recorded bytes — but it collides with a Zotero someone starts), or a new
  `WR_ZOTERO_ENDPOINT` (a production configuration path added for a test, which is audit
  finding `12`'s complaint about `WR_AGENT_EXECUTABLE`). `[UX09]` settles for asserting the
  click reaches the importer and comes back with the remedy; `B05` says *imported*.
- `K01`–`K03` — E2E. Linking two documents from the reader, a note made from the reader, and
  every keybinding being discoverable. The mechanisms exist; nothing points at them.

## What exists now, so you don't rebuild it

- **A node's container is `GraphNode.parent`** (`G06`, `state/DECISIONS.md` 2026-07-29), set in
  `GraphRepository.neighbourhood` from `EntityResolver.describe(...).documentId` and **only**
  when that document is in the same bounded answer. `@wr/graph` turns it into Cytoscape
  parentage, orbits children round their container instead of their hop ring, and `groupBoxes`
  derives each box from the *final* positions — after spacing, never before.
- **Highlighting selects the highlight, and the graph opens on what is selected.** Nothing ever
  clears `selectedAnnotationId`, so a test that highlights and then wants a document-seeded
  graph must restart the app. `[G06]` does exactly that.
- **Wikilink edge ids are re-derived on every start.** A link id read in one launch names a row
  the next launch has replaced; document ids are stable.
- **Card art is `apps/desktop/src/main/card-art.ts`.** One host, off by default, reached from
  the graph toolbar. `cardArt:fetch` takes a **name**, never a URL. `graph-panel.tsx` must
  contain no `https://` and not the host: a test asserts it.
- **A node's picture is `graph_node_icons`** (011), its name `graph_node_names` (010), both
  keyed by `(entity_type, entity_id)`; an icon is a `document_files` id, never a path.
- **An image gets into the library by drop**: `dropFileOn` in `tests/e2e/support/drop.ts`.
- **A removal is a tombstone** — `removed_at` on `external_references` (009).

## Traps

- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **`no-useless-assignment`** fires on `let x = ''` filled in a `try` and read after it.
  `pnpm lint` is a verifier gate — run it after writing tests.
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 minutes; one failure can push
  a file past 15. Long durations mean failures, not a hang.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` carries `N01`–`N08` and `B01`–`B04`, not `G01`–`G06`.**
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
