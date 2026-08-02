# Next action

## Now

**Milestone 7 is closed and shipped.** All twenty-two criteria are built and driven from the
running app with the demo library seeded — P06–P12 (the notebook is one document), H05–H09 (a
link is just a link), F04–F07 (one graph), U09–U11 (the shell obeys the hand), D03/B06/B07
(shown, not told). The audit closed with no unresolved critical or major finding, the verifier
is green at **204/204 in 72.0s** (it was 255.8s at the milestone-6 close), and the bundle in
`/Applications/wiki-reader.app` is the 2026-08-01T21:25 build — the researcher is running this
work, not the milestone-6 one. `reports/DESIGN_GAPS.md` is retired.

**So there is nothing owed on milestone 7.** The next context waits for the researcher's
feedback and writes `docs/MILESTONE8.md` from it — the same shape as
`docs/MILESTONE7.md`, including a **Supersessions** list, because that list is the only thing
that stops an audit calling a deliberate replacement a regression. Everything still unbuilt is
`docs/SPEC.md` and is still later; grep it, don't read it whole, and don't build ahead of a
milestone doc. Milestones 1–7 all still gate, so read milestone 7's Supersessions rule before
touching any older test.

**The E2E suite runs four workers now** (246s → 64s, `--repeat-each=3` clean at 387/387), and
its timeouts are caps rather than comfort: 60s a test, 10s an assertion, 10s an *action* —
`use.actionTimeout` is set explicitly because Playwright's own default is 30s and lowering
`expect.timeout` alone does not touch it. A spec that writes its own `timeout: 30_000` opts
back out of all of that. The one thing four workers share is Chromium's profile directory, and
`support/app.ts` passes `--user-data-dir` inside the test's own workspace to stop it; anything
new that lands beside `app.getPath('userData')` has to do the same. `docs/LOOP.md` has the
three-rung ladder — never run `pnpm test:e2e` and the verifier in one checkpoint, the verifier
*is* that run.

**Four judgements are the researcher's, not a pass's** — an alignment pass found them and left
them: the wiki's labels still interleave where two sit in the same place (the halo lifts one off
an *edge*, not off another label; placing labels rather than discs is the real answer); the
journal pop-up is nearly the whole window with one paragraph in it, which makes *Expand into a
page* mean little; the rail has three doors onto graphs and the neighbourhood panel is still its
own surface with its own controls, which `F05`'s letter allows and its sentence does not; and the
help page draws one `demo` picture for filling and clearing, on purpose, though they are
opposite acts.

**Writing near a node on any canvas**: the node is a `<g>` carrying the disc *and* its label, and
that `<g>` is the button. So anything that widens the label widens the button's bounding box and
moves its centre off the disc, into the gap where only the canvas takes a press — a label halo
drawn as a `stroke` did exactly that and `[F02]` and `[H04]` failed by clicking a node and
hitting the `<svg>`. Decorate a label with paint (`text-shadow`), never with ink. For the same
reason `.wr-graph__node:focus` is `outline: none`: the shared focus outline is drawn round that
union and leaves a rectangle over the map; the disc's own rim is what focus looks like here.

**`Workbench.navigate` is serialized, and an identical in-flight navigation is the same
navigation.** A plan is computed against the workspace as it stands and `describeEntity` is a
round trip, so two overlapping activations of one thing each found nothing to reuse and each
opened a panel: a double-click on a disc, a library row or a search hit gave two tabs of one
paper. Never bypass it by calling `#navigate` or by planning in a panel.

**Writing near the help page**: it is still the two registries printed, and now every command on
it carries a picture of its own act (`D03`). The drawings are `motions.tsx` — shared with the
guide, same ink, same keyframes in `guide.css`, same single `prefers-reduced-motion` rule — and
which one a command gets is *computed* by `commandMotion({id, category})` in `guide.ts`: a small
`MOTION_BY_COMMAND` table for the verbs a category cannot tell apart (create/delete,
open/close, link/gather, save) over a `MOTION_BY_CATEGORY` fallback that makes it total. Never
write a picture per command — that is a second registry, and the first command added without a
row in it is a blank card. A new *category* needs a `MOTION_BY_CATEGORY` row or
`commandMotionCoverage` fails `guide.test.ts`; a new chapter needs a `GuideMotion` **nobody
else uses**, because `guide.test.ts` requires the chapter motions and `GUIDE_MOTIONS` to be the
same set.

