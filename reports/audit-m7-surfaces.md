# Milestone-7 audit — links and graph

One lens over `be7508a..HEAD` (31 commits, HEAD `a912606`): **the no-kind link flow (`H05`),
the picker's second stage (`H06`), link deletion everywhere (`H07`), both drag-to-link gestures
(`H08`, `H09`), the merged wiki (`F04`, `F05`, `F06`, `F07`), the trash bin (`U11`),
search-result clicks (`U10`), the help animations (`D03`), the MH3 gallery (`B06`) and the demo
seed (`B07`)** — real behaviour, real coverage, and what happens when the library is not the
demo's eight papers.

Method: read the code and every test carrying one of those tags; ran the whole vitest suite
(**64 files, 838 tests, all green**, node 20.19.3); did not run the E2E suite. Four claims below
were *proved* rather than reasoned about, by driving `IntegrationWorkspace` against a real
database and a real `demo:fill` from a scratch harness outside the tree — the observed numbers
are quoted where they appear. `docs/MILESTONE7.md`'s Supersessions list was read first: nothing
here calls `K01`, `N06`/`N07`/`E01`, `N09`, `I01` or `V01` a regression.

What is right, briefly, so the findings are read in proportion. `H07`'s design is the best thing
in the range: one command, one `UnlinkButton`, a channel that announces, and four surfaces that
redraw without knowing about each other — and the E2E actually deletes from three of them in one
run and asserts the *other two* surfaces changed. `H09`'s `useLinkDrag` is careful in the way
this kind of gesture usually is not: window listeners rather than pointer capture, precisely so
the click underneath survives, with a test that presses a disc afterwards and proves it still
navigates. `F04` is measured in screen pixels — disc size and inter-disc distance before and
after a real Dockview tab drag — rather than believing `data-fit`. `F05` asserts the tab *count*
and the status bar's panel count, which is the only way to prove "one surface, two states"
rather than "two panels that happen to look alike". `U10` searches once and clicks three
different kinds of hit. `D03`'s coverage is computed from the two things every command declares
and checked against the live registry both ways. The findings are what those instruments do not
see.

---

## Major

### M1. `demo:clear` leaves the whole demo library in the search index, permanently

`apps/desktop/src/main/demo.ts:380-392` — the clear loop deletes the annotations' edges, the
document's edges, its external references and then `this.#db.documents.purge(documentId)`.
`search_entries` has **no foreign key to `documents`** (`packages/database/src/migrations/001_initial.ts:282-296`),
so nothing removes the index rows. `LibraryRepository.remove` is the one deletion path in the
app that gets this right (`packages/database/src/repositories/library.ts:75`, with a comment
saying exactly why); `clear()` copied `purgeOutsideRoot`'s order instead
(`apps/desktop/src/main/corpus.ts:164-177`), which has the same hole.

Measured, on a fresh workspace: `demo:fill` → `demo:clear` leaves **23 rows in `search_entries`**,
and `search:query {query: 'spacing'}` still returns **5 hits** — a `document`, an `annotation` and
three `chunk` rows, all carrying `documentId` of a purged document. The chunk rows now draw with
an *empty title*, because `SearchService` reads a chunk's name off `LEFT JOIN documents`
(`packages/search/src/search-service.ts:123-131`) and there is nothing left to join to. Clicking
one runs `searchTarget` → `workbench.navigate` at a document that does not exist.

There is no reindex or index-clear channel anywhere in `handlers.ts`, and a second
fill/clear cycle mints new ids rather than overwriting `UNIQUE (entity_type, entity_id)` — so the
residue is unremovable from inside the app and accumulates. `B07`'s promise is "one action clears
it, and leaves everything else exactly as it was"; the integration test asserts documents,
notebooks and notes (`tests/integration/demo.test.ts:110-145`) and never re-runs the query it
made twenty lines earlier at `:102`. Scope is development builds only (`available` is
`!app.isPackaged`), which is what keeps this out of Critical.

### M2. A deleted wikilink edge comes back on the next corpus scan, silently

