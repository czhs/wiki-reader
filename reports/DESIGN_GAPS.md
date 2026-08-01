# Design gaps

Written by driving the built app under `WR_BACKGROUND=1` and screenshotting every surface it
has. Each entry is a **proposal, not an implementation** — the concept, why it matters, and
roughly where the decision lives. Numbers are stable: `docs/MILESTONE6.md` refers to them.

The researcher's `Descision:` lines are the spec's voice. A gap with one is decided and gets
built; a gap without one stays a proposal, and an improvement pass may take the small ones as
clarity work.

## Closed by milestone 6

The researcher decided these, and the milestone delivered them. Kept as a record of what the
criteria were answering, not as work.

| Gap | Decision | Where it landed |
|-----|----------|-----------------|
| 2 | "okay, but I will only ever do two side by side" | `V04` — the saved page's zoom lever (`snapshot.zoom`) |
| 3 · 14 | "the notebook does the heavy lifting… a full publishable paper" | `S01`–`S03` — the journal's block editor promoted, LaTeX, excerpts; the page takes the room |
| 8 | "render all days" | `V03` — `calendarMonths`, weekday-aligned grids, nothing folded |
| 9 | "highlights in a wiki must appear with a little bit of text" | `V01` — quoted labels, `DRAWN_KINDS` |
| 10 | "sounds good, I should also be able to link… in a notebook directly" | `E01` — Send to a notebook; `S03` — excerpts |
| 11 | "everything the librarian can do, the researcher can also do" | `E02` — `linkTypesFor` grew its `→ hypothesis` branches |
| 12 | "yes, definitely" | `E03` — `link:findForDocument` answers `{ entries, highlights }` |
| 15 | "good" | `V02` — `SceneFilter`, `matchesNeedle`, `panTo` |

## Fixed in the milestone-6 improvement pass

Small, unambiguous, and green (`typecheck`, `lint`, `test`, `test:e2e`).

- **Gap 4 — Back and Forward never said whether they could go anywhere.** They were always
  enabled; pressing Back on a fresh workspace did nothing and reported nothing. The gap said the
  history had to become observable first — it already was, one layer up: `Workbench` writes
  `canGoBack`/`canGoForward` into `ContextKeyService` on every navigation, and that service
  publishes its changes. So the two buttons now read the same context key their chords are gated
  on, through `useContextKey` (a `useSyncExternalStore`, not a value recomputed on store
  commits), and a disabled one says on hover *why* there is nowhere to go. Both print their chord
  as well, like the three pages beside them.
- **Gap 6 — the wiki drew a hierarchy it never explained.** A legend row under the controls:
  the hub disc, a file's disc, a marked sentence's quoted disc and a line, each drawn with the
  *same class and radius the canvas draws it with* — restyle a disc and the swatch moves with
  it — followed by what a click does. `Show` now says what it counts.
- **Gap 8's other half — `Begins` showed `mm/dd/yyyy` and printed the real answer underneath.**
  The field carried the *stored* value, which is null until someone sets it, so a journal that
  plainly begins today read as unset with an orphan `2026-08-01` below it. The field carries the
  resolved day now, and the line under it says only what the field cannot: whether that day was
  chosen or worked out.

## Fixed in the vision-alignment pass

Found by driving the built app against the researcher's sentences rather than the criteria.
Small, unambiguous, and green (`typecheck`, `lint`, `test`, `test:e2e`).

- **The page collapsed as soon as the paper outgrew the panel.** `.wr-blocks` is a flex item
  with an explicit `min-height`, which replaces the automatic minimum that keeps a flex item
  from being squeezed below its content — so past one screenful the block list was compressed
  into the room left over, its blocks overflowed the box, and the strip carrying `+ text`,
  `+ excerpt` and `Save page` was laid out a screen and a half above the end of the writing,
  painted across the middle of two paragraphs. Measured: an 1 812px page in a 414px box. `S01`
  passes at four template headings; a full paper is longer than a panel by definition.
  `flex-shrink: 0`, and both writing surfaces now grow with what is written.
- **`Sections` listed the paper's headings and did nothing with them.** An outline you cannot
  press is a table of contents for a document you still scroll by hand. Each heading is a
  control that goes there, addressed by ordinal rather than by slug — every block renders
  through its own `renderMarkdown`, so two blocks reading `## Method` are each slugged `method`
  while `notebookSections` calls the second `method-1`; the order is the thing both agree on.
  A panel control (`notebook.outline`), so the guide had to name it, which it now does.
