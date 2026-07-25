# Milestone 2 — the wiki

Implementation brief for the merged `docs/SPEC.md` scope. Read `docs/SPEC.md` for *what* is
required; this document is *how to build it, in what order, and how each part is proven*.

## Prerequisite

**Finish milestone 1 first.** Five E2E criteria remain (`M06`, `M07`, `M11`, `L02`, `L08`);
`state/NEXT_ACTION.md` names each failure with its line number. A working vertical slice is
worth more than a correct plan, and every criterion below assumes the slice runs.

Do not start milestone 2 while milestone-1 criteria are red.

## Why this milestone exists

This repository originated from `fieldstation/docs/wiki-reader-repo-research-brief.md`. The
frozen spec drifted from it, and 25 loop iterations executed faithfully against the drifted
version. `docs/SPEC.md` was amended on 2026-07-25 to merge the brief back in
(`state/DECISIONS.md`). Milestone 2 is that merge, implemented.

The product is not a document reader. It is a **living research wiki that grows out of
reading** — a corpus the user owns, annotated in place, cross-linked by hand and by an agent
that reads everything and proposes connections.

---

## Architectural changes

### New packages

| Package | Process | Responsibility |
|---|---|---|
| `@wr/corpus` | **main only** | Corpus scanning, project layout, slug resolution, `[[wikilink]]` extraction, ground-truth boundary enforcement |
| `@wr/markdown-reader` | renderer | `MarkdownAdapter` implementing `DocumentAdapter`; escape-first rendering; live wikilinks and tags |
| `@wr/agents` | **main only** | Librarian and reviewer orchestration, model provider abstraction, agent write mediation, run logging |

`@wr/corpus` and `@wr/agents` must be added to the verifier's `FORBIDDEN_RENDERER_IMPORTS`
alongside `@wr/database` and `@wr/zotero-adapter`. `@wr/markdown-reader` joins
`RENDERER_PACKAGES`. Update the repository layout table in `CLAUDE.md`.

### Database

Migration `002_wiki`: `projects`, `agent_runs`. Extend `documents` with a `source_kind`
(`ground-truth` | `agent` | `user`) and a `project_id`. Extend `links` so derived links are
distinguishable — `origin` already exists in the domain model; make sure it is persisted and
indexed, because the re-index sweep depends on deleting *only* derived rows.

**The database is an index, not the corpus.** Documents, journals, and agent notes are
markdown files on disk. Annotations and the bulletin board round-trip to files in the corpus.
Where a file and a row disagree, the file wins. A criterion is not satisfied by a design that
cannot rebuild the database from disk.

### The invariant that matters most

Ground truth is the user's record of what a source actually said. Nothing — not ingestion,
not indexing, not an agent — may modify it. This is the one place in the product where a bug
destroys data the user cannot regenerate, which is why it is built first and tested hardest.

Field Station's own librarian contract concedes its boundary is honour-based because the
tooling can write anywhere. Here it must be structural.

---

## Criteria

Tagged exactly like milestone 1: `it('[W01] refuses a write outside the agent workspace', …)`.
`[E2E]` criteria require a real Electron launch through Playwright.

### Phase 1 — Corpus foundation and safety

| Tag | Criterion | Kind |
|-----|-----------|------|
| W01 | The agent write mediator refuses a path outside the agent workspace | unit |
| W02 | The mediator refuses `..` traversal, symlink escape, and absolute paths | unit |
| W03 | A corpus scan indexes markdown files into documents with project and source kind | integration |
| W04 | The database rebuilds from disk with annotations and links intact | integration |
| W05 | A full scan leaves every ground-truth file byte-identical | integration |

### Phase 2 — Markdown reading

| Tag | Criterion | Kind |
|-----|-----------|------|
| W06 | Markdown text normalization is stable and matches the shared normalizer | unit |
| W07 | `MarkdownAdapter` creates and resolves a text-quote anchor | unit |
| W08 | A markdown highlight survives application restart | integration |
| W09 | An anchor created on a PDF resolves in that document's extracted markdown | integration |
| W10 | A markdown document opens in a tab and a selection becomes a highlight | E2E |

### Phase 2b — Original-form web snapshot reading

`packages/html-reader` is currently a 19-line stub that throws. Archived HTML was deferred out
of milestone 1 and — until this phase was added — was covered by no milestone at all. It
implements the **Presentation fidelity** section of `docs/SPEC.md`.

