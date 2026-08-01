# Milestone-6 audit — the surfaces

One lens over `b824ec5..HEAD` (30 commits, HEAD `4b0fd0a`): **send-to-notebook (`E01`),
hypothesis evidence (`E02`), the ledger (`E03`), wiki snippets (`V01`), graph search (`V02`),
the calendar (`V03`), the saved-page lever (`V04`), the guide (`O01`)** — real behaviour, real
coverage assertions, and what happens with a large library.

Method: read the code and every test that carries one of those tags; ran the whole vitest suite
(**62 files, 759 tests, all green**, node 20.19.3); did not run the E2E suite. For the
performance claims, drove the compiled repositories against seeded libraries of 300 / 600 /
1,500 / 3,000 documents through `packages/database/dist` — numbers below are measured on this
machine, three runs each, not estimated.

What is right, briefly, so the findings are read in proportion: `E03`'s integration test is one
of the better tests in this tree — it derives the ledger's highlights from `annotations` and
then proves the two halves agree, in page order, across a restart, with the derived containment
edge explicitly not counted. `V04`'s test measures rendered pixels through the archive's own
`<p>` rather than believing an attribute, and proves the desktop layout width survives every
lever step. `V02` picks the node drawn furthest from the middle and asserts the transform in
scene units. `O01`'s three-tier coverage mechanism (commands against the live registry, controls
against a source scan in both directions, menus against `CONTEXT_MENUS`) is a genuinely good
idea and its negative tests actually exercise the failure path. The findings below are what
those instruments do not see.

---

## Critical

### C1. `graph:overview` became quadratic in (documents × linked highlights) — 33 ms → 9,041 ms

`packages/database/src/repositories/graph.ts:476-497`, specifically the `places` CTE's new third
branch at `:488-491`:

```sql
SELECT 'annotation', a.id, a.selected_text, a.selected_text, a.document_id, g.degree
  FROM annotations a
  JOIN degrees g ON g.entity_type = 'annotation' AND g.entity_id = a.id
  JOIN documents d ON d.id = a.document_id AND d.deleted_at IS NULL
 WHERE a.deleted_at IS NULL
```

`degrees` is a materialised CTE with no index on it. SQLite answers this branch by driving from
`documents` and building an automatic partial index on `entity_type` **only** — so for every
document in the library it walks every annotation-degree row:

```
SCAN d
SEARCH g USING AUTOMATIC PARTIAL COVERING INDEX (entity_type=?)
SEARCH a USING INDEX sqlite_autoindex_annotations_1 (id=?)
```

Measured, same fixture shape each time (4 citations per paper, 20 highlights per paper, one in
ten highlights linked), milestone-5 ranking vs. the milestone-6 ranking:

| documents | annotations | links | m5 ranking | m6 ranking |
|-----------|-------------|-------|-----------|-----------|
| 300 | 6,000 | 7,800 | 3.0 ms | **71 ms** |
| 600 | 12,000 | 15,600 | 6.2 ms | **305 ms** |
| 1,500 | 30,000 | 39,000 | 15.8 ms | **1,955 ms** |
| 3,000 | 60,000 | 78,000 | 32.2 ms | **9,041 ms** |

Cost doubles when the corpus doubles under the old shape and roughly quadruples under the new
one. `better-sqlite3` is synchronous and this runs in the process that owns the database, so
that is 9 seconds during which no reader loads a file, no search returns and no highlight is
saved. It is not a once-per-session cost either: `wiki-panel.tsx:161-169` re-runs it on every
`library:changed` whose reason is not `annotation`, and `link:create`
(`apps/desktop/src/main/handlers.ts:1132`) publishes `reason: 'link'` **per link** — so a
librarian run that the researcher accepts twenty proposals from re-ranks the whole library
twenty times with a wiki tab open. `LinkPicker`'s "By looking" tab renders `WikiPanelBody`, so
opening the link picker's map pays it too.

The `JOIN documents` is the whole cost, and the guard it expresses can be written so the planner
keeps the annotation branch driving from `degrees`. Replacing that line with

```sql
 WHERE a.deleted_at IS NULL
   AND a.document_id IN (SELECT id FROM documents WHERE deleted_at IS NULL)
```

is semantically identical and measures **9,041 ms → 124 ms** at 3,000 documents (1,955 ms →
59 ms at 1,500). That is one line; the remedy is not the finding, the 9 seconds is.

