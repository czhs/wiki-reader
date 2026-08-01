# Next action

## Now

**Milestone 6 is open — but a workflow in an interactive session is building it (started
2026-08-01).** If you are an autonomous loop reading this: stand by, don't start milestone-6
work, don't touch the tree. `docs/MILESTONE6.md` has the criteria; the researcher's
`Descision:` lines in `reports/DESIGN_GAPS.md` are the spec's voice. Center: the notebook
becomes paper-grade (blocks, LaTeX, excerpts), reading flows into notebooks, highlights appear
on the wiki with snippets, graph search-in-place, every calendar day rendered, a saved-page
zoom lever, discard vs delete, and a maintained feature guide with motion. `S01`–`S03`,
`E01`–`E03`, `V01`–`V04`, `I01`, `R01`, `O01` are armed in the verifier.

**Every milestone-6 criterion is green** — `S01`–`S03`, `E01`–`E03`, `I01`, `V01`–`V04`, `R01`
and now `O01`; 100 e2e and 759 unit tests passing. What is left is the milestone-6 audit header
in `reports/AUDIT.md`, then `verify_completion.py`, then `pnpm package` and the swap.

**The guide (`O01`), for whoever adds the next feature.** `Cmd+Shift+U`. Chapters live in
`packages/workbench/src/guide.ts` and hold prose and **ids only** — every title and chord the
page shows is read out of the registries when it draws, like `menus.ts`. Three things keep it
honest and all three fail loudly: `guideCoverage` runs against the live `CommandRegistry` on
mount, so a command no chapter names fails `guide.test.ts` *and* is drawn on the page in a
warning band; `PANEL_CONTROLS` declares the features that are not commands, each panel carries
`data-control="<id>"`, and `tests/integration/guide-controls.test.ts` reads the renderer's source
and requires the two sets to be equal **both ways** (and forbids a computed `data-control={…}`);
every `ContextMenuKind` must be covered. **Adding a command or a panel widget without touching
the guide now breaks the build.** Motion is inline SVG plus keyframes in `guide.css` — never a
library, never a CDN — and every drawing's static attributes are its resting state so
`prefers-reduced-motion` can switch it all off.

The notebook page is the journal's block editor promoted, not a second one: `blocks.tsx` is the
editor, `block-source.ts` (was `journal-blocks.ts`) is its pure half, and both surfaces own only
a markdown document. LaTeX is a vendored KaTeX in MathML, parsed back into React elements —
never an HTML string, never a CDN. An excerpt is a blockquote plus an `annotation://` link
(`packages/document-model/src/excerpt.ts`) with a real `question-references-annotation` edge
beside it; `RenderOptions.internalLinks` is the chip that makes those links navigate.

**The menus, for whoever writes the guide (`O01`).** A context menu is `packages/workbench/src/
menus.ts`: a table of command **ids** per surface, and `buildContextMenu` reads the title, the
category and the chord back out of the two registries when it draws. Never add an action to a
menu — add a command, then its id. An entry is dropped when its `when` fails, when the target
cannot supply an argument it `requires`, or when the thing is not one of its `forTypes`; those
three are the only filters, and `menus.test.ts` asserts every id is registered. `COMMAND_IDS`
now lives in `command-ids.ts` (re-exported from `workbench.ts`) so the table can name a command
without a cycle. Three commands were added for the block menu — `editBlock`, `addTextBlock`,
`addCodeBlock`, category **Writing** — and the guide has to cover them. A menu offers neither
discard nor delete on a notebook: those are the queue's, guarded and in that order.

**What the second pass added, for whoever writes the guide (`O01`) and the menus (`R01`).**
`COMMAND_IDS.sendToNotebook` (`Cmd+Alt+S`) opens `NotebookPicker` in `overlays.tsx` and writes
through `question:attach`; a card *is* that edge, so a context menu offering "send to a
notebook" should run the same command rather than growing a second path. `linkTypesFor` now has
`→ hypothesis` branches, so the link picker and `createDocumentLink` both admit a claim — widen
that function, never a call site. `question:delete` refuses a notebook that is not discarded,
which is why the control appears only on the discarded shelf; a menu must not offer it
elsewhere. `link:findForDocument` answers `{ entries, highlights }` — the second array is the
file's own marked sentences, so gap 13's link count on an annotation card already has its
number. `notebook:changed` now carries `'attach'` and `'deleted'` as well as
`'drop'`/`'page-drop'`.