**Writing near card art**: two request shapes now, and they are gated separately. The set
listing (`setListingUrl`, `q=set:mh3 unique:art`) is JSON and has its own `LISTING_TYPES` gate
and its own cache file; `#fetchAndKeep`'s `IMAGE_TYPES` is what keeps a web page out of the
directory `rrfile://` serves from and must never be widened to admit it. Crops still go through
`artUrl(name)` — built here from a name, so no reply can turn one into a request for a whole
card. The renderer's picker is `card-art-gallery` (`data-control="graph.gallery"`), tiles drawn
over `rrfile://`; the local-image `<select>` (`graph.picture`) is a different control and `G04`
still drives it. The E2E never reaches the network: `tests/e2e/support/card-art.ts` seeds the
cache with the app's *own* `setListingUrl`/`artUrl` hashed the way the app hashes them, so a
seed that spelled its own URLs would leave the gallery quietly empty instead of failing.

**Writing near the demo library**: `apps/desktop/src/main/demo.ts`, development only —
`createServices({development})` is `!app.isPackaged`, decided once in `main/index.ts`, and
`demo:fill`/`demo:clear` refuse without it. The papers are markdown on a `demo` root ingested by
the *real* `MarkdownCorpusImporter`, which gained exactly one option (`source`) for this; that
tag is the whole of "clear it", together with the notebook and note ids in the `demo.seed`
setting, which are the two things the schema cannot answer for. Never add a bookkeeping table
for the papers — the column is the predicate. Highlights are real `createMarkdownAnchor` anchors
so they paint, and the edges between the papers are parsed wikilinks rather than written rows,
which is what makes this a demo of a library the app can actually produce. Filling twice is a
no-op by construction. `workspace.tsx` lists `demo` documents beside the notes.

**Writing near the shell**: the app's own furniture — the left sidebar, the annotations column
and the strip below — is sized by `ChromeState` (`layout.ts`): `sizes` and `minimized` per
`CHROME_PANELS`, bounded by `CHROME_BOUNDS`, read through `chromeExtent`. The bound is on the
*stored* number, never a CSS `min-width`, because the size is persisted and a floor in CSS lets
a workspace come back at a width it is not drawn at. It rides as a **defaulted `chrome` key** on
`SerializedWorkspaceSchema` — never bump `WORKSPACE_LAYOUT_VERSION` for a new key, that throws
away every saved layout. Folding is not closing: a folded panel is still open and its activity
button stays lit (`U09`), and the rail is one control wide — a second button in thirty pixels
overflows it and lands over the document. The annotations column closes through
`COMMAND_IDS.toggleAnnotationSidebar`, never by writing `sidebars` directly, so the bar cannot
disagree with the panel. The notebook page's sections fold by their headings and the jump strip
unfolds what it goes to.

**Writing near deletion**: `questions.trashed_at` (migration 015) is the bin (`U11`) and is
**not** a fourth status — a binned notebook is still `discarded` and still carries its reason,
which is what keeps `question:delete`'s discard-first precondition exactly as `I01` wrote it.
`question:delete` now *bins*; `question:restoreFromTrash` takes it back out whole;
`question:emptyTrash` is the only channel in the application that destroys a line of work, takes
no argument, and reports what went. The confirmation lives on emptying, because that is the act
that cannot be undone. `library:removeDocument` is deliberately **not** in the bin: it already
keeps the highlights and links, so it is a different act and mixing the two would mislead.

**Writing near search**: a hit is one of four things and only two are a file. `searchTarget`
(`panels.tsx`) maps each kind to the entity the workbench opens — a note has no `documentId` by
construction, which is what the old early-return swallowed. `SearchResult.snippet` is *delimited
text*, never a string to print: FTS5 wraps the match in the two private-use code points declared
in `@wr/shared-types/snippet.ts` — there, not in main-only `@wr/search`, because both ends have
to agree — and anything drawing one either maps `snippetSegments` to elements or uses
`plainSnippet`. A delimiter that reaches a screen has no glyph and draws as tofu.

