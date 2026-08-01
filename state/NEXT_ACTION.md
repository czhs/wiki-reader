# Next action

## Now

**Milestone 6 is complete, verified and shipped.** `python3 scripts/verify_completion.py` →
**181/181 in ~209s**, `MILESTONE COMPLETE`; `WR_BACKGROUND=1 pnpm package` ran and the bundle
was installed at `/Applications/wiki-reader.app` (built 2026-08-01T08:28, 352M). All of
`S01`–`S03`, `E01`–`E03`, `V01`–`V04`, `I01`, `R01`, `O01` are green, with 103 e2e and 773 unit
tests; the audit is closed (one critical, six major, each fix watched to fail when reverted) and
its section is at the top of `reports/AUDIT.md`.

**There is no milestone 7 document.** Everything past milestone 6 lives in `docs/SPEC.md` and is
still later — don't build it. If you are an autonomous loop with nothing assigned: do not start
new feature work. The useful work that is already sanctioned is an improvement pass over the open
entries in `reports/DESIGN_GAPS.md` — **1** (the postage-stamp graph; the entry says why it is not
a same-afternoon fix — four places hard-code 500/350 as "the middle"), **5** (its hover remedy
contradicts a decision in `shared-ui/styles.css`; a different shape is proposed), **7** (and a new
command now costs a guide chapter, by design), **13** (`DocumentLedgerHighlight.links` already
carries the number), **16**, **19**, and the vision-alignment four **20–23** (search indexes
everything that was read and nothing that was written; the paper has no way out of the app; the
desk is a bibliography the page never prints; a journal that begins today draws a month with one
box in it). None of those has a `Descision:` line, so each is a proposal — the researcher decides
before it is built.

Eighteen milestone-6 minors, twenty-five milestone-5 ones and eleven milestone-4 ones are in
`reports/AUDIT.md` and `state/experiment_state.json`. The four worth reaching for first: an
inserted excerpt reaches the document only on blur while its card is written first, so closing the
tab keeps the card and loses the quote; a journal page open on a deleted notebook is never told; a
`[[wikilink]]` on a notebook page always says "not written yet"; and the caret lands at the end of
any block containing a formula (`P05`'s failure, because `textContent` includes KaTeX's
`<annotation>` TeX). Seven milestone-3 minors in `docs/SECURITY.md`; `11` (a child ignoring
SIGTERM wedges the librarian) is the only one that breaks a feature.

## What milestone 6 changed, for whoever writes near it

**The guide is maintained, and it fails the build.** `Cmd+Shift+U`. Chapters live in
`packages/workbench/src/guide.ts` and hold prose and **ids only** — every title and chord the page
shows is read out of the registries when it draws, like `menus.ts`. Three things keep it honest:
`guideCoverage` runs against the live `CommandRegistry` on mount, so a command no chapter names
fails `guide.test.ts` *and* is drawn in a warning band; `PANEL_CONTROLS` declares the features that
are not commands, each panel carries `data-control="<id>"`, and `tests/integration/guide-controls.
test.ts` reads the renderer's source and requires the two sets to be equal **both ways** (and
forbids a computed `data-control={…}`); every `ContextMenuKind` must be covered. **Adding a command
or a panel widget without touching the guide breaks the build.** Motion is inline SVG plus
keyframes in `guide.css` — never a library, never a CDN — and every drawing's static attributes are
its resting state so `prefers-reduced-motion` switches it all off.

**A context menu is `packages/workbench/src/menus.ts`**: a table of command **ids** per surface;
`buildContextMenu` reads the title, category and chord back out of the two registries. Never add an
action to a menu — add a command, then its id. An entry is dropped when its `when` fails, when the
target cannot supply an argument it `requires`, or when the thing is not one of its `forTypes`;
those three are the only filters. `COMMAND_IDS` lives in `command-ids.ts` (re-exported from
`workbench.ts`) so the table can name a command without a cycle. A menu offers neither discard nor
delete on a notebook: those are the queue's, guarded and in that order. `question:delete` refuses a
notebook that is not discarded, which is why the control appears only on the discarded shelf.

