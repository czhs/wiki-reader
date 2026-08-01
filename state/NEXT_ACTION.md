# Next action

## Now

**Milestone 5 is open.** `docs/MILESTONE5.md` has the criteria. `P01`–`P05` and `F01`–`F03` are
**done and green**; `D01`/`D02` are armed in the verifier but not built. Still to build:

- `H01`–`H04` — highlighting on saved web pages (**broken today, find why first**), per-highlight
  links, a per-file ledger, link targets picked from the graph.
- `D01`/`D02` — the keyboard crosses the workspace; a help page rendered from the registries.

Nothing has been packaged since milestone 4 (bundle 2026-07-31T19:24). `pnpm package` and the
`/Applications` swap are still owed before any milestone-5 promise.

## What P01–P05 changed, and what will surprise you

- **A journal belongs to a notebook.** `journal_entries` is keyed `(notebook_id, date)`
  (migration 012), and a journal link endpoint is `<notebook id>:<date>` —
  `journalEntityId` / `parseJournalEntityId` in `@wr/shared-types`. Every `journal:*` channel
  names its notebook; none can be called without one.
- **"Question" is retired vocabulary, not a retired identifier.** The `questions` table and the
  `question:*` channels keep their names. `[P01] no surface calls a notebook a question` in
  `tests/e2e/notebooks.spec.ts` reads the screen; it will fail on any new user-facing string.
- **The activity bar's Journal button has no notebook in hand.** It resolves one: the notebook
  page or journal you are on, else the first in the queue, else it says to make one and opens
  the directory. `wr.openJournal` itself always requires a `questionId`.
- **A picture is dropped, never picked.** `data-wr-drop-journal="<notebook>:<date>"` on the
  blocks; the preload sends it; the main process appends the `rrfile://` block to the day's
  markdown and publishes `journal:changed`. No dialog — background mode cannot answer one.

## What F01–F03 changed, and what will surprise you

- **Two new panel kinds, `wiki` and `focus`**, and two new channels. The old `link-graph` panel
  is untouched — it still serves `W09`/`G01`–`G06` and is still the only seeded graph view.
- **`graph:overview` is the one unseeded graph channel.** Its `nodeLimit` is *required*, not
  defaulted, which is what keeps `[W10] exposes no channel that asks for the graph without a
  scope and a bound` true; both new channels are now in that loop. It draws files and notes
  only, never annotations, and never an edge derived from one.
- **`graph:focus` carries two caps.** Highlights and connected files are elided separately — a
  single cap would let node-id ordering starve the connected files on a heavily marked paper.
  A neighbour reached only through a highlight is flagged `throughAnnotation`.
- **One tab serves every file.** `panelSubjectKey` keys `focus` on its *kind*, and
  `RESEATED_PANEL_KINDS` (`packages/workbench/src/panel-targets.ts`) makes a `reveal` plan carry
  a descriptor that `applyPlan` applies. Readers are deliberately *not* in that list. If you add
  a panel whose descriptor *is* its subject, it probably belongs there.
- **`H04` is this view with a selection callback.** The focused view already distinguishes
  `data-action="open"` from `data-action="refocus"` on every node; picking a target is a third.
- Corpus E2E helpers now live in `tests/e2e/support/corpus.ts`. `tests/e2e/graph.spec.ts` still
  has its own older copies — fold them in when you next touch that file.

## Also open

Eleven milestone-4 minors in `reports/AUDIT.md` and `state/experiment_state.json` — first two
worth doing: `[N06]`'s guard (the un-dragged default already satisfies it) and the card-art
8 MB cap checked after `arrayBuffer()`. Seven milestone-3 minors in `docs/SECURITY.md`; `11`
(a child ignoring SIGTERM wedges the librarian) is the only one that breaks a feature.

## Traps

- **`reports/AUDIT.md` is parsed by first match.** Its header must claim milestone 5 before the
  verifier can pass; never write the phrase "unresolved critical/major" in that file.
- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green ≈ 2 min; a failure pushes a file past 15.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 5. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