**Writing a control that can be off**: `.wr-button:disabled` is in `@wr/shared-ui`, and the three
`:hover` rules are `:not(:disabled)`. Never restyle a disabled button per surface — that is how
seventeen of the eighteen came to look pressable — and never lean on it alone: `U07` is that the
*reason* stands beside the control in words.

**Writing near the graph**: there is one graph surface and it is the wiki. The `focus` panel
kind is gone — `WikiPanelSchema.focusDocumentId` is the state (null is the whole library),
`wiki` is in `RESEATED_PANEL_KINDS`, and `WikiPanel` draws `WikiPanelBody` or `FocusPanelBody`
from its descriptor. `openFocusView` and `openWiki` both write a `wiki` descriptor, so one tab
serves every file and the whole library; never write that descriptor from a panel — the way
back is `wiki-whole` running `openWiki`. A canvas's `viewBox` is the **panel's own size in CSS
pixels** and the scene's fit inside it is *held*, captured on the first measurement with a real
size and released only by Reset view (`SceneFit`, `fitInto`, `sceneCanvasProps` in
`graph-canvas.tsx`): that is `F04` — docked is a smaller window onto the same map, not a
smaller map. The fit is a separate `<g>` outside the pan-and-zoom group on purpose, so "the
panel got narrower" and "you zoomed out" stay two numbers; `centredOn` still centres on the
scene's own middle, which is why `V02` reads the same. Never re-derive a letterbox from
`getBoundingClientRect` — `toScene(fit, …)` is the one mapping. A highlight's label wraps
through `quoteLines` into `<tspan>`s (`F06`); a title stays one ellipsized line. The librarian
has no sidebar (`F07`): `COMMAND_IDS.openLibrarian` → `host.promptLibrarian()` →
`store.librarianOpen`, drawn as `LibrarianPopup` on the shared `Overlay`, opened from the
wiki's own button. `SidebarStateSchema` no longer declares `librarian`; a workspace persisted
with it still restores, because zod ignores the key.

**Writing near the link track**: nothing asks what kind of link it is. `createDocumentLink`
defaults the edge through `defaultLinkType` (`entity-links.ts`), which answers `related-to` for
everything except a claim — a hypothesis has no plain edge, because the notebook page draws
*For* and *Against* off the type, so that is the one thing the picker still asks (`E02`).
`linkTypesFor` is unchanged and still bounds an explicit type; widen it, never a call site.
`commitLink(window)` in the E2E harness is one press now, and takes a stance only for a claim.
A link is taken away by `COMMAND_IDS.deleteLink` through `UnlinkButton` (`link-actions.tsx`) —
one control on four surfaces, and `link:delete` announces, so nothing subscribes to anything.
On a canvas the drawn edge stays `pointer-events: none` and an invisible `.wr-graph__edge-hit`
band beside it takes the press, under every node: paint order answers the objection that kept
edges inert. Both in-app drags (`H08` a highlight onto a reader, `H09` between two discs) are
pointer events with a 6px threshold so the click underneath survives, and both end by running
`createDocumentLink` — never `link:create`. `wr:drop` is untouched and stays files-only.

Milestone 6 closed 2026-08-01: verifier 181/181 at 472e139, bundle 09:16 installed.

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
page's reload keeps the **draft** only for a change that did not touch the markdown, because the
block editor merges an outside append against unsaved rows. `notebook:changed` carries
`'drop'`, `'attach'`, `'link'` and `'deleted'` — `'page-drop'` went with the desk (`P06`). `link:findForDocument` answers
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
  `matchesNeedle`, `centredOn`, `panTo` and `usePanToMatches` — the last is the whole
  filter-moves-the-view effect, refs and all, so a surface supplies its matches, its positions
  and where its pan goes and nothing else. Never compute a viewport outside this module — the
  rounding and the clamping are here, and a surface with its own transform passes its own
  assertions while `data-pan-x` says otherwise. A surface's own facts ride as `data`, never as a
  second element (`dataAttrs`).
- **`ReaderFrame`, `makeHighlight` and `SelectionBar` in `panels.tsx`** are the three readers'
  shared chrome, Highlight button and right-click. A reader supplies the anchor and nothing else;
  building the anchor is the only part that is genuinely the reader's, because only the reader
  packages may touch its coordinates. A reader's menu is about the **file**, never the selected
  highlight — that decision lives in `ReaderFrame` once.
