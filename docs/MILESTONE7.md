# Milestone 7 — one page to write in, links without ceremony, one graph

The researcher's feedback of 2026-08-01, verbatim in spirit: the notebook is one scrollable
document — desk, front matter, sections, hypotheses, journal all live *in* it or pop over it,
never beside it. A link is just a link. The wiki is the one graph, whole or focused. Demo
content fills every surface while we develop.

## Rules

- **No proposal backlog.** `reports/DESIGN_GAPS.md` is retired. Improvement passes fix the
  small and obviously right, or leave it for the researcher to rule on in feedback.
- **Supersessions.** These earlier criteria are re-promised here; their verifier titles are
  updated and their tests move with them — an audit reads this list before calling regression:
  `K01` (no typed-relationship choosing → H05) · `N06`/`N07`/`E01` (the desk retires; things
  land as blocks → P06) · `N09` (journal tab → pop-up that can expand, P09) · `I01` (confirmed
  delete → trash bin, U11) · `V01` (one-line snippet → enough text, F06).
- **Card art keeps its discipline**: one allow-listed host, disclosed, cached, art crops only —
  never a whole card image.
- **The demo corpus is synthetic**, seeded only in development, cleared by one action, and
  never committed as if it were the researcher's library.
- The links table keeps its typed edges — the *UI* stops asking. Derived and librarian edges
  are untouched. Everything else in `docs/SPEC.md` is still later.

## Criteria

### The notebook is one document

| Tag | Criterion | Kind |
|-----|-----------|------|
| P06 | Send-to-notebook and drops land as formatted blocks in the page; the desk is gone | E2E |
| P07 | Blocks are deleted and rearranged by drag | E2E |
| P08 | A new journal day arrives with its first block ready to type in | E2E |
| P09 | The journal opens as a pop-up, and can expand into the full page | E2E |
| P10 | Front matter, sections and hypotheses are scroll-to sections of the page, not a side panel | E2E |
| P11 | An image in a block is resized by hand | E2E |
| P12 | Cmd+S saves the notebook page | E2E |

### A link is just a link

| Tag | Criterion | Kind |
|-----|-----------|------|
| H05 | Linking asks nothing about kind — a link is a link | E2E |
| H06 | The picker expands a chosen document to search its highlights, or says there are none and links the document | E2E |
| H07 | A link is deleted wherever it is seen | E2E |
| H08 | A highlight dragged onto the reader beside it links the two | E2E |
| H09 | Dragging between two graph nodes links them | E2E |

### One graph

| Tag | Criterion | Kind |
|-----|-----------|------|
| F04 | The wiki opens filling the page, docks to a side by its tab, and keeps its scale when docked — showing less, not smaller | E2E |
| F05 | The graph is the wiki focused: one surface, whole or focused on a node | E2E |
| F06 | A wiki highlight shows enough of its text to know what it is — not one line | E2E |
| F07 | The librarian pops up from the wiki; it has no sidebar | E2E |

### The shell obeys the hand

| Tag | Criterion | Kind |
|-----|-----------|------|
| U09 | Panels and sections minimize and drag-resize; the annotations panel closes | E2E |
| U10 | A search result is clicked and goes there | E2E |
| U11 | Delete moves to a trash bin, and the bin can be emptied | E2E |

### Shown, not told

| Tag | Criterion | Kind |
|-----|-----------|------|
| D03 | Every command on the help page shows an animation of itself in action | E2E |
| B06 | The icon picker is a gallery scroller of Modern Horizons 3 art — art crops only, cached | E2E |
| B07 | A demo library fills every surface in development, and one action clears it | E2E |

## Found by using it (2026-08-02)

| Tag | Criterion | Kind |
|-----|-----------|------|
| U12 | Tabs render at their intended height — not offset upward, fully visible and hit-able | E2E |
| H10 | A highlight is painted on the saved web page itself, where the text is | E2E |
| F08 | The graph lays out by force — nodes push apart and none overlap at rest | E2E |
| F09 | Focusing centers the view on the node; nothing is hidden, only de-emphasized | E2E |

`H10` — the archive frame is script-free and stays that way; the snapshot can be marked at
serve time in the main process (`rrfile://` already resolves the document and its anchors).
`F09` — focus reframes and emphasizes; it stopped being a filter the day it became a state of
the wiki.

## The ones that hide a bug

`P06` — the desk's data (cards are `question-references-…` edges) migrates into blocks; nothing
the researcher placed is lost. `E01`/`N06`/`N07` re-anchor on the block landing.

`H05` — the choosing UI goes; the edge quietly keeps a type (`related-to`) so nothing else
breaks. `H06` is the picker's second stage: highlights of the chosen document, searchable, or
an honest "no highlights — linking the document".

`F04`/`F05` — merging surfaces, not adding one. The focused view and the per-file link panel
become states of the wiki. Docked means same scale, smaller window onto it.

`U10` — search results navigate today via a button nothing points at; a click on the result
row itself must go there.

`D03` — the guide's motion machinery exists (`guide.ts`, inline SVG, reduced-motion); what is
missing is per-command demos where the commands are listed. Help and guide may become one page.

`B06` — Scryfall's set listing gives the art-crop URLs; fetch through the existing card-art
path (main process, allow-listed host, cached beside the database), never the renderer.