`MarkdownCorpusImporter.import` collects **every** file it walked, unchanged ones included
(`apps/desktop/src/main/corpus.ts:214-232`), and hands all of them to `#syncWikilinks`, which
calls `links.replaceDerived` per file (`:386-392`). `main/index.ts:328` runs that import on every
launch. So a `document-references-document` edge taken away with the × on the map
(`apps/desktop/src/renderer/wiki-panel.tsx:498-501`), or with the ledger's unlink button
(`apps/desktop/src/renderer/ledger-panel.tsx:80-86`), is re-created at the next start.

Measured: fill the demo, `link:delete` a `document-references-document` edge (`origin: derived`,
`generator: wikilink`) — 1 edge → 0 — then run the importer again: **1 edge**, back.

Nothing on any of the four surfaces distinguishes a derived edge from a manual one before the
press, and `describeResolvedLink` prints "references" for both. In the demo corpus every line
between two papers is one of these, so on the library the milestone tells you to develop
against, `H07` is a button that appears to work and is undone by a restart. The `H07` E2E only
ever deletes edges it made itself through the picker
(`tests/e2e/linking.spec.ts:255-259`), all `related-to`/`manual`, so the case is untested.

Either the surfaces should not offer × on `origin: 'derived'` (the honest answer: the edge is
the file's text, so the way to remove it is to edit the wikilink), or the deletion has to be
recorded so `replaceDerived` does not resurrect it.

### M3. The invisible edge hit-bands swallow the pan gesture on a busy map

`useSceneGestures.onPointerDown` returns early — before `drag.current` is set and before pointer
capture — for any press whose target is inside `.wr-graph__link`
(`apps/desktop/src/renderer/graph-canvas.tsx:663-666`). That class wraps every edge that has an
`onChoose`, i.e. every edge on the wiki and on the neighbourhood panel, and beside each drawn
1.5px line sits an invisible band of `stroke-width: 12` in *scene units* with
`pointer-events: stroke` (`apps/desktop/src/renderer/shell.css:748-754`).

A press that lands on one of those bands therefore does nothing at all: no pan, no zoom anchor,
and on release the edge underneath is selected instead. On a fixture graph with a handful of
edges the corner the pan tests aim at is empty — `tests/e2e/graph.spec.ts:175-190` picks 15% /
85% deliberately, and `tests/e2e/wiki.spec.ts:453-459` pans the **focus** canvas, whose edges
have no hit band at all. At the wiki's own defaults (`DEFAULT_SIZE = 150` nodes,
`EDGE_LIMIT = 1_500`, `wiki-panel.tsx:66-77`) the bands are 12 units wide over lines crossing a
1000×700 scene, and their combined area exceeds the scene's several times over: on a real
library much of the apparently-empty canvas stops being draggable. Nothing tests panning a wiki
that has more edges than the fixture.

The comment at `:662-666` justifies the early return by the retargeted-click problem, which is
real — but the fix costs the pan. Starting the pan and letting the band's `onClick` be
suppressed once the pointer has travelled (the same 6px threshold `LINK_DRAG_THRESHOLD` already
uses one function down) would keep both.

### M4. The neighbourhood panel offers × on the containment edge every highlight is born with

`GraphRepository.#edgesTouching` (`packages/database/src/repositories/graph.ts:267-282`) filters
by liveness only — no type filter — so a document seed's neighbourhood includes its
`annotation-belongs-to-document` edges. `graph-panel.tsx:794-802` gives *every* edge in that
answer an `onChoose`/`onDelete` pair, so the line between a paper and one of its own marked
sentences carries the delete glyph, indistinguishable from a link the researcher drew.

The whole-library wiki excludes those edges on purpose (`CONTAINMENT_EDGE`/`DRAWN_KINDS`,
`graph.ts:85-89`) and the ledger excludes them too
(`packages/database/src/repositories/links.ts:348-350`). The neighbourhood panel is the one
surface that does not, and it is the surface `H07`'s own comment names as "the picture of what
this one file is connected to".