**What "Seen and found" changed.** The wiki draws a highlight once something links it:
`DRAWN_KINDS` excludes the `annotation-belongs-to-document` edge every highlight is born with, so
"has a degree here" *is* "the researcher connected this sentence to something" — and that same
exclusion is what keeps `REDRAWS_THE_MAP` honest. The graph filter and the saved-page zoom lever
(`ArticleReaderPanelSchema.zoom`) are **panel controls, not commands**, like the graph's depth and
spacing — so `O01`'s guide will not find them by enumerating `commands.all()`, and the criterion
asks it to cover the features. `data-snapshot-scale` is now fit × lever, and is still the only
honest way to click inside the archive frame.

Milestone 5 closed 2026-08-01: verifier 167/167, bundle 2026-08-01T00:46 installed.

**The swap, for whoever does it next.** `pnpm package` → `apps/desktop/release/mac-arm64/`, then
`mv /Applications/wiki-reader.app /Applications/.wiki-reader-superseded-<yyyymmdd-hhmmss>.app`
and `ditto` the fresh one in. Never delete: the researcher was running the old bundle (PID 7789)
at swap time and holds its inodes until they restart. Six superseded bundles are on disk at
~347M each, safe to remove once the app has been restarted.

## The keyboard, in one paragraph

Four families chosen by the *verb*: `Cmd+Shift+<letter>` goes to a page, `Cmd+P` goes to a file,
the function row follows links, `Cmd+Alt+<letter>` makes something. A page's letter is the first
letter of its name still free, left to right. `KeybindingRule.family` is a declared label, never
inferred from modifiers — `Cmd+Shift+W` closes a group and shares its modifiers with every page
chord. A new page adds one row to `DEFAULT_KEYBINDINGS` and appears on the help page, which is
rendered from `commands.all()` and `keybindings.all()` and can never be a hand-written sheet.
The rest is `state/DECISIONS.md`.

## Where things live

A unification sweep folded the duplicates onto what already existed. Before writing near them:

- **`graph-canvas.tsx` is all three graph surfaces' drawing.** `sceneKey`, `SceneNode`,
  `SceneEdge`, `SceneGroupBox`, `SceneViewportGroup`, `useSceneGestures` — controlled, so the
  neighbourhood panel can persist its viewport per seed (`G01`) while the wiki page and the
  focused view keep theirs in the panel. `useSceneView` is that hook plus local state, and returns
  to rest when its subject changes. It is also where the filter lives (`V02`): `SceneFilter`,
  `matchesNeedle`, `centredOn`, `panTo`. Never compute a viewport outside this module — the
  rounding and the clamping are here, and a surface with its own transform passes its own
  assertions while `data-pan-x` says otherwise. A surface's own facts ride as `data`, never as a
  second element.
- **`ReaderFrame`, `makeHighlight` and `SelectionBar` in `panels.tsx`** are the three readers'
  shared chrome, Highlight button and right-click. A reader supplies the anchor and nothing else;
  building the anchor is the only part that is genuinely the reader's, because only the reader
  packages may touch its coordinates. A reader's menu is about the **file**, never the selected
  highlight — that decision lives in `ReaderFrame` once.
- **`Overlay`, `useCloseOnEscape`, `displayChord` and `Chord` in `overlays.tsx`** are the sheet,
  the dismissal and the printed key for every surface that shows one.
- **`ellipsize` and `collapseWhitespace` (`@wr/document-model/display.ts`)** cut text for display,
  in the renderer and in main. `limit` is the width of the answer, ellipsis included. Never
  `normalizeText` for this: that one is versioned and every persisted anchor offset depends on it.
