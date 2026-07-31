# Milestone 5 — the notebook is the paper, the wiki is a place, a graph you can crawl

A week of use surfaced the real shape: the notebook is where the science collects — thoughts,
methods, the paper written in realtime — and everything else is a way in, or a view of its
connections. Three parts.

## Rules

- **"Question" retires as a word the researcher must know.** Milestone 3 made the unit of work
  a question with a page behind it; the researcher does not know what a question is. The unit
  is the notebook. Keep what earned its place — status, ordering, hypotheses, the queue's role
  as a front door — and dissolve the vocabulary. How is yours to decide.
- **The journal belongs to its notebook.** Daily entries are one notebook's log, not a global
  stream. The directory of notebooks is therefore also the directory of journals.
- Everything in milestones 1–4 still gates. Everything else in `docs/SPEC.md` is still later.

## Criteria

### The notebook is the paper

| Tag | Criterion | Kind |
|-----|-----------|------|
| P01 | A directory page lists every notebook, and opening one lands on its page | E2E |
| P02 | A day's journal entry belongs to the notebook it was written under | integration |
| P03 | A journal's start date is the researcher's to set, and the calendar begins there | E2E |
| P04 | An image is inserted into a notebook block, and the bytes stay local | E2E |
| P05 | Clicking into a block puts the caret at the click, not at the start of the box | E2E |

### The wiki is a place, the view is focused

| Tag | Criterion | Kind |
|-----|-----------|------|
| F01 | The wiki is its own page: the whole graph at once, and clicking a node opens it | E2E |
| F02 | A file opens a focused view — its annotations center-stage, connected files at the edge | E2E |
| F03 | The focused view crawls: choosing a connected file refocuses on it, in the same view | E2E |

### Links that hold on

| Tag | Criterion | Kind |
|-----|-----------|------|
| H01 | A highlight is made on a saved web page, and it survives restart | E2E |
| H02 | A highlight links to a whole file, or to a highlight already made in another file | integration |
| H03 | A file's ledger gathers the links on the file and on its highlights, and the file itself is linkable from it | E2E |
| H04 | A link's target is picked from the graph — a file node or one of its annotations | E2E |

## The ones that hide a bug

`H01` — highlighting on saved web pages **is broken today**; find why before building on it.
The likely suspects are the sandboxed archive iframe and selection not crossing it.

`P05` — focus lands at the start of the box today. A click carries a position; honor it.

`F02`/`F03` — this is how a human crawls the library: one file in the middle, what it says
around it, where it leads at the edges. The whole-graph page (`F01`) and the focused view are
two surfaces, not one with a toggle. The main use of the focused view is `H02`/`H04`: picking
a highlight or a file to link to, by looking rather than by remembering a title.

`P02` — milestone 4 built the journal as one page. Its shape (calendar, blocks) was right; its
attachment was not. Move the shape, don't rebuild it.
