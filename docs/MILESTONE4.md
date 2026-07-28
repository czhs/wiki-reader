# Milestone 4 — field notebooks, a library you curate, a graph you can work

Milestone 3 gave the app a queue, a journal and a librarian. The queue holds *questions* —
title, status, hand-chosen order, next action — and nothing else. There is no page behind a
question, which is the thing the whole notebook is for.

Four parts. The notebook is the headline; the rest is what using the app for a week surfaced.

1. **Field notebooks** — a page behind every question.
2. **A library you curate** — add and remove things, so it holds what you are working on.
3. **A graph you can work** — move it, resize it, name and illustrate its nodes.
4. **Links and notes you can find** — the mechanisms exist; nothing points at them.

## Rules

- **Never modify `~/Zotero/zotero.sqlite`.** Removing a document removes it *here*. Re-import
  must not resurrect it, which means a removal is recorded, not just a deleted row.
- **Ground truth stays read-only to agents.** Notebook prose is the researcher's; the librarian
  cites it and never edits it.
- **Hypotheses are what the librarian's evidence attaches to.** That is the point of making them
  entities rather than prose, and `A08` becomes useful the moment they exist.
- **Card art is the second exception to local-first, and it is bounded.** Off by default,
  disclosed before the first fetch, one allow-listed host, image bytes only, cached to disk so
  an icon is fetched once. The renderer never fetches — the main process does, and serves the
  result over `rrfile://` like every other byte. `README.md` names both exceptions.
- Everything else in `docs/SPEC.md` is still later.

## Criteria

### Field notebooks

| Tag | Criterion | Kind |
|-----|-----------|------|
| N01 | A question has a markdown body that is edited in-app and survives restart | integration |
| N02 | The body keeps its sections — question, background, hypotheses, log | unit |
| N03 | A notebook page carries description, importance, started, next action, tags, cover | integration |
| N04 | A hypothesis is an entity on a question, with its own id and status | integration |
| N05 | Evidence links to a hypothesis, supporting or opposing, and is cited | integration |
| N06 | A question's desk board holds hand-placed cards, and the arrangement survives restart | E2E |
| N07 | A dropped file becomes a card on the board without leaving the researcher's disk | E2E |
| N08 | A question's notebook is reached from the queue, and the page names its question | E2E |

### A library you curate

| Tag | Criterion | Kind |
|-----|-----------|------|
| B01 | A document is removed from the library, and a re-import does not bring it back | integration |
| B02 | A file on disk is added to the library without going through Zotero | E2E |
| B03 | Removing a document leaves its annotations and links recoverable, not silently destroyed | integration |
| B04 | `~/Zotero/zotero.sqlite` is untouched by every one of the above | integration |

### A graph you can work

| Tag | Criterion | Kind |
|-----|-----------|------|
| G01 | The graph pans and zooms, and the view survives reopening the panel | E2E |
| G02 | Graph settings — spacing, labels, depth — are changed and persist | E2E |
| G03 | A node takes a display name that does not rewrite the document's title | integration |
| G04 | A node takes an icon from a local image, served over `rrfile://` | E2E |
| G05 | Card art is off by default; enabling discloses the host, and a fetched icon is cached | integration |
| G06 | A document's highlights are drawn grouped with it, and edges cross between groups | E2E |

### Links and notes you can find

| Tag | Criterion | Kind |
|-----|-----------|------|
| K01 | Two documents are linked from the reader, with a typed relationship | E2E |
| K02 | A note is created from the reader and lands linked to what it was made from | E2E |
| K03 | Every action with a keybinding is discoverable without already knowing the key | E2E |

## The ones that hide a bug

`B01` — deleting the row is the obvious implementation and it is wrong: the next Zotero import
sees an item it has no record of and recreates it. Assert removal *then re-import*.

`B04` — the invariant everything else rests on. Hash the Zotero database before and after.

`G03` — a display name that writes through to `document.title` will be overwritten by the next
import, silently. Assert the title is unchanged.

`G05` — assert the *second* request for the same art does not leave the machine.

`G06` is a layout with a claim in it: a highlight belongs to the paper it came from, so the
graph should say so structurally rather than leave the reader to infer it from edge lengths. A
document becomes a container holding its highlights; edges run between containers as well as
into them. Cytoscape has compound nodes for exactly this, so the work is in the query returning
parentage — not in drawing rectangles by hand.

`N05` — the same trap as `A04`: evidence-shaped text is not evidence. Resolve every citation.

`N08` is here because the first question asked about notebooks was *how are they accessed?* —
`U05` and `K01`/`K02` again. A feature nothing points at is a feature nobody has. A question in
the queue is the door; assert that opening one lands on its page, and that the page says which
question it is.

Milestone 3 is complete, and every tag above is now armed in `scripts/verify_completion.py`.
Strengthening it is required; weakening it is never allowed.
