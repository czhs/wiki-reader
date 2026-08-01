# Audit — milestone 5, the wiki page and the focused view

Audited-commit: f934770
Audited-milestone: 5
Range: `7796795..HEAD`
Lens: `F01`/`F02`/`F03` — real rendering, real refocus, view state, and behaviour on a large
library. Read the code and the tests; ran the graph unit tests and
`tests/integration/graph.test.ts` repeatedly. Did not run the E2E suite.

Everything below is reproduced from a script or a test run. Benchmarks were run against the
built `packages/database/dist`, Node 20.19.3, on this machine, with synthetic libraries seeded
straight into a migrated database.

## Findings

### 1. `[F02]`'s integration test fails about one run in three — major

`tests/integration/graph.test.ts:563` asserts the first highlight in the focused view's inner
ring is the first one made. Eight consecutive runs of the file:

```
Tests  1 failed | 31 passed      Tests  32 passed      Tests  32 passed
Tests  1 failed | 31 passed      Tests  1 failed | 31 passed
Tests  32 passed      Tests  32 passed      Tests  32 passed
```

```
AssertionError: expected 'Marked sentence 1' to contain 'Marked sentence 0'
 ❯ tests/integration/graph.test.ts:563
```

Cause. `packages/database/src/repositories/graph.ts:516` orders the ring by
`an.page_index, a.created_at, a.id`. `page_index` is `NULL` for every markdown and every saved
web page — `packages/database/src/repositories/annotations.ts:62-76` sets it only for `pdf` —
so the ordering collapses to `created_at, id`. `created_at` has millisecond resolution, and
`packages/document-model/src/ids.ts:39-41` mints ULIDs with a fresh random suffix per call
rather than a monotonic one. Two highlights made in the same millisecond therefore come back in
an arbitrary order, and the order flips between runs.

This is also a substantive defect, not only a flaky test. The comment above the query
(`graph.ts:508-509`) promises "Reading order, the order the highlights were made in the page: a
ring that reordered itself … would move the sentence someone was looking for." What is
delivered on the corpus this app is built around — markdown pages and saved web pages — is
creation order with a random tiebreak, and creation order is not reading order at all: mark
paragraph 9 and then paragraph 2 and the ring reads 9, 2. A tagged criterion whose test passes
about two runs in three is not green.

### 2. The focused view under-reports its own elision by a thousand files — major

`FOCUS_EDGE_LIMIT = 2000` (`graph.ts:58`) bounds the edge query at `graph.ts:548-569`. Its
comment says the bound "is a ceiling on the work and never the thing that decides which files
appear — that is `neighbourLimit`, which is reported back as an elision".
`state/DECISIONS.md:712` freezes the same claim.

One file linked to 3,000 others, `graph:focus` with `neighbourLimit: 16`:

```
files this one actually reaches: 3000
neighbours drawn: 16
elidedNeighbours reported: 1984
truth: 2984  => under-reported by 1000
```

The edge cap, not `neighbourLimit`, chose which 2,000 of the 3,000 edges were even considered,
and `elidedNeighbours` (`graph.ts:645`) is computed from what survived that cut. A thousand
connected files disappear and the view says nothing. Every crawl route out of them
(`F03`) disappears with them.

### 3. The wiki page drops a real edge between two nodes it drew, silently — major

`EDGES_PER_NODE = 400` (`graph.ts:48`) caps `#edgesTouching`, which `overview()` calls once per
ranked node (`graph.ts:447-462`). The cap's comment reasons about the *neighbourhood* traversal
("the node cap … is what actually decides the answer in every normal case"); in `overview` the
cap is per drawn node and directly decides which lines exist. Two files that each have more
than 400 links, joined to each other by a link created after those:

```
nodes drawn: [ 'A', 'B' ]
the A–B link exists in the database: 1
edges the wiki was sent: 0
truncated flag: true  elidedNodes: 1000  (nothing in the answer mentions a dropped edge)
```

`truncated`/`elidedNodes` only ever describe nodes (`graph.ts:479-483`), so a map missing an
edge presents itself as complete. Two heavily linked hub pages is an ordinary shape for a
working wiki, not a contrived one.

### 4. `overview()` scans the whole `links` table, on the main thread, on every redraw — major

`packages/database/src/repositories/graph.ts:130` states, of this class: "There is no code path
here that reads `links` whole." The ranking query at `graph.ts:411-433` reads it whole twice —
`endpoints` is `links` UNION ALL `links`, with the six-branch `LIVE_EDGE` existence check
applied to every row of each. `EXPLAIN QUERY PLAN` confirms two full covering-index scans and a
temp b-tree group-by. Measured, warm:

