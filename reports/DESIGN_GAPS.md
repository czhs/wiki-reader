# Design gaps — milestone 5

Written by driving the built app under `WR_BACKGROUND=1` and screenshotting every surface it
has: the empty workspace, the library, the directory, a notebook page, a journal day, What
next, the librarian, the wiki, the focused view, a file's link graph, the help page, the
command list, all three readers, the annotations sidebar and search. Each of these is
something a researcher would hit in a first afternoon.

The small, unambiguous ones are already fixed and are listed at the bottom. Everything above
is a **proposal, not an implementation** — the concept, why it matters, and roughly where the
decision lives. None of it is a milestone-5 criterion, and none of it should be built without
being chosen first.

## Open gaps

### 1. A graph in a side panel draws itself the size of a postage stamp

All three graph surfaces lay out into a fixed 1000×700 scene and let the SVG `meet` it into
whatever box the panel is. In a full-width panel the wiki reads beautifully. In a side panel —
which is exactly the shape `F02`/`F03` produce, and the shape the link picker uses — the scene
scales to about a third, the layout puts a small graph near the centre anyway, and the result
is a cluster of 5px discs with 4px labels floating in an otherwise empty panel. The picture
that is meant to let you *choose a target by looking* is the one you cannot read.

The concept: the drawn bounds, not the nominal scene, should decide the viewBox — fit what is
actually there, with a margin, and floor the label size so text does not shrink with the
graph. Node positions stay in scene coordinates, so nothing about the layout or the specs that
assert on `data-x`/`data-y` needs to change; only the framing does.

### 2. A saved web page in a narrow panel is unreadable, and nothing offers a way out

`HtmlReaderView` lays the archive out at 1280px and scales it down to the panel, for a good
documented reason: below a site's own breakpoint the page correctly renders its phone layout
and drops its navigation. But in an 800px panel that is 0.63, and in the 400px panel you get
after opening the focused view beside it, it is 0.31 — body text at five pixels. The reader
has no zoom, no width control and no reading mode; the PDF reader beside it has all three.

The concept: the page keeps its own layout, and the researcher keeps a lever — a zoom that
scales the frame independently of the fit, or a "lay it out at the panel's width" toggle that
says plainly what it trades away. Whatever the lever is, the invariant that the document
renders in its original form is not what is in question here; the fixed shrink is.

Descision: okay, but I will only ever do two side by side, plus maybe something on the bottom.

### 3. The notebook's page is a textarea; the journal's day is not

Milestone 5's first rule is that the notebook is the paper. The journal earned blocks, a
caret that lands where you clicked (`P05`), pictures, and code you can copy. The notebook's own
page — the thing the rule is named after — is a monospace `<textarea>` pre-filled with four
`##` headings, with the outline rendered as small grey text above it that is not a control.
Two ways of writing, in the same product, one screen apart.

The concept: one writing surface. Either the day's blocks move up to the notebook page, or the
notebook page's outline becomes real navigation over real sections. Choosing which is the
work; having two answers is the gap.

Descision: I don't think this is getting through. the daily notes are like tweets of what I did that day, notes to myself. The notebook
does the heavy lifting, and it should be designed so that I can write a full scientific paper in them, that is Latex, linking, codeblocks,
md, images.

### 4. Back and Forward never say whether they can go anywhere

`workbench.history.canGoBack` and `canGoForward` already exist, already gate the keybindings,
and the help page already prints "only when there is somewhere to go back to". The two status
bar buttons ignore all of it: they are always enabled, and pressing Back on a fresh workspace
does nothing and reports nothing. A control that is always available and sometimes inert
teaches you to distrust the whole bar.

The concept: the buttons read the same context keys the chords do. The reason this is a
proposal rather than a fix is that the status bar re-renders on store commits, and history is
not in the store — a Back button that is stale-disabled would be worse than one that is
always-enabled, so the history has to become observable first.

### 5. "Remove" is shouted on every library row, and takes the title's width to do it

Every row in the library carries a permanently visible `Remove`. It is the only per-row
action, it is destructive, and it costs each row about 70px of a 280px sidebar — so every title
truncates around 24 characters ("The neighbor-joining metho…", "Early Data Exposure Improv…")
while the word nobody wants to click repeats eight times straight down the column. Two rows in
the fixture are indistinguishable from each other because the part that differs was cut.

The concept: row actions appear on hover and focus, the way the rest of this app's quiet
controls do, and the title gets the width back. If removal should stay visible, then it should
be earning that permanence against something — and the second line (authors, type) is a better
candidate for the space than a verb.

### 6. The wiki draws a hierarchy it never explains

On the wiki page some nodes are large and filled and most are small and hollow. That encodes
"one of the most-linked things here" (`rank < HUBS && degree > 0`). Nothing on screen says so,
nothing says an edge is a wikilink rather than any other typed edge, and nothing says a node
opens when you click it. The `Show 150` control does not say what it counts, and the "N more
not shown" line only appears once you are already past the cap.

The concept: a one-line legend in the toolbar's own row — what a big disc means, what a line
means, what a click does. It is three phrases, and it is the difference between a picture you
read and a picture you look at.