- **`Overlay`, `useCloseOnEscape`, `displayChord` and `Chord` in `overlays.tsx`** are the sheet,
  the dismissal and the printed key for every surface that shows one.
- **`usePanelDescriptor(panelId, kind)`, `useReportFailure`, `PanelParams` and `DockPanelProps`
  (`workspace.tsx`)** are what every panel component starts with: read your descriptor or draw
  nothing, and say what went wrong in the status bar. A panel that narrows a descriptor by hand
  is writing the ninth copy of a check that has one spelling.
- **`ellipsize`, `collapseWhitespace` and `shorten` (`@wr/document-model/display.ts`)** cut text
  for display, in the renderer and in main; `shorten` is the two of them in the order everything
  uses them in. `limit` is the width of the answer, ellipsis included. Never `normalizeText` for
  this: that one is versioned and every persisted anchor offset depends on it. `localDay`
  (`calendar.ts`, same package) is the researcher's calendar day, shared by the journal's page
  and `JournalRepository.start` — never slice an ISO instant at ten characters.
- **`describeResolvedLink` (`@wr/workbench/entity-links.ts`)** is the ledger's and the references
  panel's one sentence about an edge, beside `linkTypeLabel` because it *is* the vocabulary read
  out loud. `NewNotebookControl` is the one way to start a notebook, drawn on two shelves.
- **`tests/integration/support/workspace.ts`** is the harness: `new IntegrationWorkspace(prefix,
  overrides)` plus `FAKE_CLAUDE` and `sampleMarkdownAnchor`. `overrides` is handed the temp
  directory and runs on every open, so a restart gets the same wiring. `local-files.test.ts` keeps
  its own, and says why. E2E has `support/keys.ts` (press the chord the app resolved — never a
  literal), `support/archive.ts` (a selection inside the sandboxed frame) and `support/corpus.ts`;
  `packages/workbench/test/support/silent-host.ts` is the host that answers nothing.
- **`defaultSidebars()`** parses `SidebarStateSchema`; do not write the defaults out again —
  `SerializedWorkspaceSchema` and `serializeWorkspace` both go through the schema now.
  `isInTrash` and `isWorking` (`@wr/shared-types/domain.ts`) are the two questions every shelf
  asks about a notebook, and `classNames` (`@wr/shared-ui`) joins class names.

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
- **A failing Playwright test is no longer very slow here, and that was a fix.** All 129 green
  ≈ 64s at four workers; a failure now costs at most 60s rather than 180, and an action that
  never resolves 10s rather than 30. A *fixture*-level break still multiplies across the suite
  — the shell wait is 30s — so read the streamed `list` output rather than waiting it out.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **The verifier needs a clean tree and HEAD on `origin/main`**, so it can only go green after
  the checkpoint commit is pushed. It streams both suites' output now, so a kill leaves
  evidence; record its `duration_seconds` in the ledger at each milestone close.

## The swap, for whoever does it next

`WR_BACKGROUND=1 pnpm package` → `apps/desktop/release/mac-arm64/`, then
`mv /Applications/wiki-reader.app /Applications/.wiki-reader-superseded-<yyyymmdd-hhmmss>.app`
and `ditto` the fresh one in. Never delete: the researcher may be running the old bundle and holds
its inodes until they restart. Nine superseded bundles are on disk at ~350M each (3.1G, and 173G
free), safe to remove once the app has been restarted. Milestone 5 closed 2026-08-01 (verifier
167/167); milestone 6 closed 2026-08-01 (verifier 181/181, bundle 09:16); milestone 7 closed
2026-08-01 (verifier 204/204 in 72.0s, bundle 2026-08-01T21:25 installed).

**The researcher had the app open across this last swap** — a process launched 17:25 was still
running the milestone-6 bytes out of the moved-aside bundle at 21:25. So until they quit and
reopen it, feedback about "the app" is feedback about milestone 6, and a report that a
milestone-7 surface is missing is first a question about whether they have restarted. This is
the whole reason the old bundle is renamed rather than deleted.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 7 — the next milestone is a doc written from the
researcher's feedback, not a guess. Show an Electron window. Let the renderer send or receive a
filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
