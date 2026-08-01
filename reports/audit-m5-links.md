# Audit — milestone 5, the links lens

Range `7796795..HEAD` (`f934770`). Lens: saved-page highlighting (`H01`), per-highlight links
(`H02`), the file ledger (`H03`), picking a link target from the graph (`H04`) — anchors, round
trips, and whether `H01` is fixed at the cause.

Method: read the diff and the code around it; ran the whole vitest suite (56 files, 701 tests,
all green, Node 20.19.3); ran two throwaway probes against the real repositories and the real
anchor code to settle two questions the suite does not ask. The E2E suite was not run.

**Is `H01` fixed at the cause?** Yes, at the transport. The diagnosis in `aa6eefd` is right and
is the interesting part of the milestone: a snapshot renders inside `sandbox=""` at an opaque
origin with no script, so `window.getSelection()` cannot cross into it, `contentDocument` is
cross-origin, and the frame has no script to `postMessage` out — three doors closed on purpose.
Taking the selection from Chromium's `context-menu` params in the main process grants the
archive nothing, and `docs/SECURITY.md` records the invariant honestly. What is *not* fixed at
the cause is the anchor that gets built from that selection (finding 1) and the fact that no
researcher will ever discover the gesture (finding 3).

---

## Critical

None.

## Major

### 1. A saved-page anchor fabricates its own text evidence when the selection is not verbatim in the extracted text

`apps/desktop/src/renderer/panels.tsx:679` hands `createHtmlAnchor` a position hint of
`{ start: 0, end: selection.length }`, because a context-menu selection carries no offsets. That
is fine when the words come back verbatim. When they do not:

- `packages/document-model/src/text-quote.ts:71-74` — `locateNearest` does not fail. It keeps
  the hint, so the recorded position becomes `{0, len}` — the top of the page.
- `packages/document-model/src/html-anchor.ts:49-50` — `createQuoteSelector` is then cut from
  *that* position, so the anchor's `quote.prefix` and `quote.suffix` describe text at offset 0
  that has nothing to do with what the reader selected. Only `quote.exact` is overwritten with
  the real selection (`html-anchor.ts:55`). The anchor is persisted with confident, wrong
  context — and `scoreContext` (`text-quote.ts:114-131`) uses exactly that context to choose
  between occurrences on a re-saved page.
- `packages/document-model/src/text-quote.ts:244-250` — the fuzzy fallback is bounded to
  `hint.start ± 4000`, and the hint is always 0, so only the first ~4000 characters of the page
  are ever searched.

Reachable, not hypothetical. `extractHtmlText` is a scanner over markup, not a renderer: it
emits `display:none` prose (the reader's own comment at
`packages/html-reader/src/HtmlReaderView.tsx:43-57` documents a real archived page carrying 247
hidden table-of-contents elements) and it drops `svg` and `math` content outright
(`packages/document-model/src/normalize.ts:92-102`). Chromium's selection is the opposite in
both cases. Any of those inside the selected sentence breaks the verbatim match.

Measured, with a `<span style="display:none">[edit]</span>` inside the selected paragraph:

| where the sentence is | result |
|---|---|
| near the top of the page | resolves `context-fuzzy`, confidence 0.52, over a **misaligned** range — `"…the field [edit]rewards reading code more than reading p"` |
| ~7.8k characters down | resolves `null` — the highlight is created, listed, struck through, and permanently unfindable |

The second row is the honest failure. The first is the one the codebase says it must never
produce: `tests/integration/html-highlight.test.ts:15` — "A plausible-looking wrong paragraph
would be worse than none: it reads as a finding."

Nothing tests this. Every `[W05]` case builds its selection with true offsets computed by
`indexOf` (`tests/integration/html-highlight.test.ts:181-193`), which is the one shape the
`H01` path never produces, and the `[H01]` fixture is a single clean `<p>` with no hidden
markup (`tests/e2e/support/workspace.ts:186-188`).

The fix is at `text-quote.ts:71-74`: a `locateNearest` that cannot find the quote should say so
rather than invent a position, and `createHtmlAnchor` should then record no offsets and no
context — a quote-only anchor resolves by search over the whole document, which is both correct
and what the page actually knows.

### 2. The ledger lists a deleted highlight's link as a live connection