- **`describeResolvedLink` (`@wr/workbench/entity-links.ts`)** is the ledger's and the references
  panel's one sentence about an edge, beside `linkTypeLabel` because it *is* the vocabulary read
  out loud. `NewNotebookControl` is the one way to start a notebook, drawn on two shelves.
- **`tests/integration/support/workspace.ts`** is the harness: `new IntegrationWorkspace(prefix,
  overrides)` plus `FAKE_CLAUDE` and `sampleMarkdownAnchor`. `overrides` is handed the temp
  directory and runs on every open, so a restart gets the same wiring. `local-files.test.ts` keeps
  its own, and says why. E2E has `support/keys.ts` (press the chord the app resolved — never a
  literal), `support/archive.ts` (a selection inside the sandboxed frame) and `support/corpus.ts`;
  `packages/workbench/test/support/silent-host.ts` is the host that answers nothing.
- **`defaultSidebars()`** parses `SidebarStateSchema`; do not write the defaults out again.

## Also open

`reports/DESIGN_GAPS.md` is rewritten around what milestone 6 closed. Every gap the researcher
decided on (2, 3, 8–12, 14, 15) is built and is now a table row, not an entry. The milestone-6
improvement pass fixed **4** (Back and Forward read the same context key their chords do —
`ContextKeyService` already published it, which is what the gap said was missing), **6** (a
legend on the wiki, drawn with the canvas's own classes) and the half of **8** the decision line
did not cover (`Begins` carries the day it resolved to). Still open and still proposals: **1**
(the postage-stamp graph — the entry now says why it is not a same-afternoon fix: four places
hard-code 500/350 as "the middle"), **5** (its hover remedy contradicts a decision recorded in
`shared-ui/styles.css`; a different shape is proposed), **7** (and a new command now costs a
guide chapter, by design) and **13** (`DocumentLedgerHighlight.links` already carries the
number). Four new ones, **16–19**: a new notebook's page is four headings with no invitation to
write under them; the guide's chip row flattens commands, panel controls and menus into one kind
of thing; the wiki's header promises highlights the map usually will not have; two library rows
can be the same paper twice with nothing to tell them apart.

Twenty-five milestone-5 minors and eleven milestone-4 ones in `reports/AUDIT.md` and
`state/experiment_state.json`. The three worth reaching for first: a picture dropped while a
block editor is open discards the unsaved text; the ledger truncates at 400 rows in silence;
neither half of the `H01` transport (`document:getSnapshotText`, `reportSnapshotSelection`) has
a unit or integration test. Seven milestone-3 minors in `docs/SECURITY.md`; `11` (a child
ignoring SIGTERM wedges the librarian) is the only one that breaks a feature.

## Traps

- **`reports/AUDIT.md` is parsed by first match.** The milestone-5 section is at the top and is
  the only one carrying `Audited-commit:`/`Audited-milestone:`; the older sections say
  "Audited commit (milestone N):" so they cannot answer for it. Never write the phrase
  "unresolved critical/major" in that file.
- **Never `git checkout <file>` to undo a probe.** Work in progress is not staged, and it
  takes the file back to HEAD. `git add -A` first, then `git checkout-index -f <file>`.
- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **Playwright's hit-testing is wrong inside the scaled archive frame.** Compute the point from
  `data-snapshot-scale` and click with `page.mouse`; `locator.click` lands on `<body>`.
- **A right-click inside the archive frame never reaches the renderer's DOM.** It is an event in
  a sandboxed nested browsing context, and it is already spoken for: Chromium reports the frame's
  selection to the main process, which is the only way a saved page can be highlighted (`H01`).
  So the reader's chrome carries the context menu and the frame carries nothing — compose there,
  never collide.
- **Keys reach the renderer over CDP**, so a menu accelerator cannot eat one in the E2E suite —
  which is why `U01`'s other half is asserted on the menu template in `main/menu.test.ts`.
- **A failing Playwright test is very slow here.** All 81 green ≈ 2.5 min; one failure pushes a
  single file past 15.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **The verifier needs a clean tree and HEAD on `origin/main`**, so it can only go green after
  the checkpoint commit is pushed. A full run is ~170s.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 5. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
