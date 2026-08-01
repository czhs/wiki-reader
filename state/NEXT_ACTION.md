# Next action

## Now

**Milestone 5 is open.** `docs/MILESTONE5.md` has the criteria. `P01`–`P05`, `F01`–`F03` and
`H01`–`H04` are **done and green**. Still to build:

- `D01`/`D02` — the keyboard crosses the workspace; a help page rendered from the registries.
  `D01` owns the keybinding *scheme*. Nothing since `K03` has claimed a chord, and the
  milestone-5 commands (`wr.openWiki`, `wr.openFocusView`, `wr.openLedger`,
  `wr.openNotebookDirectory`) are deliberately unbound waiting for it.

Nothing has been packaged since milestone 4 (bundle 2026-07-31T19:24). `pnpm package` and the
`/Applications` swap are still owed before any milestone-5 promise.

## What P01–P05 changed

- **A journal belongs to a notebook.** `journal_entries` is keyed `(notebook_id, date)`
  (migration 012); a journal link endpoint is `<notebook id>:<date>` (`journalEntityId`).
  No `journal:*` channel can be called without naming its notebook.
- **"Question" is retired vocabulary, not a retired identifier.** The `questions` table and the
  `question:*` channels keep their names. `[P01] no surface calls a notebook a question` reads
  the screen; it fails on any new user-facing string.
- **A picture is dropped, never picked** — `data-wr-drop-journal="<notebook>:<date>"`, handled
  in the preload. No dialog: background mode cannot answer one.

## What F01–F03 changed

- **Two panel kinds, `wiki` and `focus`**, and two channels. The old `link-graph` panel is
  untouched and is still the only *seeded* graph view.
- **`graph:overview` is the one unseeded graph channel.** `nodeLimit` is required, not
  defaulted, which is what keeps `[W10]` true. `graph:focus` carries *two* caps so neither
  half can starve the other.
- **One tab serves every file.** `panelSubjectKey` keys `focus` on its kind and
  `RESEATED_PANEL_KINDS` (`packages/workbench/src/panel-targets.ts`) makes a `reveal` plan
  carry a descriptor. Readers are deliberately excluded. A new panel whose descriptor *is* its
  subject probably belongs there.
- Corpus E2E helpers live in `tests/e2e/support/corpus.ts`; `tests/e2e/graph.spec.ts` still has
  older copies — fold them in when you next touch that file.

## What H01–H04 changed, and what will surprise you

- **A saved page's selection comes from the main process.** The archive frame is `sandbox=""`
  with an opaque origin and no script, so `getSelection`, `contentDocument` and `postMessage`
  are all closed *by design* — wiring the article panel like the markdown one cannot work.
  `reportSnapshotSelection` (`main/index.ts`) reads Chromium's `context-menu` params and
  publishes `webpage:selection`. Nothing about the sandbox or the CSP moved; the reasoning is
  in `state/DECISIONS.md` and one row of `docs/SECURITY.md`.
- **Web highlights are listed beside the page, never painted on it** — painting needs a script
  in that frame. Each chip carries `data-resolved`, resolved against `document:getSnapshotText`.
  Stamp `readerMode: 'original'` on any web selection: the article descriptor still says
  `'readability'`, a rendering this app does not have, and anchors never resolve across modes.
- **Link endpoints are entity refs everywhere.** `promptEntityLink`/`createEntityLink`,
  `store.linkDraftSource`, and `linkTypesFor(source, target)` as the one vocabulary the picker
  offers and the command checks. Command *ids* keep their old names, as `question:*` did.
- **Never offer `annotation-belongs-to-document` as a choice.** Every highlight is born with
  that edge and `LinksRepository.create` returns the existing row on a repeat — it would report
  success for a link it never wrote. Manual is `annotation-references-document`.
- **`link:create`/`link:delete` publish `library:changed` with reason `link`.** Every graph
  surface and the ledger redraw on it; a new write to the link table should do the same.
- **`ledger` is a third re-seated panel kind.** Its query hides *derived* edges with both ends
  inside the file: containment is bookkeeping, a manual edge between two of its highlights is
  a claim and stays.
- **The picker's graph tab is `WikiPanelBody` + `FocusPanelBody`, not a copy.** Both take an
  optional picking prop and `SceneNode.action` gained `'pick'`. A test with the wiki page *and*
  the picker open sees two `wiki-node-<id>` — scope to `[data-testid="link-picker"]`.

## Also open

Eleven milestone-4 minors in `reports/AUDIT.md` and `state/experiment_state.json`. Seven
milestone-3 minors in `docs/SECURITY.md`; `11` (a child ignoring SIGTERM wedges the librarian)
is the only one that breaks a feature.

## Traps

- **`reports/AUDIT.md` is parsed by first match.** Its header must claim milestone 5 before the
  verifier can pass; never write the phrase "unresolved critical/major" in that file.
- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **Playwright's hit-testing is wrong inside the scaled archive frame.** Compute the point from
  `data-snapshot-scale` and click with `page.mouse`; `locator.click` lands on `<body>`.
- **A failing Playwright test is very slow here.** All 76 green ≈ 2.5 min; one failure pushes a
  single file past 15.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 5. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