Tag numbers are not build order; see "Build order and why". This phase is built alongside
phase 2, because both are the same question: does the reader show the document as it is?

| Tag | Criterion | Kind |
|-----|-----------|------|
| W31 | A saved snapshot renders as the original page, loading its own images and stylesheets | E2E |
| W32 | `rrfile://` resolves a snapshot's relative resources and refuses references outside its directory | integration |
| W33 | A snapshot never fetches a remote origin, and a blocked fetch is logged | integration |
| W34 | The original is the default view; Readability is opt-in, labelled, and reversible | E2E |
| W35 | Opening a document that has an original file never presents its extracted markdown as the reading view | integration |
| W36 | A highlight created on a snapshot survives restart and re-anchors in the original view | integration |

### Phase 3 — Wikilinks and the graph

| Tag | Criterion | Kind |
|-----|-----------|------|
| W11 | `[[slug]]` parsing and `#tag` extraction, including escapes and code fences | unit |
| W12 | Slug resolution maps `[[slug]]` to a document, ambiguity reported not guessed | unit |
| W13 | Re-indexing replaces derived links and preserves manually created links | integration |
| W14 | An unresolved `[[slug]]` becomes a listed wanted page, not an error | unit |
| W15 | A neighbourhood graph query runs in main without loading the full graph | integration |
| W16 | The graph view renders nodes and edges and selecting a node reveals it | E2E |

### Phase 4 — Ingestion

| Tag | Criterion | Kind |
|-----|-----------|------|
| W17 | Import scoped to a named Zotero collection lands in that project's ground truth | integration |
| W18 | Re-ingesting an unchanged source is a no-op detected by content hash | integration |
| W19 | Sync never deletes a file it did not write | integration |
| W20 | URL-list ingestion produces a snapshot plus extracted markdown | integration |

### Phase 5 — Highlights

| Tag | Criterion | Kind |
|-----|-----------|------|
| W21 | Six preset colours are stored by name and a colour change persists | integration |
| W22 | An orphaned anchor is retained and listed, never silently deleted | integration |
| W23 | Field Station `annotations.json` imports without losing colour or comment | integration |

### Phase 6 — Agents

| Tag | Criterion | Kind |
|-----|-----------|------|
| W24 | With agents disabled, no code path performs a network request | integration |
| W25 | A librarian run writes connections, contradictions and open threads to the workspace | integration |
| W26 | A librarian run leaves every ground-truth file byte-identical | integration |
| W27 | Agent output is presented as a reviewable diff and rejecting it writes nothing | integration |
| W28 | The reviewer writes its critique to the workspace and does not modify the journal | integration |

### Phase 7 — Bulletin board

| Tag | Criterion | Kind |
|-----|-----------|------|
| W29 | Cards and edges round-trip to corpus JSON preserving author attribution | integration |
| W30 | The librarian cannot edit or delete a user-authored card | unit |

---

## Build order and why

**W01–W02 first, before anything writes to the corpus.** The mediator is the only thing
standing between an agent bug and the user's source material. Build it, test it adversarially,
then build everything that depends on it. Do not defer it because agents come later — the
ingestion pipeline should route through it too.

**W03–W05 next**, because everything downstream assumes documents can come from disk rather
than only from Zotero. W04 (rebuild from disk) is the criterion that keeps the design honest;
if it is hard to satisfy, the database has quietly become the source of record.

**Markdown before wikilinks** — wikilinks live inside markdown documents, and W13's
preserve-manual-links behaviour cannot be tested without documents to link.

**Snapshot reading (phase 2b) alongside markdown**, because they are the same question asked
of two formats: does the reader show the document as it is? Both must be settled before
ingestion, or the URL-list path (W20) will be built without anywhere faithful to display what
it fetched.

The fidelity criteria are easy to satisfy badly. `W31` passes trivially if the iframe renders
*something*; it is only meaningful if the page's own images and stylesheets load, so assert on
a resource that is actually referenced by the saved page. `W35` is the general guard — it
applies to PDFs as much as snapshots, and it is the criterion that catches a reader which
quietly falls back to extracted text when rendering fails. Failing loudly is correct there;
substituting silently is not.