| library | `overview(150)` | `overview(300)` |
|---|---|---|
| 2,000 docs / 20,600 links | 88 ms | 117 ms |
| 10,000 docs / 100,600 links | 280 ms | 311 ms |
| 1,000 docs / 200,600 links | 997 ms | 1,570 ms |

better-sqlite3 is synchronous, so this is the whole main process blocked — every other IPC
call, including the reader's file loads, waits behind it.

It is not once per open. `apps/desktop/src/renderer/wiki-panel.tsx:87-94` reloads on every
`library:changed`, for whatever reason, and Dockview keeps a hidden panel mounted — so a wiki
tab left open anywhere in the workspace re-runs the full scan on every highlight created
(`apps/desktop/src/main/handlers.ts:689-693`, `reason: 'annotation'`), every note, every
import. The wiki page draws no highlights at all by design, so most of that work cannot change
the picture.

### 5. `GraphOverview.edges` is unbounded — major

`packages/shared-types/src/domain.ts:569-576` documents the answer as "capped" and caps only
`nodes`. On a dense corpus (1,000 files, 200,600 links), `graph:overview({nodeLimit: 300})`
returned **24,865 edges** — every one serialised over IPC and rendered as its own `<line>` by
`wiki-panel.tsx:221-237`. There is no `elidedEdges`, so the payload has no ceiling and no
honesty about one; finding 3 is the same hole seen from the other side.

### 6. The crawl carries the previous file's pan and zoom onto the next one — major

`apps/desktop/src/renderer/graph-canvas.tsx:171-184` states the rule the focused view is meant
to follow: "Pan and zoom held for as long as the panel is, and no longer. What the wiki page
and the focused view want: a remembered pan would put the next file's picture somewhere the
reader left the last one's." `graph-canvas.tsx:88-89` gives the same reason.

The code does the opposite. `FocusPanel` (`focus-panel.tsx:423-437`) renders the same
`FocusPanelBody` element at the same position for the same `panelId`; a re-seat changes only
the `documentId` prop, so React keeps the component mounted and `useSceneView`'s state survives
it. Nothing resets `scene` when `documentId` changes — `scene.reset` is wired only to the
button at `focus-panel.tsx:257-264`. Pan away, zoom to 5, choose a file at the edge: the new
file's centre is laid out at (500, 350) as always and is drawn wherever the old viewport puts
it, which at the extremes is off the panel entirely. Nothing in `tests/e2e/wiki.spec.ts` or
`packages/workbench/test/panel-targets.test.ts` reads `data-pan-x`/`data-zoom` across a refocus,
so the contradiction is invisible to the suite.

### 7. "The whole graph at once" tops out at 300 nodes — minor

`F01`'s text is "the whole graph at once". `packages/shared-types/src/ipc.ts:816` caps
`nodeLimit` at 300 and `wiki-panel.tsx:37-38` offers 60/150/300 with 150 as the default, so a
library of 400 files can never be shown whole at any setting the UI or the contract allows.
The channel is honest about it (`totalNodes`, `elidedNodes`, the "N more not shown" line) and
`DECISIONS.md:712` freezes that as the design, which is why this is minor rather than more —
but `tests/e2e/wiki.spec.ts:80` asserts `data-truncated: 'false'` and that assertion only holds
because the fixture corpus has a handful of files. No test at any level exercises the wiki page
in its truncated state, which is its state for every real library.

### 8. At the default size the map's discs and labels overlap; the layout test cannot see it — minor

Closest pairwise distance in `overviewPositions`, measured against the real 1000×700 scene:

| nodes | closest two | `NODE_RADIUS` 9 (⌀18) | `HUB_RADIUS` 14 (⌀28) |
|---|---|---|---|
| 40 | 48.36 | ok | ok |
| 60 | 39.32 | ok | ok |
| 150 (default) | 24.74 | ok | **overlap** |
| 300 (max) | 17.47 | **overlap** | **overlap** |

Labels are worse: `.wr-graph__label` is `font-size: 13px` in scene units (`shell.css:611-615`)
and `truncateLabel` allows 28 characters (`graph-canvas.tsx:217`), so a label is ~180 units
wide against a 24.7-unit neighbour spacing at the default size — and `showLabels` starts `true`.

`packages/graph/test/graph.test.ts:225-238` claims "no two on top of each other", but it uses
40 nodes and only detects positions that round to the same integer pair, so neither row of the
table above can fail it. Related to, but distinct from, gap 1 in `reports/DESIGN_GAPS.md`,
which is about small panels rather than density at the default count.