- **Gap 17 — the guide's chip row made three kinds of thing look like one.** Three runs now,
  each with its own word in front: `Press`, `On the panel`, `Right-click`, and a menu chip is
  dotted where a control is dashed. The three-tier coverage model is the guide's best idea and
  the page teaches it instead of flattening it.
- **Gap 18 — the wiki promised highlights the map did not have.** A marked sentence reaches the
  map only once something links it, so a researcher who had just marked two of them was told the
  map was about highlights and shown none. When none is drawn the header reads *N files and
  notes* and says the one sentence that explains what would put one there.

## Open gaps

### 1. A graph in a side panel draws itself the size of a postage stamp

All three graph surfaces lay out into a fixed 1000×700 scene and let the SVG `meet` it into
whatever box the panel is. In a full-width panel the wiki reads beautifully. Measured in a
560px-wide ledger-beside-wiki layout it is a scale of about 0.56, drawn into a band 390px tall
inside a 1100px panel — 5px discs with 5px labels, and two thirds of the panel empty above and
below them. The picture that is meant to let you *choose a target by looking* is the one you
cannot read.

The concept is unchanged: the drawn bounds, not the nominal scene, should decide the viewBox —
fit what is actually there, with a margin, so the labels grow with the scale.

What this pass learned about the cost, which is why it stayed a proposal: `VIEW_WIDTH/2` and
`VIEW_HEIGHT/2` are *"the middle of the picture"* in four places at once — `centredOn`,
`toViewBox`, `viewBoxScale`, and `awayFromCentre` in the E2E support module, with three specs
asserting a filtered match lands at exactly 500/350. A fitted viewBox moves that middle. So the
work is "one number becomes a measurement, and every place that hard-codes it is taught to ask",
not a CSS change — real, worth doing, and not a same-afternoon fix.

### 5. "Remove" is shouted on every library row, and takes the title's width to do it

Every row carries a permanently visible `Remove`. It is the only per-row action, it is
destructive, it costs each row about 70px of a 280px sidebar — so every title truncates around
24 characters ("The neighbor-joining metho…", "Early Data Exposure Improv…") while the word
nobody wants to click repeats eight times straight down the column.

The original concept — actions on hover and focus — **runs into a decision already recorded in
`packages/shared-ui/src/styles.css`**: a control that appears only on hover cannot be found by
someone who does not already know it is there, and cannot be reached without a pointer at all.
That argument is right, so the remedy has to be a different one. The shape that satisfies both:
the title spans the row's whole width on line one, and the action drops to the right-hand end of
line two beside the authors, where it is still always visible and always focusable. Worth
measuring first — it buys about 24 characters of title, which is real but does not on its own
tell two rows of the same paper apart (see gap 19).

### 7. Tabs only accumulate

An hour of ordinary use put eleven panels in one group with the strip scrolled sideways.
There is `Close Tab` and `Close Group`, both on chords, and no "close the others", no middle
click, no overflow menu listing what is open. The strip is the only index of the workspace and
it is the first thing to stop being one.

The concept: an overflow list that names every open panel, and a close-the-others action.
Note what `O01` changed about the price: a new command is not done until a guide chapter names
it, and `guide.test.ts` fails until it does. That is the rule working, not an obstacle — but it
means this gap is "two commands, a menu entry and a paragraph", not "two commands".

### 13. Nothing in the reader says a highlight has become structure

A highlight that is one end of five links is drawn exactly like one nobody has ever used — same
bar in the margin, same card in the sidebar. `AnnotationCard` already carries a note count for
exactly this reason; the links are the other half of it and are not counted. Where reading
happens is where the accumulation should be visible, or it is not accumulation as far as the
reader is concerned.

The number is already computed and already crosses the wire: `DocumentLedgerHighlight.links`,
in the `highlights` array `link:findForDocument` answers with (`E03`). So the concept is a hook
beside `useNoteCounts` keyed on the open document, a badge next to the note badge, and — the
part worth deciding — whether pressing it should open the ledger scrolled to that highlight's
group, which the ledger cannot currently be asked to do.

## Found in the milestone-6 pass

New, and open-ended. Each is one screenshot's worth of noticing, not a plan.