Measured: delete one such edge through `link:delete`, then re-run the importer —
`graph:neighbourhood` on that document goes from **1 highlight to 0**, and stays at 0. The edge
is written once, in `AnnotationsRepository.create`
(`packages/database/src/repositories/annotations.ts:129`), and nothing in the application ever
writes it again: one press permanently removes a marked sentence from that file's graph, with no
warning and no way back.

---

## Minor

### m1. `H09` is missing on the wiki's other state

`FocusPanelBody` calls `useSceneView(documentId)` with no `onLink`
(`apps/desktop/src/renderer/focus-panel.tsx:92`), so the drag that joins two discs works on the
whole-library wiki and on the neighbourhood panel and not on the wiki focused on a file — which
`F05` insists is the *same surface*. It is also the surface where the gesture would be most
natural: the centre file, its own highlights and the papers it reaches are exactly the pairs a
researcher wants to join. The guide's control text hedges accurately ("The wiki, and a file's
link graph", `packages/workbench/src/guide.ts:236`), so nothing is *false* — but a researcher who
has learned the gesture on one state of the wiki will find it dead in the other, which is the
same complaint `V02`'s third-surface fix answered for `Find`.

### m2. In the picker's map, the link drag draws a line and writes nothing

`WikiPanelBody`'s `linkNodes` returns immediately when `onChoose` is set
(`apps/desktop/src/renderer/wiki-panel.tsx:170-181`), but the callback is still handed to
`useSceneView`, so `linking` stays defined: inside the link picker's "By looking" tab, pressing a
disc and dragging to another sets `data-linking="true"`, draws the dashed rubber line
(`:542`) and then silently does nothing on release. Passing `undefined` instead of a callback
that no-ops would make the surface honest.

### m3. Every pointermove of the `H08` drag wakes every subscriber of the workspace store

`useHighlightDrag`'s `onMove` calls `store.update({ annotationDrag: … })` unconditionally once
the threshold is passed (`apps/desktop/src/renderer/panels.tsx:228-235`), building a fresh object
each time even when `overDocumentId` has not changed. `WorkspaceStore.update` always commits
(`apps/desktop/src/renderer/store.ts:276-278`) and every `useWorkspaceState()` consumer
re-renders — ten of them in `App.tsx` alone, plus every reader frame. The store already knows
this is a hazard and guards the analogous case two hundred lines later, with a comment about
waking every subscriber for no change (`store.ts:336-341`). A guard on
`drag.overDocumentId === over` would cost one comparison.

### m4. `H09` re-renders the whole scene on every pointermove

`linkDrag` lives in `useSceneView` (`graph-canvas.tsx:749`), i.e. in `WikiPanelBody` itself, so
each move re-runs the `overview.nodes` and `overview.edges` maps
(`wiki-panel.tsx:472-539`). At the page's own budget that is 150 node groups (~4 elements each)
and up to 1,500 edges drawn as `<g>` + 2 lines — on the order of 5,000 elements reconciled per
pointer event, on top of the `getBoundingClientRect` and `elementFromPoint` each move already
forces (`graph-canvas.tsx:479-481`). With the demo library's eight papers this is invisible,
which is exactly why it wants saying: the gesture was developed and driven against the corpus
where it cannot show. Hoisting the rubber line into its own component (it is already drawn
outside the viewport group) would keep the scene out of the drag's render path.

### m5. A binned notebook's page stays open and fully editable, and says nothing

`question:delete` now bins rather than destroys and publishes `notebook:changed` with reason
`deleted` (`apps/desktop/src/main/handlers.ts:1009-1023`); the notebook page reacts by re-reading
(`apps/desktop/src/renderer/notebook-panel.tsx:269-276`), and since the row is still there it
simply redraws as normal — status "discarded", no mention of the bin. So a researcher can go on
writing blocks into a notebook that is in the trash, and `Empty the bin` then destroys the work
they wrote after deleting it. `question:restoreFromTrash` publishes no `notebook:changed` at all
(`handlers.ts:1025-1031`), so the page cannot hear the other half either. Related, though not
reachable from any surface today: `question:update` does not clear `trashed_at`, so a status
change on a binned notebook would leave it active *and* in the bin.