### 7. Tabs only accumulate

An hour of ordinary use put eleven panels in one group with the strip scrolled sideways;
opening the journal, the wiki and the focused view each add one and nothing ever removes one.
There is `Close Tab` and `Close Group`, both on chords, and no "close the others", no middle
click, no overflow menu listing what is open. The strip is the only index of the workspace and
it is the first thing to stop being one.

The concept: an overflow list that names every open panel, and a close-the-others action. The
command registry already has everything needed to run them.

### 8. The journal's calendar reads as a broken control

The day strip renders as `20 21 · 9 days · 31` — two dates, an elision, today. It is a
sensible compression of a sparse month, and it does not look like one; it looks like a
calendar that failed to load. Beneath it, `Begins` is a native `<input type="date">`, which in
a dark app renders in the platform's own light chrome, shows `mm/dd/yyyy` regardless of
locale, and is followed by an unlabelled `2026-07-20` that is in fact the resolved answer.

The concept: the strip says what it is compressing ("2 days written, 9 skipped"), and the
start date is one control that shows the date it resolved to rather than a field plus a bare
date under it.

Descision: render all days.

## Vision alignment

A second pass, reading the milestone-4 and milestone-5 criteria against what the researcher
said the app is *for*: the notebook is where the science collects, with a journal attached to
it; the wiki is articles **and highlights** crawled the way a person browses; the graph is a
way of getting somewhere, not a picture; highlights link to files and to each other so that
reading accumulates into structure. Every criterion below passes. These are the places where
it passes and the sentence above is still not true. Proposals, not work items.

### 9. The wiki is a map of files; the highlights are not on it

`F01` says "the whole graph at once", and the page delivers exactly that for documents and
notes — its own header says "12 files and notes". The focused view shows one file's highlights
(`F02`); the neighbourhood panel boxes them with their paper (`G06`); the library's map shows
none of them.

This one is a *decision to revisit*, not an oversight: `GraphRepository.overview` says so in
as many words — "a corpus drawn with every highlight in it is a picture of the annotations" —
and refuses, for the same reason, to redraw a highlight-to-highlight edge as a line between
the two papers. Both halves are defensible and together they mean the map cannot show the one
connection this milestone added. Two papers joined because a sentence in one bears on a
sentence in the other (`H02`) look, on the wiki, exactly like two papers that have never met.

The concept: the map admits marked sentences, and the cap starts meaning something other than
"150 of one kind of thing" — highlights inside their paper the way `G06` draws them, or a
paper's degree counting the edges its highlights carry so the busiest reading rises. The
decision lives in `graph:overview` and its ranking, not in the panel.

Descision: highlights in a wiki must appear with a little bit of text that was highlighted so it is easy to tell them
apart from page nodes.

### 10. Reading does not flow into a notebook

There is no gesture anywhere in a reader that puts what you are reading into a notebook. The
selection strip offers Link highlight…, Links… and New note on highlight; the ledger links a
file or a highlight to another file or highlight; the desk board is the only door into a
notebook and it opens the other way — a dropdown of up to 200 document titles, on the notebook
page, holding documents only. `question-references-annotation` is a link type the app already
knows and nothing in the UI can create one, so the unit the whole milestone is about cannot be
put in the place where the science collects.

The concept: "send this to a notebook" belongs beside "link this" and "note on this", takes a
highlight as readily as a file, and lands as a card on that notebook's desk.

Descision: sounds good, I should also be able to link (insertnig the text) in a notebook directly

### 11. A hypothesis cannot be given evidence by hand

Milestone 4's rule was that hypotheses are what evidence attaches to. The notebook page draws
*For* and *Against* under every claim, `handlers.ts` resolves both, and the four
`…-supports-hypothesis` types are in the vocabulary — but the link picker's targets are the
library's files and highlights, and its relationships are "bears on" and "related to". So the
two lines under a claim can only ever be filled by the librarian, and a researcher who has just
marked the sentence that settles their own hypothesis has nowhere to put it.

The concept: a claim is a target the picker can offer, and when the target is one the
relationship list is supports/opposes. The vocabulary and the reader are both already there;
what is missing is that the picker cannot see a hypothesis.

Descision: yes, everything the librarian can do, the researcher can also do

### 12. The ledger cannot see a highlight until something else already has

`H03` asks the ledger to gather the links on a file *and* on its highlights, and it does — it
groups by highlight, over the entries that came back. A highlight with no links yet produces no
group, so the "Link this highlight…" button exists only where linking has already happened. A
paper with six marked sentences and no edges reads "Nothing is linked to this file yet", on the
page whose whole reason for existing is that seeing what a paper is connected to is when you
notice what it should be connected to.

The concept: the ledger lists the file's highlights whether or not they carry an edge.

Descision: yes, definitely.

### 13. Nothing in the reader says a highlight has become structure

A highlight that is one end of five links is drawn exactly like one nobody has ever used —
same bar in the margin, same card in the sidebar. `AnnotationCard` already carries a note
count for exactly this reason; the links are the other half of it and are not counted. Where
reading happens is where the accumulation should be visible, or it is not accumulation as far
as the reader is concerned.