---

## Major

### M1. The guard test that exists for exactly this cannot see the new branch

`tests/integration/graph.test.ts:703` — `[F01] ranks the library without a per-row existence
check over every link` — is the right test, written for the right reason, with a plan assertion
*and* a 400 ms clock ceiling. It seeds 400 documents, 10,000 links and **zero annotations**
(`:706-733`), so the `places` branch that C1 lives in never appears in the plan it captures and
never contributes to the clock it times.

It also could not have caught it if it had: the pathological plan contains no `CORRELATED` and
does use `links_source_idx` and `links_target_idx`, so all three of its assertions
(`:758-761`) pass on the 9-second query. The clock is the only thing that would notice, and at
that fixture's size (400 docs, ~8,000 annotations) the regression is worth roughly 130 ms —
under the ceiling. A milestone that added a whole new class of node to this answer left the one
test written to defend this answer untouched.

### M2. `E02`'s evidence never reaches an open notebook page

The criterion is "a hypothesis is a link target: the researcher attaches supporting or opposing
evidence by hand", and the milestone's own layout rule is "two panels side by side" — a reader
beside the notebook is the intended shape. In that shape the *For* line does not move.

- `apps/desktop/src/renderer/notebook-panel.tsx:197-217` subscribes to `notebook:changed` and
  to nothing else.
- The researcher's gesture goes through `link:create`, which publishes only `library:changed`
  (`handlers.ts:1132-1135`).
- The librarian's older path, `hypothesis:attachEvidence` (`handlers.ts:1046-1067`), publishes
  **nothing at all**.
- Even if an event did arrive, `reloadBoard` (`notebook-panel.tsx:168-177`) re-fetches the whole
  page and then keeps only `cards`: `{ ...current, cards: result.page.cards }`. `hypotheses` —
  which is where `supporting`/`opposing` live — is discarded.

So the researcher marks the sentence that settles their claim, links it, looks at the notebook
open beside the reader, and sees *For* still empty until the panel is remounted.

`tests/e2e/reading-into-notebooks.spec.ts:218` passes because it opens the notebook *after* the
link is made — `openNotebook` clicks `directory-open-…`, which mounts the panel for the first
time in that test and therefore always reads fresh. The assertion is true of a cold mount and
says nothing about the workflow the criterion describes.

### M3. The guide teaches "Find" on "Every graph surface"; the focused view has none

`packages/workbench/src/guide.ts:200-205` declares `graph.find` with
`surface: 'Every graph surface'`, and the `map` chapter — which covers `openWiki`,
`openFocusView` *and* `openLinkGraph` (`:494`) — instructs the reader at `:490`: "Type in Find
to search the map in place: non-matches dim and the view moves to the match."

`SceneFilter` is rendered by exactly two surfaces (`wiki-panel.tsx:330`,
`graph-panel.tsx:632`). The focused view (`focus-panel.tsx`) draws the same `SceneNode`s, the
same `SceneViewportGroup`, its own Labels checkbox (`:263-273`) and its own Reset view button
(`:274-281`) — and no filter. `F02` is the surface a researcher crawls a dense paper's
neighbourhood on, which is the density the criterion exists for.

`O01`'s machinery cannot catch this: `graph.find` is declared once, drawn once (in
`graph-canvas.tsx`), covered by one chapter, so every coverage assertion is satisfied while the
sentence the page prints is false. `V02` is likewise green on two of the three graph surfaces
the milestone's own notes call "all three graph surfaces' drawing".

### M4. `E03`'s point is a panel, and no test drives that panel

The gap the criterion answers (12) is a *rendering* complaint: "Link this highlight…" existed
only where linking had already happened, and a paper with six marked sentences read "Nothing is
linked to this file yet". The fix is in `ledger-panel.tsx:123-134` — seed `byHighlight` from the
file's own highlights, then drop the edges into their groups — and it produces three things the
researcher sees: the `Marked in this file` heading (`:191-196`), a group per sentence with a
`Link this highlight…` button (`:207-220`), and `Nothing said about this sentence yet.`
(`:224-230`).