**One rule decides what an inline construct counts as**: `INLINE_CONSTRUCT_RE` in
`@wr/document-model`, shared by `projectText` (which flattens with it) and `renderMarkdown` (which
builds its atoms from it). Two spellings is how a sentence containing `$x$` became unhighlightable
and a highlight over one stopped painting — the projection is what a quote is cut from and the fold
is what it is matched against, so they are one rule or they are a bug. A formula is drawn as MathML
and projected as TeX, which no shared regex can fix, so `MarkdownReaderView` reads a selection that
*touches* one back out of the DOM through `data-tex`; a formula is atomic there for the same reason
`foldBlock` will not paint into the middle of one.

**`graph:overview`'s annotation branch drives from `degrees`, never from `documents`** — the join
went 9s at 3,000 papers, and `[F01]`'s guard now fails if any lookup of that CTE is by kind alone.
`link:create`, `link:delete` and `hypothesis:attachEvidence` all announce through
`notebooksTouchedBy`, so a notebook page open beside a reader hears about its own claims; the
page's reload keeps the **draft** and takes everything else fresh. `notebook:changed` carries
`'attach'`, `'deleted'`, `'link'`, `'drop'` and `'page-drop'`. `link:findForDocument` answers
`{ entries, highlights }` — the second array is the file's own marked sentences.
`IntegrationWorkspace` records what was published (`publishedOn`), so a test can ask what a channel
said rather than infer it from a view.

The notebook page is the journal's block editor promoted, not a second one: `blocks.tsx` is the
editor, `block-source.ts` is its pure half, and both surfaces own only a markdown document. LaTeX
is a vendored KaTeX in MathML, parsed back into React elements — never an HTML string, never a CDN.
An excerpt is a blockquote plus an `annotation://` link (`packages/document-model/src/excerpt.ts`)
with a real `question-references-annotation` edge beside it; `RenderOptions.internalLinks` is the
chip that makes those links navigate. `COMMAND_IDS.sendToNotebook` (`Cmd+Alt+S`) opens
`NotebookPicker` in `overlays.tsx` and writes through `question:attach`; a card *is* that edge, so
a menu offering "send to a notebook" runs that command rather than growing a second path.
`linkTypesFor` has `→ hypothesis` branches — widen that function, never a call site.

The wiki draws a highlight once something links it: `DRAWN_KINDS` excludes the
`annotation-belongs-to-document` edge every highlight is born with, so "has a degree here" *is*
"the researcher connected this sentence to something" — the same exclusion keeps `REDRAWS_THE_MAP`
honest. The graph filter and the saved-page zoom lever (`ArticleReaderPanelSchema.zoom`) are **panel
controls, not commands**, like the graph's depth and spacing. `data-snapshot-scale` is fit × lever,
and is still the only honest way to click inside the archive frame. `.wr-blocks` is `flex: 1 0 auto`
and the shrink is load-bearing: an explicit `min-height` replaces the automatic minimum size, so
with shrink on, a page longer than the panel is squeezed into the room left over. `Sections`
(`notebook.outline`) addresses blocks **by ordinal**, because each block renders through its own
`renderMarkdown` and two blocks reading `## Method` are both slugged `method` while
`notebookSections` calls the second `method-1`; order is the only thing the two agree on.

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

## Traps

- **`reports/AUDIT.md` is parsed by first match.** The milestone-6 section is at the top and is
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
- **A failing Playwright test is very slow here.** All 103 green ≈ 3 min; one failure pushes a
  single file past 15.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **The verifier needs a clean tree and HEAD on `origin/main`**, so it can only go green after
  the checkpoint commit is pushed. A full run is ~210s.

## The swap, for whoever does it next

`WR_BACKGROUND=1 pnpm package` → `apps/desktop/release/mac-arm64/`, then
`mv /Applications/wiki-reader.app /Applications/.wiki-reader-superseded-<yyyymmdd-hhmmss>.app`
and `ditto` the fresh one in. Never delete: the researcher may be running the old bundle and holds
its inodes until they restart. Seven superseded bundles are on disk at ~350M each, safe to remove
once the app has been restarted. Milestone 5 closed 2026-08-01 (verifier 167/167); milestone 6
closed 2026-08-01 (verifier 181/181, bundle 2026-08-01T08:28 installed).

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 6. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
