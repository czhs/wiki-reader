# Milestone 4 — field notebooks, library curation, a workable graph

Design agreed 2026-07-27. Criteria in `docs/MILESTONE4.md`.

## Field notebooks

Milestone 3's `Question` is a queue row: title, status, `ordinal`, `importance`, `nextAction`,
`discardedReason`. There is no body, so there is nowhere to think. Fieldstation's
`_notebook/*.md` is the thing being migrated, and all four of its parts are wanted.

**Prose body** (`N01`, `N02`). Markdown, edited in-app, stored as source. Fieldstation learned
this the hard way: it began with `contenteditable` storing rendered HTML and had to migrate to
markdown source with a turndown seeding step, because HTML in a store is not editable anywhere
else. Store source from the start. The conventional sections — the question, background and
prior work, hypotheses, experiment log — are a *template*, not a schema: a page that drops one
is still a page.

**Front matter** (`N03`). `description`, `started`, `tags`, `cover` join the fields the queue
already has. These are what make the active list readable at a glance.

**Hypotheses as entities** (`N04`, `N05`). This is the one with leverage. While a hypothesis is
prose inside a body, the librarian can cite a *page* but not a *claim*, and `A08` — evidence for
and against — has nothing precise to attach to. Making a hypothesis an entity with an id turns
"evidence for and against a question" into "evidence for and against this specific claim", which
is the thing a research notebook is actually for. It links through the existing `links` table
like everything else; no second relationship mechanism.

**Desk board** (`N06`, `N07`). Hand-placed cards per page. Fieldstation stores positions keyed
by card id and only once a card has been dragged, which is worth copying — a default position is
not a decision and should not be recorded as one. Dropped files stay where they are on disk; the
board records a reference, because a notebook that copies gigabytes of PDFs into its own store
stops being local-first in the way that matters.

## A library you curate

The library currently mirrors a whole Zotero library, which for this researcher means a decade
of phylogenetics sitting on top of the interpretability work actually in progress. `C01` scoped
*import*; this is about the library after import.

**Removal is recorded, not deleted** (`B01`). A deleted row is recreated by the next import,
which sees an item it has no memory of. So removal writes a tombstone in `external_references`
— the table that already exists to remember "this Zotero key is that internal id" — and the
importer honours it. `B01` asserts remove-then-reimport, because remove-then-look is the test
that passes against the wrong implementation.

**Removal is reversible** (`B03`). Annotations and links are the researcher's own work and are
not Zotero's to take away; removing a document must not destroy them. Soft-delete, as
`deleted_at` already does elsewhere.

**Adding without Zotero** (`B02`). A file on disk becomes a document directly. Zotero is one
source, not the definition of the library.

**And none of it touches Zotero** (`B04`). Hash `zotero.sqlite` before and after. This is the
invariant with the most ways to violate it by accident.

## A graph you can work

`G01`/`G02` are the plain gaps: no pan, no zoom, no settings, and the view resets when the panel
reopens.

**Display names** (`G03`) alias the node; they do not rewrite `document.title`. A title that
came from Zotero will be overwritten by the next import, so writing a chosen name there loses it
silently — the failure mode that makes the feature worse than not having it.

**Icons** (`G04`, `G05`). An icon is a local image served over `rrfile://`, like every other
byte the renderer sees. Any folder of images works.

Card art is the second exception to local-first, and it was chosen deliberately with the
alternative in view: the Cockatrice install here has `cards.xml` (29,267 cards) but an empty
`pics/`, because Cockatrice fetches art on demand. There is no local art to search.

So the exception is bounded to keep the structure of the invariant intact:

- **off by default**, and enabling discloses the host first — the same shape as agents;
- **one allow-listed host**, image bytes only;
- **fetched in the main process**, never the renderer, so the renderer's CSP is unchanged and
  the bytes reach it over `rrfile://` like everything else;
- **cached to disk** — `G05` asserts the second request for the same art never leaves the
  machine;
- no referrer, no cookies, no telemetry.

`README.md`'s local-first sentence names both exceptions. A promise with an unlisted exception
is worse than a narrower promise.

## Links and notes you can find

`K01`/`K02` are discoverability, not capability. Typed links and notes have existed since
milestone 1 and are reachable from the reader by nobody who did not read the source. The work is
an affordance where the material is — a selection, a document, a hypothesis — not a new
subsystem.

`K03` generalises it: a keybinding that is the *only* way to reach an action is a feature only
its author has. Every action with a key should be reachable without knowing the key, and should
say what the key is when you get there.

## Sequencing

Notebooks first — hypotheses are what the librarian's evidence attaches to, so `N04`/`N05`
make `A08` mean something. Library curation next, because a library full of unrelated work makes
every other feature noisier. Graph and discoverability after.

## Open

- **The reviewer agent** — still deferred. Its lens is a reading list; see `docs/AGENTS.md`.
- **Whether the librarian may write notebook prose.** It may not, today. Hypotheses give it
  somewhere precise to attach evidence *without* editing the researcher's thinking, which is
  probably the right long-term line, but it is worth revisiting once used.