None of the three is asserted anywhere. `grep` over `tests/` finds `ledger-on-highlight-` once
(`tests/e2e/ledger.spec.ts:122`, in the `H03` test, on a highlight that *does* have a link) and
finds `ledger-unlinked-`, `ledger-link-highlight-`, `ledger-highlights-heading` and
`data-highlight-count` **zero times**. The `[E03]` test
(`tests/integration/highlight-links.test.ts:309`) is excellent and stops at the channel. The
criterion is marked `integration`, so this is not a verifier hole — it is a claim about what the
researcher sees with nothing standing behind it, in the one milestone where the panel *is* the
change.

---

## Minor

### m1. The ledger's own count contradicts itself under truncation, and is never drawn

`links.ts:387` states the highlight link count "is deliberately not bounded by the entries'
`limit`: a truncated page still knows how many edges the highlight really has". The `[E03]`
test asserts the opposite at `highlight-links.test.ts:390-392`: "the count beside the highlight
is the number of rows the ledger would print under it". Both are true below 400 entries and they
disagree above it (`LEDGER_LIMIT` = `ledger-panel.tsx:37`), with nothing saying so. Moot in
practice, because `DocumentLedgerHighlight.links` is never rendered — the panel prints
`group.rows.length` into `data-link-count` (`:203`) and nothing else. The field crosses the wire
unused; gap 13 in `reports/DESIGN_GAPS.md` is where it is meant to land.

### m2. `highlightsForDocument` has no limit and carries untruncated text

`links.ts:394-425` returns one row per live annotation of the document with
`label: row.selected_text` — the whole selection, no `ellipsize` — while its sibling
`findForDocument` takes a `limit` and `EntityResolver` caps excerpts at 240 characters. Measured
at 400 highlights on one document: 34 ms per call and 400 `<section>`s in the ledger, and the
panel re-runs the call on **every** `library:changed`, whatever document it was about
(`ledger-panel.tsx:105-111`). A PDF with a few thousand marked sentences has no ceiling here.

### m3. The ledger's comment describes an order the code does not use

`ledger-panel.tsx:123-124` — "One group per marked sentence, **in the order they were marked**".
The repository orders by `an.page_index, an.text_start, …` (`links.ts:419`) and the `[E03]` test
asserts down-the-page explicitly ("the third was marked first and is listed last",
`highlight-links.test.ts:356-357`). The comment is the older behaviour.

### m4. A marked sentence on the map is offered "Open Document"

`V01` put annotations on the wiki; the `graph-node` menu's first group
(`packages/workbench/src/menus.ts:112-117`) offers `openDocument` and `openToSide` for anything
with an `entityId` and no `forTypes`. Right-clicking a highlight disc therefore offers "Open
Document" on an annotation id. It works — `navigate` resolves an annotation — but the menu names
it wrongly, and `openAnnotation` (which is what the `highlight` menu offers for the same thing)
is absent. The `R01` test that covers a graph node
(`tests/e2e/context-menu.spec.ts:145`) right-clicks a *document* node, so no test looks at this.

### m5. The wiki's header and its hint are wrong when highlights are elided by the cap

`wiki-panel.tsx:281` counts `quoted` over the **drawn** nodes; `overview.totalNodes`
(`graph.ts:497`, `COUNT(*) OVER ()`) counts the whole `places` set, highlights included. With
linked highlights that rank below the node cap, the header reads "N files and notes" where N
includes highlights (`:299-301`), and the reassurance at `:311-315` — "a sentence you marked
joins the map when you link it to something" — is shown to a researcher who has already done
exactly that. Also `totalNodes === 1` prints "1 file" for a library holding one note.

### m6. The map's filter can only match the first 120 characters of a marked sentence

`graph.ts:99-100` truncates both `title` and `snippet` to 120 characters before they leave main,
and `wiki-panel.tsx:215` matches against those. The box says "a title, or words you marked"
(`graph-canvas.tsx:171`) and the guide's control hint repeats it (`guide.ts:204`). A word in the
second half of a long highlight is not findable on the map. The neighbourhood panel is less
affected (`EntityResolver` truncates at 240) and matches on `title` only
(`graph-panel.tsx:275`), never on a snippet.

### m7. `question:attach` accepts a deleted highlight

`handlers.ts:950-957` checks the target exists with `db.annotations.get(targetId)`, and
`annotations.get` (`packages/database/src/repositories/annotations.ts:167-177`) does not filter
`deleted_at` — unlike `listByDocument` beside it, which does. A card sent to a desk from a
soft-deleted highlight is born broken. The renderer only offers live highlights, so this is
reachable only by a caller, not by a hand; the same hole is in `hypothesis:attachEvidence`
(`:1051-1055`).