**Ingestion after the corpus model**, not before. Scoped import is a small change to the
existing importer plus a destination path; doing it early, against a corpus model that does
not exist yet, means writing it twice.

**Agents last.** They are the most visible feature and the least foundational. Every safety
property they need (W01, W02, W05) is already proven by then, so the agent work is
orchestration and prompt design rather than security engineering.

---

## Implementation notes

### The write mediator (W01, W02)

One module, main process, no exceptions. Every corpus write — ingestion, agent output, even
annotation sidecars — resolves its target through it.

Reject: any path that escapes the workspace root after `realpath`; symlinks whose target
escapes; absolute paths; paths containing `..` before resolution. Resolve *then* compare, and
compare against a resolved root — string prefix matching on unresolved paths is the classic
hole. The sanctioned exceptions (`bulletin/board.json`) are an explicit allowlist, not a
pattern.

Test it adversarially: a symlink in the workspace pointing at a ground-truth file is the case
naive implementations miss.

### Snapshot resources through `rrfile://` (W32, W33)

The protocol currently resolves one internal file ID to one file. A faithful snapshot is a
directory — entry document plus images, stylesheets, fonts — so it must resolve relative
references *within that snapshot's directory*, and nowhere else.

Resolve the reference against the snapshot root, `realpath` it, then confirm containment
against the resolved root. Refuse anything that escapes, and refuse remote origins outright
rather than fetching them: a snapshot that reaches the live web is neither local-first nor a
faithful record of what was saved. The renderer still never sees or constructs a path.

### Anchors across representations (W09)

Both the PDF text layer and the extracted markdown derive from the same normalized text, so
a text-quote anchor created on one should resolve in the other. This is the payoff for the
existing `T05`/`T06` work — reuse the normalizer, do not write a second one.

Where it genuinely cannot resolve, that is an orphan (W22), not a failure.

### Derived-link re-indexing (W13)

The sweep must delete only rows with `origin: "derived"` for the document being re-indexed,
then insert the new set. A sweep that deletes by `source_id` alone destroys manual links and
will pass a naive test that only checks wikilinks still work. Assert on a manual link's
survival explicitly.

### Testing agents without a live model (W24–W28)

The suite must never require an API key. Record model interactions as fixtures the way
`packages/zotero-adapter/test/fixtures/` records the real Zotero wire shape — recorded from a
real exchange, never invented.

W24 is the important one and needs no model at all: with agents disabled, assert that no code
path opens a socket. A test that stubs the provider proves nothing; intercept at the network
layer.

### Field Station import (W23)

`~/Desktop/fieldstation/wiki/annotations/annotations.json`:
`{version, updated, layout:{direction, ratio, collapsed:{a,b}, paneA, paneB}, highlights, links}`.
Colours are `default | tan | spruce | ochre | clay | signal`. Bulletin board:
card `{id, author, kind:"note"|"media", text?, x, y, w?, h?}`, edge `{id, from, to, label, author}`.

Import is one-way and read-only with respect to Field Station. Never write into that repo.

---

## What not to do

- Do not weaken `scripts/verify_completion.py`. Strengthening is allowed.
- Do not mark a criterion verified without a passing test whose title carries its tag.
- Do not stub agent behaviour and call it done. If a phase cannot be finished, leave it
  `not_started` and say so in `state/NEXT_ACTION.md`.
- Do not let the renderer touch the filesystem, the corpus, or a model provider. Everything
  goes through the typed IPC surface.
- Do not import `@wr/corpus` or `@wr/agents` from a renderer package.
- Do not make the wiki hostage to the database. If uninstalling this application leaves the
  corpus unreadable, the design is wrong regardless of performance.
- Do not add a network dependency to any non-agent feature.

---

## Activating these criteria in the verifier

The tags above are inert. `scripts/verify_completion.py` hardcodes its enforced set in
`UNIT_TAGS` and `E2E_TAGS` (it does not parse this file), so milestone-1 completion is
unaffected by anything written here.

To enforce milestone 2, add the unit/integration tags to `UNIT_TAGS` and `W10`/`W16` to
`E2E_TAGS`. `TAG_RE` already matches `[A-Z]\d{2}`, so `W..` needs no parser change.

**Do this as a deliberate act when milestone 1 is complete and pushed**, not incrementally as
individual criteria pass — a half-activated set makes the verifier's output ambiguous about
which milestone it is reporting on.