### 9. Overlapping loads are applied unconditionally — minor

`wiki-panel.tsx:69-85` and `focus-panel.tsx:84-107` both `setState` from a promise with no
request-generation guard and no abort. Change the size picker from 300 to 60 on a large library
and the 60-node answer can land before the 300-node one; the select then reads 60 while the map
draws 300. Reachable precisely because finding 4 makes the query take hundreds of milliseconds
and both panels reload on every `library:changed`.

### 10. A note node in the picker's map is a dead click that says it is not — minor

`overlays.tsx:607-614`: `setFocusedIdFrom` ignores everything that is not a document. The wiki
map inside the link picker draws notes as nodes (`graph.ts:428` puts them in the overview) with
`data-action="refocus"` and the accessible name "Focus on <title>" (`graph-canvas.tsx:252-256`,
`:299`). Clicking one does nothing at all — no status, no message. `wiki-panel.tsx:126-127` has
the same silent `return` for an entity type the schema rejects. `[H04]`
(`tests/e2e/ledger.spec.ts:192`) only ever clicks a document node, so nothing covers this.

### 11. Three graph surfaces, three answers to "show labels" — minor

`G02` persists `showLabels` application-wide, and `graph-panel.tsx:578-582` reads and writes it.
The two new surfaces opt out: `wiki-panel.tsx:65` and `focus-panel.tsx:80` each hold a local
`useState(true)` that ignores the stored preference and is discarded when the panel closes. A
researcher who turned labels off gets them back on, twice, and cannot turn them off for good.

### 12. The focused view adds its two elision counters together — minor

`focus-panel.tsx:230-234` renders `elidedAnnotations + elidedNeighbours` as one "N more not
shown". The whole justification for the channel's shape (`domain.ts:618-625`,
`DECISIONS.md:713`) is that highlights and connected files are budgeted and elided *separately*
so neither half can be mistaken for the other; the surface then merges them back into one
number, from which neither half can be recovered.

### 13. `F02`'s geometry assertions never read what was drawn — minor

`tests/e2e/wiki.spec.ts:163-180` proves "centre-stage" and "at the edge" from `data-x`/`data-y`
(`tests/e2e/support/corpus.ts:186-197`), which `SceneNode` writes straight from the layout
(`graph-canvas.tsx:291-292`) before any viewport transform. Those are the numbers
`focusPositions` returns, and `packages/graph/test/graph.test.ts:259-268` already asserts them.
Nothing in the E2E reads `data-pan-x`/`data-pan-y`/`data-zoom` from `SceneViewportGroup`, so a
surface whose transform put the whole ring outside the panel would pass `[F02]` unchanged. It
is also why finding 6 is invisible to the suite.

## What was checked and found sound

- `F03`'s re-seating mechanism. `panelSubjectKey` keys `focus` on kind alone and
  `RESEATED_PANEL_KINDS` makes a reveal carry the new descriptor
  (`packages/workbench/src/panel-targets.ts:55-94`, `:214-224`); `host.applyPlan` writes it back
  (`apps/desktop/src/renderer/host.ts:198-218`). Crawling, and opening the view on a third file
  from outside, both land in the one tab. The panel reads the descriptor rather than panel state
  (`focus-panel.tsx:427`), so the route cannot be bypassed.
- Two surfaces, not one with a toggle, as the milestone requires: separate panel kinds, separate
  channels, separate layouts.
- The pan/zoom arithmetic in `useSceneGestures` (`graph-canvas.tsx:104-152`) is correct for the
  `translate` ∘ `scale` group it drives, including cursor-anchored zoom; `G01`'s per-seed
  viewport persistence in `graph-panel.tsx` survived the unification onto the shared hook.
- No filesystem path reaches either surface: icons are `rrfile://<file id>` built from an id
  (`graph-canvas.tsx:314-316`), and `graph:overview`/`graph:focus` are zod-validated in the
  router with a required, capped `nodeLimit`.
- `scripts/verify_completion.py` was only added to in this range (two new tags); nothing was
  weakened.
- `packages/graph` unit tests: 17 passed. `tests/integration/graph.test.ts`: 31 of 32 stable,
  the 32nd is finding 1.

## Reproductions

Scripts used for findings 2, 3, 4, 5 and 8 are in this session's scratchpad
(`bench2.mjs` overview/focus timings, `bench3.mjs`/`bench5.mjs` overview edges, `bench4.mjs`
focus elision, `layout.mjs` node separation). Each seeds a migrated database directly and calls
`GraphRepository` or `@wr/graph`; none of them needs Electron.