`packages/database/src/repositories/links.ts:318-320` promises that a deleted highlight's links
are left out, "because a ledger is a view of what this file says now". The `inside()` fragment
at `:326-332` does filter `annotations.deleted_at IS NULL` — but only for deciding whether an
endpoint is inside *this* file. The endpoint at the far end is described by
`packages/database/src/entity-resolver.ts:176-203`, which never looks at `deleted_at`, so
`resolve()` (`links.ts:379-397`) returns `broken: false` for a highlight the user deleted.

Probed directly against the repositories: a highlight in paper B linked
`annotation-references-document` to paper A, then `annotations.softDelete`. Paper A's ledger
before and after are byte-identical — `{ near: 'document', other: 'annotation', title: 'a
marked sentence', broken: false }` — while `graph.focus` on paper A correctly drops the
neighbour (0 connected files). Two milestone-5 surfaces disagree about the same fact, and the
one that is wrong is the one whose docstring promises otherwise.

Consequence for the reader: the row is not marked broken, so `ledger-panel.tsx:127-129` →
`host.openReference` (`host.ts:448-452`) takes the not-broken branch and navigates to a
highlight that no longer exists, instead of saying the link points at nothing.

`graph.ts:109-120` already has `liveEndpoint`/`LIVE_EDGE` for exactly this, written for exactly
this reason ("an edge that outlives its endpoint keeps drawing a node for something the user
deleted"). The ledger query does not use it.

### 3. `H01` ships with no affordance: the only way to highlight a saved page is a right-click nobody is told about

`apps/desktop/src/main/index.ts:110-112` is the only route by which a selection leaves the
archive. The article panel (`apps/desktop/src/renderer/panels.tsx:718-762`) renders the reader
actions strip, the frame, and — only once at least one highlight already exists
(`panels.tsx:735`) — the list of highlights. There is no hint anywhere that a selection has to
be right-clicked, no empty state, no label on the strip.

Every other reader in the app raises the selection bar on `mouseup`
(`tests/e2e/support/corpus.ts:165`, `tests/e2e/ledger.spec.ts:79-82`), so the gesture the
researcher has learned everywhere else does *nothing at all* on a saved page — which is
indistinguishable, from the outside, from the bug `H01` was written to fix. The `[H01]` test
passes because `selectAndInvoke` (`tests/e2e/webpage.spec.ts:159-169`) knows to right-click.

This is not in `reports/DESIGN_GAPS.md` and not in the `state/DECISIONS.md` entry at line 718,
which discusses the transport's two costs (truncation, no offsets) but not its discoverability.
A one-line hint under the article panel's reader actions would close it.

### 4. A stale `selectedDocumentId` sends the ledger, the focused view and the link picker to the wrong file

`apps/desktop/src/renderer/host.ts:291-299` builds the active entity by pairing
`selectedAnnotationId` with `selectedDocumentId` — two fields written independently:

- `apps/desktop/src/renderer/panels.tsx:113` (`makeHighlight`) sets **both**.
- `apps/desktop/src/renderer/panels.tsx:745-748` — the new article-panel chip — sets only
  `selectedAnnotationId`. So do the PDF and markdown activation handlers (`:293`, `:554`).
- `apps/desktop/src/renderer/App.tsx:302-307` — switching tabs re-syncs `selectedDocumentId`
  only when the newly active panel is a `pdf-reader`. A markdown or article tab does not.

Both new milestone-5 page commands then take that field at face value:
`packages/workbench/src/workbench.ts:986-987` (`openFocusView`) and `:1017-1018`
(`openLedger`).

Repro: open saved page B, open paper A (a PDF), click back to B's tab, click one of B's
highlight chips, press the ledger chord. `selectedDocumentId` is still A, so **A's** ledger
opens over B's page — and the annotations sidebar (`panels.tsx:997`) has already been showing
A's highlights the whole time. The same stale pairing seeds the link picker's graph tab on the
wrong file (`overlays.tsx:452`).

Cheapest fix: have `#syncSelectionFrom` (`host.ts:279-287`) run on tab activation for every
reader kind, and have the three highlight-activation handlers set `selectedDocumentId`
alongside `selectedAnnotationId` the way `makeHighlight` does.

---

## Minor

### 5. The keyboard route to "Link this to…" has no "is this highlight on the file I am looking at" guard

`apps/desktop/src/renderer/panels.tsx:344-346` is explicit that a highlight counts as the link
source only when it belongs to the document the strip sits above — "a note offered as 'on this
highlight' while another paper's highlight was selected would attach itself to the wrong
passage". `packages/workbench/src/workbench.ts:530-553` (`#linkSubject`), which is what
`Cmd+Alt+L` reaches (`workbench.ts:342-348`), applies no such test: it takes whatever
`getActiveEntity` returns. Before `H02` this collapsed to a document; now it keeps the
annotation, so the widening carried the guard's absence with it. Visible rather than silent —
the picker's title names the source (`overlays.tsx:617-623`) — which is why this is minor.

### 6. The article panel knows an anchor is broken and never tells the sidebar

`apps/desktop/src/renderer/panels.tsx:694-710` resolves every html anchor against the snapshot's
text and paints the result on the chips. It never calls `store.setResolutions`. Only the PDF
reader publishes (`panels.tsx:238-243`, `PdfReaderView.tsx:50`). So after `0b57c92` correctly
made `unknown` silent (`packages/annotations/src/AnnotationCard.tsx:72-78`), "Anchor broken" and
"Relocated" became states the sidebar can only ever reach for PDFs, while the article panel
strikes the same highlight through two hundred pixels away. Publishing what the panel already
computed is a one-line change.

### 7. `openLedger` and `openFocusView` resolve their subject through the link under the cursor

`workbench.ts:1013` and `:982` use `#subjectOr`, which prefers `getLinkUnderCursor()`
(`workbench.ts:505-513`). `#linkSubject` deliberately does not, for a stated reason
(`workbench.ts:518-521`): "hovering a citation chip while reaching for the menu would silently
change which end the link came from". The same hazard applies here — hovering a `document://`
chip in a note and pressing the ledger chord opens the ledger of the chip's target, not of the
file being read — and these two are in the *page* keybinding family, where the hand expects
"go to the page for what I am on".

### 8. The link picker's map silently ignores a click on a note

`apps/desktop/src/renderer/overlays.tsx:607-614` — `setFocusedIdFrom` acts only on
`entityType === 'document'`. `graph:overview` returns notes as well as files, and
`wiki-panel.tsx:257` labels every node `Focus on …` in the picker. Clicking a note does nothing,
says nothing, and looks identical to clicking a file. `H04` does not require notes as targets;
the no-op with no feedback is the defect.

### 9. `article-reader` descriptors still claim `readerMode: 'readability'`

`packages/workbench/src/panel-targets.ts:349` mints the descriptor with `'readability'` and
`packages/workbench/src/layout.ts:87` defaults it there, while `panels.tsx:612-617` explains at
length that the field is a lie and hardcodes `'original'` so anchors are not written
unresolvable. The lie is now persisted in every saved workspace layout. Either the descriptor
should say `'original'` or the field should go — a field whose only correct use is to be ignored
is the next caller's trap.

### 10. The ledger truncates in silence

`apps/desktop/src/renderer/ledger-panel.tsx:27` asks for 400 rows and
`packages/database/src/repositories/links.ts:344-345` applies the LIMIT. Neither reports what was
left out, and the header prints `entries.length` as "N links" (`ledger-panel.tsx:144-146`), which
is then simply wrong for a well-connected paper. Both sibling surfaces do report elision —
`focus-panel.tsx:230-234`, `wiki-panel.tsx:160-164` — and `graph:focus`'s two-budget shape exists
precisely so a view can say how much it dropped.

### 11. Neither half of the `H01` transport has a unit or integration test

`document:getSnapshotText` (`apps/desktop/src/main/handlers.ts:658-680`) and
`reportSnapshotSelection` (`apps/desktop/src/main/index.ts:131-146`) appear in no test in the
tree. Untested in particular: the allowed-roots refusal at `handlers.ts:665-669`, the
`docType !== 'webpage'` guard at `index.ts:143`, the `parseFileId` rejection of a sub-resource
frame URL, and the claim in `docs/SECURITY.md` that "never the frame URL, never a path" crosses.
The only coverage is `[H01]`'s happy path through a real Electron process, which is the slowest
and least specific place to learn that a refusal regressed.

### 12. `[H04]`'s "one of its annotations" assertion cannot distinguish success from a degraded path

`tests/e2e/ledger.spec.ts:253-255` asserts `link-picker-chosen` contains `'highlight'`. Both
branches of `describeLinkTarget` (`apps/desktop/src/renderer/overlays.tsx:626-632`) contain that
word — `The highlight "…"` and the fallback `A highlight is chosen.` — so the assertion passes
even when the picker could not find the annotation's text in the store and named nothing.
Asserting on the quote itself (which the test already has via `annotationIds`, or from
`markAPassage`'s return) would make the check say what it means.

### 13. `canonicalLinkType` still returns the type the whole `H02` design exists to refuse

`packages/workbench/src/entity-links.ts:52-55` maps `annotation → document` to
`annotation-belongs-to-document`, and `createLinkDraft` (`:176-179`) uses it whenever no explicit
type is given. `linkTypesFor` (`:105-117`) excludes that type, the picker and the command both
read `linkTypesFor`, and `tests/integration/highlight-links.test.ts:216-241` proves why: because
`LinksRepository.create` is idempotent on `(type, source, target)`, a manual assertion written
with that type returns the pre-existing derived row and reports success for a link it never made.
No production caller passes an annotation source to `createLinkDraft` today
(`derivedLinksFromNote` is the only one), so this is latent — but the two functions now disagree
about the same question in the same file, and only one of them has a comment saying which is
right.

---

## Checked and sound

- **`H02`'s new type is genuinely new.** `annotation-references-document` vs the derived
  containment edge, the idempotency collision it avoids, and the direction of both edges are all
  asserted against a real database through the real router and across a restart
  (`tests/integration/highlight-links.test.ts`). The third test in that file is the good kind —
  it proves the trap is real rather than asserting the guard exists.
- **The picker and the command cannot drift.** Both read `linkTypesFor`; the command re-validates
  (`workbench.ts:1119-1126`), and the picker drops a chosen type when the target changes kind
  (`overlays.tsx:438-440`). No default type anywhere.
- **`findForDocument` really is one bounded query with no type filter**, and its exclusion of
  derived edges with both ends inside the file (`links.ts:341-343`) is right and is asserted in
  `[H03]` by row count rather than by absence of a string.
- **The ledger writes nothing itself** — both gestures go through `COMMAND_IDS.linkToDocument`
  (`ledger-panel.tsx:153`, `:194`), which is the reason the E2E can assert the rows straight out
  of SQLite and get the same answer as the panel.
- **`graph.focus` counts a connection through a highlight at either end** (`graph.ts:548-599`)
  and says which it was via `throughAnnotation`. The annotation join is safe: `annotation_anchors`
  is `UNIQUE NOT NULL` per annotation and written in the same transaction as the annotation
  (`001_initial.ts:109-121`, `annotations.ts:106-111`), so the inner join can neither drop nor
  duplicate a row.
- **`0b57c92`'s anchor-health fix is right at the cause.** `undefined` (nobody looked) and `null`
  (a reader looked and failed) were the same value; they are now different, the badge fires only
  on an established state, and the strike-through CSS keys on `data-anchor-state='broken'` alone
  (`packages/annotations/src/styles.css:78`). See finding 6 for the half that is still owed.
- **The markdown painting fix** (`1b8e9b8`) is a real bug fixed at the cause — per-block flatten,
  fold, match, rebuild — with six regression tests including the wikilink-chip case that was the
  ordinary one.
- **`scripts/verify_completion.py` was only added to** in this range (two E2E tags). No tag,
  root, or forbidden import was removed or weakened.
- **No renderer path receives or builds a filesystem path** on any of the new channels:
  `document:getSnapshotText` returns text and a hash, `webpage:selection` returns a document id
  and words, `link:findForDocument` and `graph:focus` return ids and titles.
- **No test was deleted** to make room for the new ones; `tests/e2e/graph.spec.ts`'s 165 removed
  lines are helpers that moved to `tests/e2e/support/corpus.ts`, and all six of its tagged tests
  are still there.
- 701 unit/integration tests pass on a clean tree at `f934770`.