### m6. The queue sidebar subscribes to nothing

`QueuePanel` loads once on mount and never subscribes (`apps/desktop/src/renderer/queue-panel.tsx:71-83`);
only its own actions call `load()`. So `demo:fill` and `demo:clear` — which announce on
`library:changed` (`handlers.ts:1419`, `:1429`) and create or destroy notebooks — leave an open
"What next" shelf stale, as does `question:emptyTrash` run from anywhere else. `B07`'s E2E does
not catch it because `openLibrary` closes the questions sidebar before the shelf is re-opened
(`tests/e2e/demo.spec.ts:130,144` with `tests/e2e/support/corpus.ts:142-150`), so the panel is
freshly mounted both times it is read. `NotebookDirectory` next door subscribes to all three
channels (`notebook-directory.tsx:128-143`); the queue should do the same.

### m7. Coverage gaps worth naming

- `H07` says "wherever it is seen" and the E2E drives three of the four surfaces
  (`tests/e2e/linking.spec.ts:271-333`): ledger, references panel, wiki map. The neighbourhood
  panel's edge delete — the one with M4 in it — is asserted nowhere.
- `quoteLines` (`graph-canvas.tsx:83-116`) is `F06`'s entire mechanism, is exported and pure, and
  has no unit test; it is covered only through the rendered `<tspan>`s of one E2E highlight. Its
  greedy wrap has branches — a word longer than the line, the reconstruction comparison at
  `:107-115` — that one sentence cannot reach.
- `searchTarget`'s `null` branch and its status message (`panels.tsx:1257-1265`) — a hit whose
  document has gone — is untested, which is a pity given M1 makes it reachable.
- The picker's second stage is tested for "has highlights" and "has none"
  (`tests/e2e/linking.spec.ts:169-236`) but not for the failed-query state
  (`overlays.tsx:583-590`), which prints a different sentence.

---

## Checked and found sound

- `H05`: the chooser is gone from the picker and the edge is defaulted once, in the command every
  gesture funnels through (`workbench.ts:1279-1320`, `entity-links.ts:173-178`); `E02`'s stance is
  the only survivor and `linkTypesFor` still bounds an explicit type arriving from the librarian.
  The E2E asserts the control is *absent* rather than pre-answered (`links.spec.ts:216-218`).
- `H06`: `marks: null` vs `[]` is a real distinction on screen, the file stays the target while
  its sentences load, and `link:findForDocument`'s second array is the right query (each row
  carries how much has already been said about that sentence).
- `H08`: the source frame refuses its own document, the release point is read off
  `.wr-reader-panel[data-document-id]` rather than guessed, and the test proves a drag ending on
  the paper the sentence was marked in writes nothing.
- `F04`: the fit is captured on the first measurement with a real size and held; a measurement of
  zero (a Dockview tab opened in the background) is ignored rather than captured, which is the
  bug that would have made docking meaningless.
- `F05`/`F03`: `wiki` is both a singleton and re-seated, `panelSubjectKey` returns the kind rather
  than the file, and `openWiki`/`openFocusView` both write the same descriptor.
- `F07`: `librarianOpen` is store-only and `SidebarStateSchema` no longer declares it, so a
  workspace persisted with the old key still parses.
- `U10`: `searchTarget` names the entity per kind, `ListRow` is a real button, and the snippet
  delimiters are split into `<mark>` rather than printed.
- `U11`: `trashed_at` is genuinely not a fourth status; the discard-before-delete precondition is
  unchanged and still enforced in main; `emptyTrash` takes no argument, deletes one transaction
  per notebook and reports the sum; the confirmation sits on the irreversible act only.
- `B06`: the listing has its own content-type gate and its own cache file, `IMAGE_TYPES` was not
  widened to admit JSON, and crops are still built from a name by `artUrl` so no reply can turn
  one into a request for a whole card.
- `D03`: the mapping is computed from id + category, is total by construction, and
  `commandMotionCoverage` fails the build both ways; `MOTIONS` is typed
  `Record<CommandMotion, …>`, so a new drawing cannot be forgotten.
