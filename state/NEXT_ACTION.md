# Next action

## Now

**The milestone-4 audit.** Every criterion in `docs/MILESTONE4.md` is green — `K01`–`K03`
landed 2026-07-29 — and the verifier's only remaining failure is
`audit: audited milestone 4`. The brief is in `docs/LOOP.md`.

`reports/AUDIT.md` currently audits milestone 3 at commit `f6fbede`. It has to become an audit
of *this* milestone at a commit reachable from HEAD. Write the lens into `reports/` beside the
existing ones (`audit-m3-security.md` and friends), then fold its findings into
`reports/AUDIT.md` under a milestone-4 section with an `Audited-commit`.

The verifier also requires **no unresolved critical or major findings**, so anything major the
audit turns up has to be fixed, not filed.

### Then: ship it

`pnpm package` → `apps/desktop/release/mac-arm64/wiki-reader.app`, replace
`/Applications/wiki-reader.app`. The researcher runs the bundle, not the tree; the installed
one carries `N01`–`N11`, `B01`–`B05`, `G01`–`G06` and **not** `K01`–`K03`.

## What exists now, so you don't rebuild it

- **`K01`–`K03` are three thin surfaces over mechanisms that already shipped** (details and
  reasoning in `state/DECISIONS.md`, 2026-07-29):
  - `overlays.tsx` holds `CommandList` (`K03`) and `LinkPicker` (`K01`). The command list is a
    **live rendering of the registries**, never a table — `data-chord` on each row is
    canonical, the `<kbd>` beside it is for people. Its way in is the **status-bar
    `status-commands` button**, deliberately not a chord.
  - `ReaderActions` in `panels.tsx` is the strip above every reader: `reader-link` and
    `reader-new-note`. `data-note-source` on the second says whether the note would hang off
    the selected highlight or the document.
  - Four new commands: `wr.showCommands`, `wr.linkToDocument`, `wr.createDocumentLink`,
    `wr.newNoteFromHere` — plus `⇧⌘P`, `⌥⌘L`, `⌥⌘N` in `DEFAULT_KEYBINDINGS`.
  - `WorkbenchHost` grew `showCommands`, `promptDocumentLink`, `createDocumentLink`,
    `createNoteFrom`. A new fake host in a test must implement all four.
  - `linkTypeLabel` and `DOCUMENT_LINK_TYPES` live in `packages/workbench/src/entity-links.ts`;
    references rows now say *how* two things are related.
- **`@wr/workbench` is a root devDependency** so E2E specs can assert against the real
  registry. That is how `[K03]` avoids being a hand-written shortcuts sheet.
- **A removal is "not now"** (`B01`, `B05`): a whole-library import passes a removed item over,
  an import scoped to a collection holding it restores it. No Removed list, no tombstone UI.
- **`WR_ZOTERO_ENDPOINT`** names another *loopback* port; the E2E suite serves the recorded
  fixtures over a real socket with it (`tests/e2e/support/zotero-api.ts`).
- **The journal is a workspace page** (`N09`–`N11`), and `seedJournalEntry` gives a workspace
  a past. **A node's container is `GraphNode.parent`** (`G06`).

## Traps

- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 minutes; one failure can push
  a file past 15. Long durations mean failures, not a hang.
- **An annotation has two edges, not one**: the document it lives in, plus anything made from
  it. `[K02]` asserts both.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

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
