# Next action

## Now

**`G06`, then `K01`–`K03`, then the milestone-4 audit.** `G01`–`G05` are green; the verifier is
at 142/148. `docs/MILESTONE4.md` order.

- `G06` — E2E. Compound nodes. The work is in the query returning parentage, not in drawing.
  `GraphNode` would grow a `parentId`; `graph.ts`'s traversal already knows an annotation's
  document (`EntityResolver.describe` returns `documentId`).
- `K01`–`K03` — E2E. Linking two documents from the reader, a note made from the reader, and
  every keybinding being discoverable. The mechanisms exist; nothing points at them.
- `N10`/`N11` — new criteria. The journal page (`N09`) becomes Field Station's journal: a
  Jupyter-style block notebook as the main surface, day calendar and commands as side sections.
  The `N10`/`N11` note in `docs/MILESTONE4.md` says where the concept comes from. Concept, not
  implementation; the details are yours to decide.

## What exists now, so you don't rebuild it

- **Card art is `apps/desktop/src/main/card-art.ts`.** One host (`CARD_ART_HOST`), off by
  default behind `graph.cardArt` in `settings`, reached from the graph toolbar's `Card art…`
  control. `cardArt:fetch` takes a **name**, never a URL — don't widen it. Cached art lives in
  a `card-art` directory beside the database — a **fixed** allowed root, created eagerly in
  `createServices` because a root that does not exist yet stays in the allow-list *lexically*
  and `/var` vs `/private/var` then refuses every picture in it. `graph-panel.tsx` must contain
  no `https://` and not the host: a test asserts it, and it has already caught one comment.
- **Every cached picture hangs off one document with `source = 'card-art'`.** `documents.list`,
  `count`, `countCreatedSince` and `listImages` all exclude that source unless asked for it by
  name. `state/DECISIONS.md` 2026-07-28 says why.
- **A node's picture is `graph_node_icons`** (migration 011), keyed by `(entity_type,
  entity_id)` and holding a `document_files` id — never a path. `graph:setNodeIcon` refuses a
  file whose mime type is not an image; `graph:iconChoices` feeds the toolbar's Icon picker.
- **The image gets into the library by drop**, not by naming a path: `dropFileOn` in
  `tests/e2e/support/drop.ts` is the shared mechanism for all three drop criteria.
- **A node's name is `graph_node_names`, never `documents.title`** (migration 010).
- **The graph's view state is split in two on purpose.** `graph.view.settings` is
  application-wide; `graph.view.viewports` is keyed by `seedType seedId`, 64 most recent.
- **A removal is a tombstone.** `removed_at` on `external_references` (migration 009).

## Traps

- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.** A wrong field reads as every
  assertion failing on `undefined`.
- **`no-useless-assignment`** fires on `let x = ''` filled inside a `try` and read after it.
  `pnpm lint` is a verifier gate — run it after writing tests.
- **React registers `wheel` passively on the root**; the graph attaches its own
  `{passive:false}` listener. Keep it that way.
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 minutes; one failure can push
  a file past 15. Long durations mean failures, not a hang.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **`/Applications/wiki-reader.app` carries `N01`–`N08` and `B01`–`B04`, not `G01`–`G05`.**
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