### 16. A new notebook's page is four headings and no invitation to write under them

A notebook starts with `What I want to know`, `Background and prior work`, `Hypotheses` and
`Experiment log`, each a block with nothing beneath it and ~100px of air before the next. A
block is editable by clicking it, and nothing at rest says so — the hover border appears only
after you have already guessed. The only visible way in is `+ text`, at the foot of the page
several hundred pixels below the last heading, and it appends at the end rather than under the
section you were looking at. The journal solved the same problem with a sentence, but only for
an *empty* surface (`emptyMessage`); a notebook page is never empty, so it never gets one.

The concept: a heading with nothing under it says what belongs there in the section's own voice,
and starting to type there is the obvious gesture rather than the discovered one. The decision
is whether that prompt is a real block (which the markdown would then carry) or chrome the
editor draws over an empty section.

### 19. Two rows in the library can be the same paper twice, and nothing tells them apart

Two Zotero items with the same title render identical two-line rows: same truncated title, same
`PDF · Feng, Ghosal, Springer, Zh…`. Real libraries have duplicates, and the app currently gives
the researcher no way to see which is which short of opening both.

The concept: when a row's two lines are not unique in the list, it earns a third fact — the
year, the collection it came from, or the file it opens. Related to gap 5 but not solved by it:
more width shows more of the same string.

## Vision alignment

Driven again after every criterion was green, against the researcher's own words rather than
against the criteria: *the journal is tweets to oneself, the notebook is where a full
publishable paper gets written, reading flows into it, the wiki is a map of the reading, the
graph is how you get somewhere, the guide shows every feature.* These are the places the letter
passed and the sentence did not. Open-ended, and none of them is a criterion.

### 20. The paper is the one thing in the library search cannot find

Searched the running app for a phrase written into a notebook page and for one written into a
journal day: `Nothing matched`, twice. The same query over a paper answers with two passages.
The notebook's title does not match either. `SearchIndexer` projects documents, chunks,
annotations and notes; `questions.body` and `journal_entries.markdown` are not among them, and
the search page's idle line — "every paper, saved page, note and highlight" — is honest about
it. So the app indexes everything the researcher *read* and nothing they *wrote*, which is the
wrong way round for a milestone whose centre is that the notebook does the heavy lifting.

Where the decision lives: a projection beside `indexNote`, an entity type the result can carry,
and the part worth choosing — what a hit opens, since a notebook page has sections rather than
locations, and a journal hit belongs on its day.

### 21. There is no way to get the paper out of the app

A note is markdown in a folder the researcher picked, and the guide says so in its own chapter:
*a note is a file you own.* The paper is a `TEXT` column on `questions` (`007_notebooks.ts`).
Everything a publishable draft is made of is already there — markdown source, LaTeX that
typesets, figures addressed by file id, excerpts that carry their citation — and there is no
door: no export, no "write this page to my notes folder", no print. "Publishable" is a claim
about a document leaving the building.

Where the decision lives: whether a notebook page becomes a file the way a note is one (which
answers this and gap 20 at once), or stays a row with an export beside it.

### 22. A notebook knows exactly which papers it is built on, and never prints them

The desk is typed edges to files and marked sentences; every excerpt writes a
`question-references-annotation` edge beside the quote. That set *is* the bibliography, and the
page renders it as cards on a board and as `annotation://` chips in the prose. A paper ends with
its references, and this is the one section the app could write for itself and check for the
researcher — which of the things on the desk the draft actually cites.

Where the decision lives: `question:notebook` already answers with the cards; the choice is
whether references are a section the page draws or a block the researcher inserts and keeps.

### 23. A journal that began today is a month grid with one box in it

`calendarMonths` lays out from where the journal begins to today, which for a notebook started
this morning is a single day — drawn under `S`, with the weekday row above it and the rest of
August absent. The rule the researcher gave was "render all days"; the month a new notebook is
shown does not read as a month. The days it cannot offer are the ones that have not happened,
which is worth saying rather than leaving blank.

---

The two milestone-5 passes fixed a dozen smaller things — an unpainted highlight over a
wikilink, a clipped graph toolbar, a one-glyph-wide queue title, three empty panels that read as
broken ones. They are in git and in `state/iteration_ledger.jsonl`; a list of them here would be
a second copy that goes stale.