### m8. The saved page's persisted zoom is unbounded

`packages/workbench/src/layout.ts:96` — `zoom: z.number().positive().nullable()`. The lever only
ever emits one of `[0.5, 0.75, 1, 1.5, 2, 3]` (`HtmlReaderView.tsx`, `ZOOM_STEPS`), and
`stepZoom` clamps at both ends, but the schema that reads a restored workspace accepts any
positive number and `scale = fit * zoom` is applied straight to the frame's transform. A
`ZOOM_STEPS`-shaped enum, or a `.max(LARGEST)`, would make the restore path say what the control
says.

### m9. `PANEL_CONTROLS` ↔ `data-control` is set equality, so an undeclared widget is invisible

`tests/integration/guide-controls.test.ts:93-108` proves that every drawn id is declared and
every declared id is drawn. It cannot prove that every *feature* carries an id, and two live
examples show the gap is not theoretical: the focused view's Labels checkbox and Reset view
button (`focus-panel.tsx:265`, `:277`) are the same features as `graph.labels` and `graph.reset`
with no attribute on them, and `Restore` on the discarded shelf (`queue-panel.tsx:433`) — half
of `I01`, and the half the guide's `notebookDiscard` hint promises comes back — carries none
either. The second test in that file (`:110-125`) is the right instinct; it spot-checks six ids
against the file that draws them, and nothing checks the reverse direction *per surface*.

### m10. Two calendar details, one of them already logged as a gap

`journal-calendar.ts:152` documents `leading` as "blank cells before the first day, so **the
1st** falls under its own weekday"; the code aligns the first *drawn* day (`:184`), which for
the first month of a range is usually not the 1st. Separately, gap 23 in
`reports/DESIGN_GAPS.md` — a journal begun today draws a month grid with one box in it — is
`V03`'s "render all days" read as "all days of the range". It is disclosed, not hidden, and
belongs in the same paragraph as the other open gaps rather than as a finding; noted here only
so the audit does not appear to have missed it.

---

## Things checked and found sound

- `V04`: the lever is a multiplier on the fit, the fit stays capped at 1, the layout width never
  moves, and `data-snapshot-scale` is published as fit × lever so `H01`'s click transport
  (`tests/e2e/support/archive.ts`) still lands on the words. The viewport is a sibling of the
  lever, so measuring it does not include the control. Persisted per panel, restored across a
  process boundary and re-measured through rendered pixels.
- `V03`: `calendarMonths` is `calendarCells` with the fold at `+Infinity`, so which days exist is
  answered once; a start in the future falls back to today (`journal-panel.tsx:286`); a logged
  day before a chosen start is not lost, because `JournalRepository.start` already takes
  `min(first entry, chosen)`.
- `E01`: one path only — `question:attach`, the same channel the excerpt insert uses; a card *is*
  the edge; the reader's `subject` rule is shared with Link and Note so all three mean the same
  thing; the test reads `links` out of SQLite rather than believing the panel.
- `E02`: `linkTypesFor` grew one branch and both the picker and `createDocumentLink` read it, so
  the two ends cannot drift; `related-to` is deliberately absent for a claim.
- `V01`: the containment edge is excluded in exactly one place (`DRAWN_KINDS`) and that same
  exclusion is what makes `REDRAWS_THE_MAP` honest; `annotation:delete` publishes `delete`, not
  `annotation`, so a highlight leaving the map does redraw it.
- `O01`: the coverage is computed against the live `CommandRegistry` on mount, drawn on the page
  as well as asserted, and the negative tests exercise the mechanism rather than only its current
  answer. `normalize.ts`'s refactor is behaviour-preserving. Nothing on the guide page is
  fetched.
- `scripts/verify_completion.py` gained one line (`R01`) and lost nothing.

## Scratch

The probes are at
`/private/tmp/claude-501/-Users-hshi-Desktop-wikireader/a80c3ea4-f4df-465c-b2f5-d8238f6bdb4f/scratchpad/perf.mjs`,
`perf2.mjs` (m5 vs m6 ranking, plus `EXPLAIN QUERY PLAN`) and `perf3.mjs` (the rewritten
guard). They import `packages/database/dist`, seed into a temp directory and remove it.