The concept: the count is on the card, and clicking it is the way into the ledger's group for
that highlight.

### 14. The notebook's page is the smallest thing on its own page

Related to gap 3, but about the layout rather than the editor. On a 1440px window the notebook
page spends its top third on Description / Next action / Tags, gives the prose a fixed ~270px
box, and then hands the same height again to an empty desk. "The paper written in realtime" is
the smallest region on the page named after it, and it is the only one that cannot grow. The
journal made this move already (`N09`) — the day's entry takes the width and everything else
became margin.
The concept: the same shape here. The page takes the room; the front matter, the desk and the
claims are the margin.
Descision: I dont think this is getting across. Notebooks are verry important places where I must have the ablity to basically write a full publishable
scientific paper
### 15. The graph is a picture until you can find something in it

The wiki shows 150 nodes with no way to ask for one. There is no filter, no "find", no way to
get from a title you can remember to the disc that stands for it — so the only way to use the
map is to already be able to see what you want. "A navigation tool, not a picture" is the
difference between a map you scan and a map you search.

The concept: one filter box that dims what does not match and pans to what does — the same
gesture the file palette already is, over the surface the researcher is looking at.

Descision: good

## Fixed in the alignment pass

Small, unambiguous, and green (`pnpm typecheck`, `lint`, `test`, `test:e2e`).

- **A highlight over a sentence containing a `[[wikilink]]` was never painted.** The renderer
  looked for the quote inside one run of plain text, and a chip, a bold word, a piece of inline
  code or a hard-wrapped source line all break the run — so on a wiki page, where most sentences
  contain a link, the highlight existed in the sidebar, in the focused view and in the database,
  and the page the researcher was looking at showed nothing. `render.tsx` now paints per block:
  the block is flattened to atoms, folded the way `normalizeText` folded the quote, matched, and
  rebuilt with the marks in it — a run of text is cut, a chip is wrapped whole.
  `tests/integration/markdown-highlight-painting.test.ts` covers chips, wrapping, emphasis,
  inline code and folded punctuation.
- **A notebook and its journal were two tabs with the same name.** The journal titled itself
  `<notebook> — today`, and a tab strip truncates the tail, so both read "Does spacing beat
  massin…". It is `Journal · <notebook> — <day>` now, the way `Focus · <file>` and
  `Links · <file>` already read.
- **Neither the notebook page nor its journal pointed at the other.** The directory's row has
  both doors and the two pages had none between them: the journal printed its notebook's name
  as inert text and the notebook page said nothing about its log. Both are commands now — the
  same ones the directory runs.
- **A notebook made in the evening said it started tomorrow.** `started` sliced ten characters
  off a UTC instant, which is the trap `JournalRepository.start` documents on the other side of
  the wire. `localDay` in `journal-calendar.ts` is now the one answer for both.
- **The wiki, the focused view and the link graph were filed under "Links".** On the help page
  they sat between "Copy Internal Link" and "Find Incoming Links" — link plumbing, not the three
  places the milestone is about. They are a `Graph` category now, which is what the help page
  groups by.

## Fixed in the previous pass

Small, unambiguous, and green (`pnpm typecheck`, `lint`, `test`, `test:e2e`).

- **A highlight on markdown or a saved web page was labelled "Anchor broken" the moment it was
  made.** Only the PDF reader publishes anchor resolutions; `AnnotationList` collapsed "the
  reader reported failure" (`null`) and "no reader reported" (absent) into the same value, so
  the sidebar struck through a highlight the researcher could see on the page in front of them.
  `describeAnchorHealth` now has a fourth state, `unknown`, which shows no badge at all —
  because a warning that fires on absence of evidence is the fastest way to teach someone to
  ignore warnings. `packages/annotations/src/anchor-health.test.ts` covers all four.
- **The graph toolbar clipped its own controls.** `.wr-graph__settings` did not wrap, so in a
  narrow panel — the normal shape for the focused view — `Hops`, `Spacing`, `Labels` and
  `Reset view` were past the edge, unreachable and unannounced. It wraps now.
- **Every notebook in "What next" wrapped one character per line.** Six grid columns in a 280px
  sidebar left the title column a single glyph wide. The row is a wrapping flex row now; the
  status and its two actions travel together and drop under the title when they do not fit.
- **The search panel showed a field and then nothing**, which reads as a panel that failed to
  load. It now says what it searches and what a result does, and "no results" suggests what to
  try instead.
- **The journal's "Advances" heading stood over an empty space.** It now says what would appear
  there, and which of the two reasons it is empty for.
- **Two-word buttons broke in half** when their container squeezed — "New / notebook", "New note
  on / highlight", "Card / art…" — and "Put on the board" was clipped mid-label by a select that
  claimed the whole row. Buttons keep their label on one line; the two picker rows give the
  button its width first.
- **The empty workspace was a dead end**: one faint sentence pointing at a sidebar that may not
  be open. It now offers the three ways in — the notebooks, a file by name, the wiki — as the
  same registered commands a chord runs, with the chord printed beside each, so the mouse is
  also how the keyboard gets learned.
