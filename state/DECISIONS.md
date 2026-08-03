# Decisions

Format: date — decision — evidence — alternatives — reason — frozen?

---

## 2026-07-25 — Add a `shared-types` package not listed in the spec

**Decision.** Introduce `packages/shared-types` holding domain types, `DocumentLocation`,
`AnnotationAnchor`, and the IPC request/response zod schemas.

**Evidence.** IPC schemas must be imported by both the main process and the renderer. Placing
them in `document-model`, `database`, or `zotero-adapter` would let renderer bundles
transitively reach `better-sqlite3` and `electron`.

**Alternatives.** Duplicate the schemas on both sides (drifts); put them in `document-model`
(pulls adapter code into main); generate them at build time (extra machinery).

**Reason.** The spec permits structural changes with a concrete technical reason and requires
that renderer packages not import Electron or database code. A zero-runtime-dependency types
package is the cheapest way to enforce that boundary.

**Frozen.** Yes.

---

## 2026-07-25 — File bytes travel over a custom `rrfile://` protocol, not IPC

**Decision.** Register `rrfile://` in the main process as a standard, secure, stream-capable
scheme. `rrfile://<documentFileId>` resolves through the database to an on-disk path, which is
checked against allowed roots before streaming with HTTP range support.

**Evidence.** PDF.js needs range requests over multi-hundred-megabyte files; marshalling whole
PDFs through `ipcRenderer.invoke` copies the buffer and blocks.

**Alternatives.** `document:readFileBytes` returning an ArrayBuffer (memory blowup, no range
requests); exposing a `file://` path to the renderer (violates the security boundary).

**Reason.** Keeps filesystem paths entirely out of the renderer while giving PDF.js the
streaming access it expects. Also gives one chokepoint for path validation.

**Frozen.** Yes.

---

## 2026-07-25 — Criterion tags in test titles are the unit of completion evidence

**Decision.** Every milestone criterion is satisfied only by a passing test whose title
contains its tag, e.g. `[M03]`. `scripts/verify_completion.py` re-runs the suite and parses
the reporter output; `state/MILESTONE_STATUS.json` is a planning cache with no evidential
weight.

**Evidence.** Ralph loops reliably drift toward marking work done in a status file.

**Alternatives.** Trust a status file (gameable); require manual review (not autonomous).

**Reason.** Makes "done" mean "demonstrated", and makes the verifier's judgement independent
of the agent's own bookkeeping.

**Frozen.** Yes.

---

## 2026-07-25 — Zotero integration tests run against recorded fixtures plus a live smoke test

**Decision.** Mapping and duplicate-prevention tests (`T02`, `T03`) run against fixtures
recorded from the real local API response shape. `M04` additionally requires a live import
when the local API is reachable.

**Evidence.** The local API returned HTTP 403 at bootstrap because the Zotero preference
"Allow other applications on this computer to communicate with Zotero" is disabled.

**Alternatives.** Block all Zotero work until the user flips the setting (stalls the loop);
invent fixture shapes (violates "no fake data paths").

**Reason.** Keeps the loop productive while ensuring the mapping is validated against the real
wire format rather than an imagined one.

**Frozen.** No — revisit once the local API is enabled.

---

## 2026-07-25 — SPEC.md unfrozen to merge Field Station's wiki-reader brief

**Decision.** `docs/SPEC.md` is amended, on explicit user authorization, to make wiki-reader
the standalone desktop successor to Field Station's in-browser wiki annotator rather than a
general-purpose Zotero reader. Added: a wiki corpus model with an enforced ground-truth /
agent-workspace boundary; markdown as a first-class annotatable document type; ingestion from
a named Zotero collection, a URL list, and hand-dropped files; six preset highlight colors
with a comment/color/delete popover; `[[wikilinks]]` and `#tags` as derived typed links; the
librarian and reviewer agents; the bulletin board; and the graph view promoted from a deferred
stub to a required feature.

**Evidence.** `~/Desktop/fieldstation/docs/wiki-reader-repo-research-brief.md` is the brief
this project originated from. The shipped in-browser implementation is
`assets/js/annotate.js` (1,204 lines) over vendored Hypothesis anchor libraries, persisting to
`wiki/annotations/annotations.json`; the librarian contract is `wiki/INSTRUCTIONS.md`. None of
markdown, wikilinks, the librarian, the bulletin board, or the graph appeared anywhere in
`docs/SPEC.md`, and no reference to Field Station existed in this repository. Meanwhile ~180
of SPEC.md's 400 lines specified VS Code navigation machinery the brief never asked for.

**Alternatives.** Leave SPEC.md frozen and treat Field Station interop as a later milestone
(defers the divergence and grows the amount built against the wrong target); rewrite SPEC.md
from the brief alone (discards the navigation, anchoring, and security work already verified).

**Reason.** The specification had drifted from the brief that motivated it, and every
iteration executed faithfully against the drifted version widened the gap. Merging additively
preserves the ~16k lines of sound work while re-pointing the product at its actual purpose.

**Consequences.** The milestone-1 criteria in `docs/MILESTONE.md` no longer cover the
specification. New criteria are needed for markdown reading, wikilink resolution, the agent
tool boundary, ingestion scoping, and the graph view. The over-built navigation surface is
retained as-is — it is tested and working, and removing it was not authorized.

**Open conflict.** `README.md` claims "Nothing leaves your machine." The librarian and
reviewer require a language model. SPEC.md now makes this the single, opt-in, off-by-default
exception with a local-endpoint option, and requires the README to say so plainly. The README
has not yet been updated.

**Frozen.** Yes, as amended.

---

## 2026-07-25 — Presentation fidelity: originals are the default, derived views never substitute

**Decision.** The reader shows each document in its original form: a PDF as the PDF, a saved
web page as the saved page with its own images and stylesheets. Derived representations —
extracted text, markdown conversions, Readability's cleaned article — exist for search,
anchoring, and agent reading, and are never the primary presentation. Readability is demoted
from default to an opt-in, labelled, reversible alternate view. Added as architectural
priority 2, behind only ground-truth integrity.

**Evidence.** SPEC.md said "Default archived webpage view uses Mozilla Readability", with the
original snapshot as a secondary mode. That contradicts the originating brief, which asks for
the "native saved copy ... rendered to look like the real page", and contradicts the reason
Zotero snapshots are worth taking: they are faithful. The merge of 2026-07-25 carried the
error forward and compounded it by listing "extracted text" as a markdown-type document,
conflating markdown that *is* the original with markdown derived from a PDF.

**Alternatives.** Keep Readability as default for readability (privileges convenience over
what the source actually said); offer no cleaned view at all (discards a genuinely useful
option for pages whose saved layout obstructs reading).

**Reason.** A user who cannot tell which representation they are reading is being misled about
what a source says. In a research wiki whose whole value is that claims are checkable against
the record, that is the most expensive possible defect.

**Consequences.** `rrfile://` must resolve a snapshot's relative resources confined to that
snapshot's directory, and must refuse remote origins. Web snapshot reading — deferred out of
milestone 1 and, until now, covered by no milestone at all — becomes milestone-2 phase 2b
(`W31`-`W36`) in `docs/MILESTONE2.md`.

**Frozen.** Yes.

---

## 2026-07-25 — Cytoscape.js for the graph; Foam's semantics for wikilinks

**Decision.** The graph view is rendered with **Cytoscape.js** (`cytoscape` 3.34.0, MIT, zero
runtime dependencies). `[[wikilink]]` syntax and resolution follow **Foam**
(`foambubble/foam`, MIT) — aliases `[[slug|alias]]`, section refs `[[slug#Section]]`, ambiguity
reported rather than guessed, rename rewriting inbound links — parsed with the unified/remark
stack and `github-slugger`, as Foam does.

**Evidence.** Foam's graph view (`packages/foam-graph`, `@foam/graph-view`) uses `force-graph`
with `d3-force`/`d3-scale`/`d3-color`, rendered through `lit`. Field Station vendors the same
`force-graph`. Cytoscape ships CJS/ESM/UMD builds and runs headless in Node; `force-graph` is
a renderer and does not.

**Alternatives.** `force-graph`, which both prior implementations use and which would be the
path of least resistance; d3-force directly, which means building selection, styling, and
traversal by hand.

**Reason.** SPEC.md requires neighbourhood queries to run in the main process without shipping
the full graph to the renderer. Cytoscape's model/renderer split lets one traversal
implementation serve headless queries in main *and* visualization in the renderer;
`force-graph` would force a second, divergent implementation for the main-process side.
Cytoscape also offers hierarchical layouts (dagre/elk), which citation chains read far better
in than a force cloud, and which `force-graph` does not provide.

Foam's wikilink semantics are adopted rather than invented so the corpus stays readable in
Foam, Obsidian, and a plain text editor. Its graph *architecture* is deliberately not adopted.

**Consequences.** Parsing must go through the markdown AST, never a regex — `[[…]]` in a code
fence is code, and `#` in a URL is not a tag; both would otherwise become invented edges. New
criteria `W37`-`W39` cover aliases and section refs, rename-through-the-mediator, and the
whole-corpus node cap. `elkjs` is EPL-2.0 rather than MIT, so `cytoscape-dagre` is preferred
for hierarchical layout; noted in `THIRD_PARTY_NOTICES.md`.

**Frozen.** Yes, for Cytoscape and for wikilink syntax. The specific layout extension is open.

## 2026-07-25 — Highlight colours are stored by name; an unrecognised stored value reads as `default`

**Decision.** `annotations.color` holds one of six palette *names* (`default`, `tan`,
`spruce`, `ochre`, `clay`, `signal`). Writes are strict: `HighlightColorSchema` guards
`annotation:create` and `annotation:update`, so nothing off-palette can enter the database.
Reads are total: `resolveHighlightColor` maps anything unrecognised — a milestone-1 hex, a
name retired in a future version — to `default`, in the one mapper that turns a row into an
`Annotation`. Editing a highlight rewrites the column, so rows converge on names as they are
touched; there is no migration pass.

**Evidence.** A previous attempt narrowed the type without deciding this and broke 17
repository tests at HEAD (commit `b464c89` reverted it). Every existing row carries a hex.

**Alternatives.** A migration rewriting known hex values to names — still needs a rule for the
unknown ones, so it adds a step without removing the decision. Throwing on an unrecognised
value — loses a real highlight over a presentational detail.

**Consequences.** The reader never sees a hex from the database: it resolves a name to
`var(--wr-highlight-<name>)`, so retheming repaints existing highlights. A colour removed from
the palette later silently becomes `default` for rows that used it; that is the intended
trade, and `[W11] reads a colour stored before the presets existed as the default` is the test
that pins it.

**Frozen.** The six names and the read-time fallback, yes. Their hex values in the theme are
presentation and may change freely — that is the point of storing names.

---

## 2026-07-25 — A reading surface takes its ink from a separate scale to the chrome

**Decision.** `--wr-surface` / `--wr-surface-sunken` / `--wr-ink*` are a second colour scale,
used by anything that renders a document. The chrome's `--wr-bg` / `--wr-text` are never used
on a reading surface, and vice versa.

**Evidence.** The markdown reader asked for `var(--wr-surface, #fbfaf7)` — a token nothing
defined — so its background fell back to a paper literal, while `var(--wr-text, #1b1a17)`
found the *dark chrome's* #d7dae0 and did not fall back with it. The result was 1.34:1 body
text, effectively invisible, and all 92 checks were green: every assertion in the suite is
about text being present, not about whether a reader can see it.

**Alternatives.** One scale with a `.reading-surface` inversion (the same tokens then mean
two things depending on ancestry — worse); hard-coded literals in each reader (drifts, and
retheming breaks highlights); a light chrome throughout (the reader should recede, not match).

**Reason.** A PDF page is white because the page is white, and a saved web page brings its own
background. The markdown body is paper for the same reason. Two scales make "which colours may
I use here" answerable from the token name alone, and `[UX02]` fails on any `--wr-*` a
stylesheet uses that nothing defines, which is the silent half of the bug.

**Frozen.** No — a light theme would add a second set of chrome values; the paper/ink split
stays either way.

---

## 2026-07-25 — Annotating never changes the reader's layout

**Decision.** Creating a highlight does not open the annotations sidebar, and the selection
toolbar is positioned rather than laid out.

**Evidence.** Measured on a real 10-page paper: the toolbar took 39px of the scroller as a
flex row, and committing force-opened the sidebar, narrowing the reader 1112px → 832px and
re-centring the page mid-sentence. Two reflows per highlight, which reads as the document
reloading.

**Alternatives.** Overlay the sidebar over the reader (hides the text being annotated);
reserve its width permanently (wastes it for readers who never annotate); animate the
transition (still moves the words).

**Reason.** The highlight is confirmed where it was made — painted on the page, named in the
status line. `[M11]` covers "a selection can be highlighted"; the sidebar opening was
incidental to it, so that test now opens the sidebar the way a reader does and keeps every
assertion about what it lists.

**Frozen.** No.

---

## 2026-07-25 — The library sidebar is the Zotero library; the corpus lists separately

**Decision.** `library:listDocuments` takes a `source` filter. The sidebar issues two queries
— `'zotero'` under LIBRARY, `'corpus'` under NOTES — rather than one flat list.

**Evidence.** Ingested markdown appeared as peers of imported papers, so a wiki page and a
paper were the same kind of row with no ordering that made them comparable.

**Alternatives.** Partition one query in the component (puts the meaning of `source` in the
renderer); stop ingesting markdown (retires W01/W02/W06/W08); hide the corpus entirely (it is
openable and searchable, so hiding it from the one list that enumerates documents is worse).

**Reason.** `source` already existed on `Document`; this is a filter, not a new concept.
Wikilink targets are still built from both lists — splitting what the sidebar shows must not
narrow what a `[[slug]]` can reach.

**Frozen.** No.

---

## 2026-07-28 — A hypothesis is an entity; evidence is an ordinary link

**Decision.** Migration 007 gives `questions` a markdown `body`, `description` and
`cover_file_id`, adds `question_tags`, and makes `hypotheses` its own table. Evidence is a
typed edge in `links` — `<document|annotation>-<supports|opposes>-hypothesis` — and there is
no evidence table.

**Evidence.** `A08` could already surface evidence for and against a *question*, which is a
page-sized target: the librarian can cite a paper for "do induction heads appear in VLAs?"
but not for the specific claim that attention-only layers carry the copying. A claim that is
prose inside a body has no id to attach anything to.

**Alternatives.** Keep hypotheses as a `## Hypotheses` section and parse them out (an id that
changes when the sentence is edited); a dedicated `evidence` table with a stance column (a
second relationship mechanism to keep in step with the graph, the reference query and the
broken-link check); store the section template into every new row (the app writing prose on
the researcher's page).

**Reason.** `links` already resolves both endpoints, marks broken ones and feeds the graph, so
a hypothesis being a `LinkableEntityType` buys all of that for the cost of one enum member.
The body defaults to empty and `question:notebook` *reads* the template — a blank page looks
like the template without the app having written one, and emptying a page leaves it empty.

**Frozen.** No.

---

## 2026-07-28 — A removal is a tombstone in `external_references`, not a deleted row

**Decision.** Migration 009 adds `removed_at` to `external_references`. `library:removeDocument`
soft-deletes the document, tombstones every provider key it carries, and drops its search
entries — in one transaction. `ZoteroImporter.writeDocument` reads the tombstone *before* the
version check and before `force`, and skips the item whole: no document row, no tags, no
collection membership, no attachment rows, no extraction job.

**Evidence.** `DELETE FROM documents` survives exactly until the next import, which finds a
Zotero key it has no record of and creates the document again. The obvious implementation is
undone by the feature that makes the library useful.

**Alternatives.** A `removed_documents` table (a second place the importer would have to
remember to consult, and the first to drift); tombstoning by leaving the document row with
`deleted_at` and having the importer check *that* (works only for documents that still exist —
a purge, or a corpus re-scan, and the key is unknown again); refusing to re-import anything
already seen (turns every genuine Zotero edit into a manual re-add).

**Reason.** `external_references` is already the table the import consults to answer "have I
seen this key?", so the tombstone extends an answer it was already reading rather than adding a
question it has to remember to ask. The removal is a *soft* delete because the annotations and
links on the document are the researcher's work, not Zotero's to take away (`B03`).

**Frozen.** No — the *skip* half was replaced on 2026-07-29; the tombstone stands.

---

## 2026-07-28 — The library is a drop target, and the dialog is the other way in

**Decision.** `wr:drop` takes `questionId: null` for a drop on the library rather than on a
question's board, marked in the DOM by `data-wr-drop-library`. `library:addFiles` opens a native
file dialog in the main process, refused in background mode as the directory dialog is.

**Evidence.** `B02` is an E2E criterion and the E2E suite runs with `WR_BACKGROUND=1`, where a
modal nobody can answer would wedge the process on someone else's desktop. A dialog stubbed
from the test would assert the stub.

**Alternatives.** Stub `dialog.showOpenDialog` over CDP (tests the stub, and the background
refusal would have to be weakened to reach it); a channel that accepts a path (an
arbitrary-file-read: name it, add it, read it back over `rrfile://`).

**Reason.** Both are real ways in that a researcher uses, and the drop is the one an unattended
run can drive end to end with a `File` the operating system actually produced. The sequence
behind the dialog — admit the one path, mint the document, queue extraction — is the same code
either way, and `tests/integration/library-curation.test.ts` drives it with the chooser injected.

**Frozen.** No.

---

## 2026-07-28 — The graph's settings are one view; its viewport is one per seed

**Decision.** Spacing, labels and depth live in `settings` under `graph.view.settings`,
application-wide. Pan and zoom live under `graph.view.viewports`, keyed by `seedType seedId`
and capped at the 64 most recently moved. `depth` was **removed** from
`LinkGraphPanelSchema` and from `openLinkGraph`'s arguments.

**Evidence.** `G01` says the view survives *reopening the panel*. A panel id dies with its tab,
so `workspace_layouts.panel_state_json` cannot answer it — the thing that comes back has to be
keyed by something that outlives the panel, and the seed is the only such thing the panel has.

**Alternatives.** Keep `depth` on the descriptor as well (two authorities: changing one leaves
the other stale, and which wins depends on whether the panel was restored or opened fresh);
one settings row per seed (unbounded growth, and `settings.keys()` becomes a library census).

**Reason.** Spacing and labels are a preference about reading graphs in general — someone who
wants two hops wants them of the next graph too — while where you dragged *this* paper's
neighbourhood is a fact about that paper. They persist differently because they are different
kinds of thing.

**Frozen.** No — the 64-viewport bound is a guess, not a measurement.

---

## 2026-07-28 — A node's picture is a file id in a table of its own

**Decision.** `graph_node_icons` (migration 011) keys a `document_files` id by
`(entity_type, entity_id)`, beside `graph_node_names` rather than inside it.
`graph:setNodeIcon` takes that file id and refuses one whose row is not an image;
`graph:iconChoices` lists the library's images so the picker has something to offer.

**Evidence.** `display_name` is `NOT NULL` in migration 010, so a node with a picture and no
name needs that constraint dropped — and SQLite drops a constraint only by rebuilding the
table, copying every row of something the researcher's installed library already carries.

**Alternatives.** A column on `graph_node_names` (the rebuild above, to save one indexed
lookup); a path column with the bytes served from it (a hole in the rule that the renderer
never receives or names a path); its own id family in the `rrfile://` handler (a second
resolution path through the most security-sensitive code in the tree).

**Reason.** The image is an ordinary local file the library was given — adding it is what
admitted its one path — so it already has a `document_files` row, and that id is the only kind
of image reference the renderer can be handed. It is exactly what a notebook's `cover_file_id`
is, for the same reason. Names and pictures are also given up separately: clearing one is a
`DELETE` rather than a column nulled beside a value somebody still wants.

**Frozen.** No — `G05`'s fetched card art will need a cache keyed by URL, and where a cached
file's row lives is not decided here.

---

## 2026-07-28 — Fetched card art hangs off one document, and the channel takes a name

**Decision.** Cached art is written to a `card-art` directory beside the database, admitted as
a fixed allowed root, and given a `document_files` row on **one** document with
`source = 'card-art'` — not one document per picture. `documents.list`, `count`,
`countCreatedSince` and `listImages` exclude that source unless it is asked for by name.
`cardArt:fetch` takes `{ entityType, entityId, name }`; the URL is built in the main process
from `CARD_ART_HOST`, one constant.

**Evidence.** `rrfile://<file id>` is the only way bytes reach the renderer, and every file id
belongs to a document, so a fetched picture needs one. Forty illustrated nodes would otherwise
be forty rows in a library whose whole point (`B01`–`B03`) is that it holds what the researcher
is working on. The librarian's disclosure counts `db.documents.count()`, so an unexcluded
holder would also have made that sentence say one document more than it sends.

**Alternatives.** A document per picture (the noise above); a path column on
`graph_node_icons` with the bytes served from it (a hole in the rule that the renderer never
receives or names a path); a second id family in the `rrfile://` handler (a second resolution
path through the most security-sensitive code in the tree); a `{ url }` channel (a
request-forgery hole aimed out of the main process — the renderer would choose the host).

**Reason.** One row is the smallest thing that satisfies "bytes need a document" without
turning the library into a picture folder, and excluding it by source is one clause in the four
queries that answer "what is in my library". Taking a *name* rather than a URL is what makes
"one allow-listed host" a property of the code instead of a promise about the caller.

**Frozen.** The name-not-URL rule and the single holder are frozen. The host itself is not: it
is one constant, disclosed before the switch, and changing it changes one line and one sentence
of `README.md`.

## 2026-07-29 — Containment is a fact the query answers, not one the view infers

**Decision.** `GraphNode` carries `parent: { entityType, entityId } | null`, set by
`GraphRepository.neighbourhood` from the description a node already resolves to — an entity
whose `documentId` names another node **in the same bounded answer**. `@wr/graph` turns that
into Cytoscape's own parentage, places a contained node in orbit of its container rather than
on its hop-count ring, and derives each container's box from the final positions
(`groupBoxes`). Edges carry which group each end sits in.

**Evidence.** `G06` asks for a highlight to be drawn *with* the paper it came from. Placed by
hop count, a highlight of the paper next door lands a whole ring away from it, and the reader
is left to infer belonging from edge lengths — the inference the criterion exists to remove.

**Alternatives.** Rectangles drawn by the panel around whatever it decided was related (a
second, disagreeing model of containment in the renderer); a `parentId` string keyed the same
way the traversal keys nodes (`type id`), which would put a key format into the IPC contract
that only two call sites know how to read; making containment an edge type (it is not a link
anyone made, and it would then be traversable, pulling documents in as neighbours).

**Reason.** The traversal already knows an annotation's document, so the answer says so.
A parent the node cap dropped is reported as no parent at all: the view cannot box something
it was not sent, and Cytoscape throws on a container that is not in the elements.

**Frozen.** That a parent is only ever named when it is in the same answer. Not frozen: what
may contain what — today it is a document holding what lives inside it.

## 2026-07-29 — The journal is a page, and a day's entry is a view over one markdown document

**Decision.** Three things, one surface. The journal left the left sidebar and became a
workspace panel kind (`journal`, singleton, descriptor carries nothing — a page opens on
today). The calendar starts at `JournalRepository.projectStart()`: this database's own
creation day (`MIN(schema_migrations.applied_at)`, as a *local* day), or an older entry if
the journal carries one. The day's entry is a block notebook — `parseBlocks`/`serializeBlocks`
in `renderer/journal-blocks.ts` — and the commands margin is the day's **code blocks**, listed
rather than stored.

**Evidence.** `N09`–`N11`. A 260px sidebar sizes a day's thinking like a filter. A calendar
that starts at the first *entry* cannot show the fortnight before anyone wrote anything, which
is the thing an empty bubble is for. And a day's writing is a sequence of notes, commands and
figures, not one textarea.

**Alternatives.** Keeping the day on the panel descriptor (a workspace restored on Tuesday
opens on Monday and quietly writes there); a `blocks` table (a second store to keep in step
with the markdown, and the loser drifts silently); a stored `{cmd, desc}` list for the margin,
as the reference notebook has (a second copy of the same fact — the one that got edited wins
by accident); a `+ image` button (nothing in the page can put bytes on the machine, so it
would be an affordance pretending to).

**Reason.** The markdown is the authority: every commit serializes the whole day and re-parses
what came back, so a block edited into a fence *becomes* a code block and a day emptied
becomes no entry at all. Everything that reads markdown — search, the librarian, a text
editor — keeps working.

**Frozen.** One markdown document per day, blocks as a view, no execution. Not frozen: how
blocks are inserted or reordered, and whether an image block ever gets a drop path.

---

## 2026-07-29 — A removal is undone by importing the collection, not by a Put back button

**Decision.** The tombstone stays; what lifts it changed. `ZoteroImporter` skips a tombstoned
item on a **whole-library** run (`force` included) and *restores* it on a run **scoped to a
collection** — every item that survives the scope filter was asked for by name, so
`library.restore()` runs, the write proceeds as `restored`, and `index-fts` is queued because
the search entries were dropped on removal. `ImportSummary.documentsRestored` counts them.
`library:listRemoved` and `library:restoreDocument` are gone, with the sidebar's `Removed`
section; each row of `ZoteroScopePicker` imports its own collection instead (`B05`), which is
the door `B01` points at.

**Evidence.** `docs/MILESTONE4.md` re-specified `B01` after it was built: "a removal is not a
blacklist… the way back is the importer — find the collection, import it, it returns. Nothing
to maintain: no list of removed things for the researcher to curate." The implementation held
the tombstone against every import, and the four `[B01]` tests asserted exactly that, which the
verifier could not see because it matches the tag and not the sentence.

**Alternatives.** *Any* import clears the tombstone — no blacklist at all, but the nightly
whole-library sync then resurrects everything removed that morning, so curating the library
lasts until the next sync. A visible `Removed` list with an undo button — the blacklist the
criterion names, one more list to keep tidy. A per-document "bring back" that runs a scoped
import under the covers — the same code with a second name for it.

**Reason.** Scope is already the unit the importer works in and the unit the picker shows, so
"which import brings it back" needed no new concept: a scoped import *is* the researcher
naming what they want. It makes `B05` the door rather than a second feature, and leaves the
routine sync — the one nobody aimed at any particular paper — unable to undo a decision.

**Frozen.** Not frozen: whether a per-collection import should also offer `force`.

---

## 2026-07-29 — `WR_ZOTERO_ENDPOINT`, loopback only

**Decision.** The main process reads `WR_ZOTERO_ENDPOINT` beside `WR_ZOTERO_DATA_DIR`.
`resolveZoteroEndpoint` admits it only when it parses as an http(s) URL whose **hostname** is
loopback and which carries no credentials; anything else is logged and the built-in
`127.0.0.1:23119` stands. The E2E suite points it at a fixture Zotero API on an ephemeral
loopback port (`tests/e2e/support/zotero-api.ts`).

**Evidence.** `B05` is an end-to-end criterion about an import started from the interface, and
once Electron is running there is no injection point left — the seeding in `workspace.ts`
drives the importer in the Playwright process, over an injected fetch, before launch.

**Alternatives.** A test-only branch in the app (a code path the researcher never runs, exactly
what the rules forbid); binding the fixture server to 23119 (a Zotero someone starts collides
with it, and the test reads their real library); asserting `B05` against a stub in the renderer
(asserts the stub).

**Reason.** Zotero's local API port is a preference, so naming another one is honest production
configuration rather than a test hook — but it names where the library is *sent*, so the
loopback check is at the boundary that reads it and not in a comment. Checked on the parsed
hostname: `http://127.0.0.1@evil.invalid/` contains a loopback name and is not one.

**Frozen.** Loopback-only. The variable must never admit a remote host.

---

## 2026-07-29 — The registry is the shortcuts list; the relationship is chosen, never defaulted

**Decision.** Three surfaces, all thin over mechanisms that already existed.

*The command list* (`K03`) renders `CommandRegistry.search('')` and
`KeybindingRegistry.chordsForCommand`, live. It is not a table anyone maintains. Every row
carries the canonical chord in `data-chord` and a printed form beside the command's label, and
disabled commands are greyed rather than hidden. Its way in is a **status-bar button**, not a
chord: a list of every keyboard shortcut that can only be opened with a keyboard shortcut is
not discoverable, which is the whole of the criterion. The button prints its own chord, so
finding it once is how the key is learned.

*The link picker* (`K01`) offers the three document→document relationships as three visible
buttons with **none preselected**, and "Create link" stays disabled until both the other end
and the relationship are chosen.

*A note from here* (`K02`) is one command, `wr.newNoteFromHere`, resolving its subject through
`getActiveEntity` — the selected highlight if there is one, else the open document — and
handing it to `host.createNoteFrom`, which writes the note and its edge in a single
`note:create`.

**Evidence.** `[K03]` in `tests/e2e/shell.spec.ts` imports `DEFAULT_KEYBINDINGS` from
`@wr/workbench` and asserts, per rule, that a row exists with that command's label and that
platform's chord — so a binding that moved cannot be shown at its old key. `[K01]` asserts the
Create button is still disabled with a target chosen and no relationship, and that nothing was
written at that point. `[K02]` asserts the edge is `note-references-annotation` to the
highlight, not to the paper.

**Alternatives.** A hand-written shortcuts sheet (a second source of truth, wrong the first
time a binding moves); a `<select>` for the relationship (a closed dropdown shows one value,
which reads as the answer); defaulting to `related-to` (afterwards indistinguishable from a
relationship the researcher meant).

**Reason.** All three mechanisms — the registries, `link:create`, `note:create` — shipped in
milestone 1 and nothing in the app pointed at any of them. A feature nothing points at is a
feature nobody has.

**Frozen.** The shortcuts list is a rendering of the registry, never a copy. A document link
type is never defaulted.

---

## 2026-07-31 — A day belongs to a notebook; the word "question" retires from the interface

**Decision.** Three parts, all `P01`–`P05`.

*The journal is one notebook's log.* Migration 012 rekeys `journal_entries` from `date` to
`(notebook_id, date)`, and a journal endpoint in `links` becomes `<notebook id>:<date>`
(`journalEntityId` / `parseJournalEntityId`). Still a natural key, for migration 005's reason:
blanking a day deletes its row, and an edge pointing at that day must mean the same day when it
is written again. Existing days are adopted by the first notebook — by one the migration
creates, if the library has none — and the edges pointing at them are rewritten in the same
transaction. Every journal channel names its notebook; there is no form that omits it.

*Where a calendar begins is the researcher's* (`P03`), stored as `questions.journal_start`.
Null is not missing: it means nobody has said, and the calendar falls back to the notebook's
own beginning — with an older entry still winning, so a backfilled day cannot fall off the
front. The old fallback was the day the *database file* was made, which is a fact about the
installation and put every notebook's calendar in the same place.

*The word retires from the interface, not from the schema.* The `questions` table and the
`question:*` channels keep their names; the activity bar, the directory, the queue, the
notebook page, the journal, the command list and the blank page's first heading stop saying it.

**Evidence.** `[P02]` and `[P03]` in `tests/integration/journal.test.ts` — the same date under
two notebooks is two entries, a bare-date write is refused by the contract itself, a day's
parent is its notebook, and a start survives a restart. `[P01]` in `tests/e2e/notebooks.spec.ts`
reads every surface the researcher passes through, plus the command list, and asserts the word
"question" is on none of them.

**Alternatives.** A minted id for a day (breaks the blank-and-rewrite property migration 005
was built on); keeping a global journal and tagging entries with a notebook (two notebooks
still share one page, which is the defect); renaming the table and the channels (a rewrite of
released history that changes nothing anyone sees, and invalidates every checksum under it).

**Frozen.** No channel reads or writes a day without naming its notebook. No surface a
researcher reads says "question".

---

## 2026-07-31 — A picture is dropped, and the main process writes it into the day

**Decision.** `P04`. A day's blocks carry `data-wr-drop-journal="<notebook>:<date>"`. The
preload — the only world that can turn a dropped `File` into a path — resolves the paths and
sends them with that target on `wr:drop`. The main process adds each picture to the library
*where it lies*, appends `![title](rrfile://<file id>)` to that day's markdown, and publishes
`journal:changed`; the page re-reads the day.

**Evidence.** `[P04]` in `tests/e2e/journal.spec.ts` drops a real PNG from outside every
allowed root, asserts the block renders with a `rrfile://` source that actually loaded
(`naturalWidth > 0`), asserts the page's markup contains no path and no filename, and asserts
after shutdown that the file has the same inode and that no copy of it exists anywhere in the
workspace.

**Alternatives.** A file dialog (background mode has nobody to answer a modal, so the criterion
could not be driven unattended); a picker over images already in the library (two gestures for
one act, and it puts a figure in the library before it is anywhere); the renderer inserting the
block after hearing a file id (workable, but it moves an edit of a document the main process
holds into the world that must never learn where the bytes are).

**Frozen.** No image reference in a notebook is ever a path, a `data:` URI or a remote URL.

---

## 2026-07-31 — A click into a block carries a position

**Decision.** `P05`. Clicking a rendered block resolves the click with
`document.caretRangeFromPoint`, converts the rendered-text offset back into the markdown source
with `sourceOffsetFor`, and the textarea opens focused with the caret there. Focus is set in
the ref rather than by `autoFocus`, which always lands at zero.

**Evidence.** `[P05]` in `apps/desktop/src/renderer/journal-blocks.test.ts` for the mapping —
headings, emphasis, links, a newline rendered as a space, and the bounds — and `[P05]` in
`tests/e2e/journal.spec.ts` for the gesture: a click on a word in a rendered paragraph, then
the caret is inside that word and typing goes in there.

**Alternatives.** A source map out of the markdown parser (exact, and a parser change away from
being wrong in a way nothing would notice); editing the block in place with `contenteditable`
(stores rendered HTML, which is the mistake the notebook body exists to avoid).

**Frozen.** The mapping is a heuristic and is documented as one. Its failure is a few
characters inside the right word; not doing it fails at character zero, every time.

---

## 2026-07-31 — The wiki is a place, and the focused view is one tab that moves

**Decision.** `F01`/`F02`/`F03` are two new panel kinds, `wiki` and `focus`, behind two new
channels. `graph:overview` is the only unseeded graph query: its `nodeLimit` is **required**,
not defaulted, so an empty request still fails and "give me the graph" is unspellable. It ranks
files and notes by degree, draws only the edges that join two nodes on the map, and reports
`totalNodes` beside `elidedNodes`. `graph:focus` carries **two** caps — `annotationLimit` and
`neighbourLimit` — and a connection counts whether it runs between two files or between a
highlight in each (`throughAnnotation` says which). `panelSubjectKey` keys `focus` on its kind,
and `RESEATED_PANEL_KINDS` makes a reveal carry a descriptor, so one tab serves every file.

**Evidence.** `[F01]`/`[F02]`/`[F03]` in `tests/e2e/wiki.spec.ts`, `[F01]`/`[F02]` layout tests
in `packages/graph/test/graph.test.ts`, `[F03]` re-seat tests in
`packages/workbench/test/panel-targets.test.ts`, and the channel-shape tests in
`tests/integration/graph.test.ts` — including `graph:overview` added to the `[W10]` loop that
asserts no channel takes an empty request.

**Alternatives.** One graph panel with a mode switch (`MILESTONE5.md` rules it out, and it would
re-litigate `G01`–`G06` for free); `graph:neighbourhood` at depth 2 for the focused view (one
node cap over both halves, and node ids sort `annotation` before `document`, so a paper with
sixty highlights would elide every file it leads to — the half the criterion is about); the
panel writing its own descriptor on a crawl (works, but then opening the view on a second file
from the reader or the palette silently does nothing, which is how the bug got there).

**Frozen.** The whole-corpus channel names its own ceiling and reports its elision. The focused
view's two budgets are separate. Not frozen: what the wiki page draws — today files and notes,
never annotations and never an edge derived from one.

---

## 2026-07-31 — A saved page's selection comes from the context menu, not from the frame

**Decision.** Highlighting an archived page (`H01`) takes its selection from Chromium's
`context-menu` parameters in the main process, published to the renderer as
`webpage:selection` (a document id and the words). The archive keeps `sandbox=""`, its opaque
origin and the CSP `snapshotSecurityHeaders` serves. Nothing is painted inside the frame; the
highlights are listed beside the page, each saying whether it still resolves.

**Evidence.** The reader frames the snapshot at its own `rrfile://` origin with no sandbox
tokens, so `window.getSelection()` does not cross into it, `contentDocument` is cross-origin,
and the frame has no script with which to postMessage out — three closed doors, each of them
deliberate (`HtmlReaderView`, `protocol.ts:snapshotSecurityHeaders`, `[W03]`). That, not a
missing wire, is why the article panel had no highlight flow. The anchoring itself was already
proven end to end by `[W05]`; only the way in was missing.

**Alternatives.** Grant `allow-scripts` plus a nonce'd injected reporter — the only route that
also gets marks painted *on* the page and `revealLocation` scrolling, at the cost of turning
"script-disabled" into "script-disabled except ours" for the most hostile input the app takes.
Rejected: CLAUDE.md lists script-disabled archived HTML under *never regress*, and a criterion
is not worth spending an invariant on. It stays available as its own deliberate change if a
researcher wants marks on the page.

**Reason.** The chosen route grants the archive nothing at all and needs no change to the
sandbox, the CSP or the request blocking. Its two costs are stated rather than hidden: Chromium
truncates a very long `selectionText`, and the selection carries no offsets — so
`createHtmlAnchor` locates the quote in the snapshot's own text (`locateNearest`), which
degrades to "the first occurrence" for a sentence that repeats rather than lying about which.

**Frozen.** No — the transport is a decision, not an invariant. The invariant is that the
archive gains no capability.

---

## 2026-07-31 — A link's two ends are entity references, and the vocabulary is per pair

**Decision.** `WorkbenchHost.promptEntityLink` / `createEntityLink` take `EntityRef`s on both
ends, `store.linkDraftSource` holds one, and `linkTypesFor(sourceType, targetType)` is the
single list of relationships the picker offers and the command validates. `H02`'s manual
highlight→file edge is a *new* type, `annotation-references-document`.

**Evidence.** `#documentSubject` collapsed a selected highlight to its document and
`createDocumentLink` hardcoded `sourceType`/`targetType: 'document'`, so a highlight could be
linked *to* and never *from*. And `LinksRepository.create` returns the existing row on a
(type, source, target) repeat, while every annotation is born with an
`annotation-belongs-to-document` edge — so reusing that type for the manual assertion would
have reported success for a link it never wrote whenever the target was the highlight's own
paper. `tests/integration/highlight-links.test.ts` asserts that collision is real.

**Alternatives.** Keep the document-shaped request and add optional endpoint types (weaselly:
"document link" that is not one). Reuse `annotation-belongs-to-document` (the silent-collision
bug above). Let any type be asserted between any pair (a picker and a command that disagree).

**Reason.** Every relationship in this app is already a typed directed edge over twelve
linkable entity types; the narrowing was in the gesture, not the model. One vocabulary
function keeps the picker and the command from drifting apart, which is the failure mode a
second list always produces.

**Frozen.** No — the vocabulary grows. The rule that it lives in one place is.

---

## 2026-07-31 — A file's ledger is one bounded query, not a new table

**Decision.** `link:findForDocument` runs `scopeClause`'s "endpoint inside this document" with
no type filter and reports which end is the near one. Derived edges with *both* ends inside
are omitted. The `ledger` panel joins `focus` in `RESEATED_PANEL_KINDS`.

**Evidence.** `LinksRepository.scopeClause` already meant exactly what `H03` asks for, but was
reachable only through `findByType` — one type at a time, which shows only the relationships
whoever wrote the panel remembered, in an app whose type vocabulary is deliberately open-ended
(`LinkTypeSchema` is `z.string()`). A `ResolvedLink` describes the endpoint *away* from the
query, which is ambiguous when the query is a file rather than an entity.

**Alternatives.** A per-file backlink table (the untyped-backlink regression CLAUDE.md
forbids). Several `findByType` calls, one per known type (silently incomplete). Keeping the
containment edges (every ledger opens with one line per highlight saying it is in this file).

**Reason.** The model was right and the query was one clause away. Adding the near endpoint to
the answer is the smallest thing that lets a page say "this is on the paper" and "this is on
the sentence you marked" without inferring it back out of the row.

**Frozen.** Yes for "no second table". The omission rule is a judgement and may be revisited.

---

## 2026-07-31 — The keyboard is a scheme, and each binding says which family it is in

**Decision.** Four families, chosen by the *verb*: `Cmd+Shift+<letter>` goes to a page (the
letter is the first letter of the page's name that is still free, scanning left to right);
`Cmd+P` goes to a file; the function row follows the links on what you are reading;
`Cmd+Alt+<letter>` makes something from here. Panes (`Cmd+W`, `Cmd+B`, `Cmd+Enter`) and
retracing (`goBack`/`goForward`/`goToParent`) keep the conventions every application shares.
Each rule in `DEFAULT_KEYBINDINGS` carries a `family` label; the help page groups by it.

**Evidence.** Eleven bindings existed and no two were related, so every one had to be learned
on its own. Two commands (`openNotebook`, `openJournal`) could not be bound at all, because
they demanded an argument a keystroke cannot carry — `WorkbenchHost.notebookInHand()` is what
answers that now, and the same answer serves the activity bar's Journal button.

**Alternatives.** Inferring the family from the modifiers (free, and wrong: `Cmd+Shift+W`
closes a group and shares its modifiers with every page chord). Numbering the activity bar
(`Cmd+1..9` — learnable, but it names positions rather than places, and re-ordering the bar
would silently re-point every key). Taking `Cmd+Shift+W` for the wiki (a chord every
application already spells one way is not one a scheme gets to take back; `wiKi` took `I`).

**Reason.** A list is learned once per entry; a scheme is learned once. And the family has to
be declared where the scheme is decided, or the help page becomes the second authority the
criteria forbid.

**Frozen.** The families and the "declare, don't infer" rule are. The individual letters are
not — a user keybindings file already overrides them, and `family` is optional there.

---

## 2026-08-01 — What a view may leave out, it counts; what an anchor cannot know, it does not record

**Decision.** Six rules, all from closing the milestone-5 audit, all in the same family — a
surface says what it dropped, and never records evidence it does not have.

- Every cap the wiki page applies is reported: `graph:overview` takes an `edgeLimit` beside its
  `nodeLimit` and answers with `totalEdges`/`elidedEdges`. `truncated` means "of either kind".
- The focused view's neighbour half has no internal ceiling. "Where it leads" is grouped in SQL,
  one row per file, so `elidedNeighbours` is the truth rather than a count of what survived a
  bound nobody was told about. The work is proportional to the file's own degree.
- The wiki's ranking counts only the kinds the page draws (files, notes). A highlight therefore
  cannot change that answer, and the page does not redraw for one — a rule that is true rather
  than an approximation the panel chose.
- Reading order is a column: migration 013 projects each anchor's `position.start` beside
  `page_index`, and the ring is `(page_index, text_start, created_at, id)`.
- A `locateNearest` that cannot find the quote says so. `HtmlAnchor.position` is optional, and a
  saved-page anchor whose words are not in the extracted text records no offsets and no context.
- A pan is held for as long as the scene is *of* the same thing: `useSceneView(subject)`.

**Evidence.** Reproduced before each fix. `FOCUS_EDGE_LIMIT` (2,000) under-reported a
3,000-neighbour file by a thousand; `EDGES_PER_NODE` (400) dropped the link between two drawn
hub files while `truncated` said the map was whole; a dense corpus answered `graph:overview`
with 24,865 uncapped edges and took 1,570 ms of a synchronous main process to do it; the
`[F02]` ring failed one run in three because `page_index` is `NULL` for markdown and saved
pages; a saved-page anchor over a paragraph containing `display:none` markup recorded context
cut from the top of the page and then resolved to `null` 7.8k characters down. Each fix has a
test that fails when it is reverted (see `reports/AUDIT.md`, milestone 5).

**Alternatives.** Raise the ceilings (the same lie further out). Rank by every edge and redraw
for every highlight (correct and slow, on the process that owns the database). Keep the hint
when the quote is not found (what produced confident, wrong context). Reset the viewport from
the panel rather than the hook (every future caller has to remember).

**Reason.** The previous entry froze "the whole-corpus channel names its own ceiling and reports
its elision"; three of these are that promise made true where the code did not keep it. The
anchor rule is `CLAUDE.md`'s: anchors persist *text evidence*, and evidence that is not true of
the marked passage is worse than none, because resolution weighs it.

**Frozen.** The reporting rule: no view drops something silently, and no anchor records an
offset or a context it had to invent. Not frozen: the numbers, the SQL, or `text_start` as the
projection that carries reading order.

---

## 2026-08-01 — A saved page says how to highlight it, out loud

**Decision.** The article panel carries one line above the page — "Select text in the page, then
right-click it to highlight." — where the selection bar appears once there is a selection.

**Evidence.** The context menu is the only route by which a selection leaves the archive
(2026-07-31, above). Every other reader raises its bar on `mouseup`, so on a saved page the
gesture a researcher has learned everywhere else does nothing at all — which from the outside
is indistinguishable from the bug `H01` was written to fix. `[H01]` passed because the harness
knows to right-click.

**Alternatives.** Grant the frame a script so `mouseup` can be heard (rejected 2026-07-31, and
for the same reason). Leave it undiscovered and record it as a design gap (a criterion whose
feature nobody can find is not delivered).

**Reason.** The transport's costs were stated — truncation, no offsets — and this third one was
not. A reader is owed the gesture in words when the app cannot offer it in the usual place.

**Frozen.** No. If marks are ever painted on the page, the hint goes with the change.

---

## 2026-08-01 — The notebook page is the journal's block editor, promoted (S01)

**Decision.** One block editor, `apps/desktop/src/renderer/blocks.tsx`, over one pure module,
`block-source.ts`. The journal's day and the notebook's page are both thin owners of a markdown
document: `value` in, `onCommit(markdown)` out, and the owner answers with what was stored. The
page's layout copies the journal's — writing column `1fr`, front matter / sections / claims in a
fixed margin, desk along the bottom.

**Evidence.** The block UI was ~140 lines inside `JournalView` and could not be reached from
anywhere else. `state/NEXT_ACTION.md`'s "Where things live" exists because `makeHighlight`,
`Overlay` and `defaultSidebars()` were each written twice before being folded back.

**Alternatives.** Make the notebook's outline real navigation over a textarea (leaves two ways
of writing, which is gap 3's actual complaint). Copy the block JSX onto the page (the duplicate
this tree keeps paying to undo).

**Reason.** The researcher's decision names markdown, LaTeX, code blocks, images and links as
one surface. Two surfaces means the next feature lands on one of them.

**Frozen.** Both surfaces store **markdown source**, and blocks are a view over it — no block
table, nothing that can drift from the document. Not frozen: the testid prefixes, the margin's
width, where the desk sits.

**Consequence.** The desk board is along the bottom rather than in the margin because it is a
pointer-dragged surface and 240px is not one. A picture dropped on the page needed a preload
attribute that is a *sibling* of the board's, never an ancestor: `closest` picks the innermost,
so nesting would have taken the board's drops.

---

## 2026-08-01 — LaTeX is a vendored KaTeX in MathML, parsed back into elements (S02)

**Decision.** `katex` as an ordinary dependency, `output: 'mathml'`, `trust: false`,
`throwOnError: false`. The HTML string it returns is parsed with `DOMParser` and rebuilt as
React elements against an allowlist of MathML tags and attributes (`packages/markdown-reader/src/math.tsx`).
`$…$` and `$$…$$` are tokenised in `render.tsx`'s existing atom pass, beside `[[wikilinks]]`.

**Evidence.** MathML mode ships no CSS and no woff2, so nothing has to be copied into the bundle
the way `pdfjsAssets()` copies PDF.js's fonts, `font-src` is untouched, and the licence surface
stays KaTeX's own MIT. `remark-math` would have pulled a second KaTeX through
`micromark-extension-math`, and a plugin cannot make a formula an `Atom` — which it has to be, or
`paintRanges` cuts a `<mark>` through the middle of one.

**Alternatives.** `dangerouslySetInnerHTML` with a comment (one KaTeX regression away from
injection into a privileged origin, and reads as the regression it looks like — `render.tsx`
opens by promising no HTML string is produced). Temml (MathML-only, smaller; keep as the fallback
if KaTeX's size ever matters). KaTeX HTML+CSS output (better typography, and then the fonts and
their terms come too).

**Reason.** "Math renders from vendored code, never a CDN" is the milestone's rule; the allowlist
is `CLAUDE.md`'s "nothing here produces an HTML string" kept rather than excused.

**Frozen.** No CDN, and no HTML string reaching the page. Not frozen: KaTeX itself, or MathML —
switching to HTML+CSS output is a one-line change plus a font copy, and `pdfjsAssets()` is the
template.

---

## 2026-08-01 — An excerpt is markdown, not a node type (S03)

**Decision.** A highlight quoted into a notebook is a blockquote plus one `annotation://` link
(`packages/document-model/src/excerpt.ts`), inserted from the page through a two-step picker, and
accompanied by a real `question-references-annotation` edge. `RenderOptions.internalLinks` turns
`document://` / `annotation://` / `note://` links into chips that navigate.

**Evidence.** `EmbeddedExcerptNode` exists in `@wr/note-editor` and is registered only in the
note editor; `noteContentForAnnotation`, the only thing that builds one, has no call site in the
app. A ProseMirror node cannot live in `questions.body` at all, which is a markdown string.
`safeHref` allows only `https?:|mailto:|rrfile:|#|.|/`, so before this an `annotation://` link
rendered as an inert `<a href="#">`.

**Alternatives.** Make the notebook page a Tiptap document (loses search, the librarian, and the
text editor, and undoes S01). Store the excerpt's text without a link (a copy, not an excerpt).

**Reason.** The researcher asked to "link (inserting the text) in a notebook directly". Markdown
is what keeps the quote visible to everything else that reads the file, and the edge is what the
desk, the graph and the ledger read.

**Frozen.** An excerpt keeps a machine-readable pointer to its source, and quoting in a notebook
creates the typed edge as well as the text. Not frozen: the blockquote's exact shape, or the
picker being the only door — E01's "send to a notebook" should reuse `excerptMarkdown`.

---

## 2026-08-01 — The ledger lists highlights from the file, not from the edges (E03)

**Decision.** `link:findForDocument` answers with two arrays: `entries` (edges, unchanged) and
`highlights` (the file's live annotations, with a link count). The panel builds one group per
marked sentence, seeded from `highlights`, and drops the entries into their group.

**Evidence.** `findForDocument` selects from `links`. A highlight with no edge produced no row,
so `LedgerPanelBody`'s group-by over `entry.near.entityId` could only ever show a sentence
something had already been said about — and "Link this highlight…" existed exactly where linking
had already happened.

**Alternatives.** Let `DocumentLedgerEntry.link` be nullable (an entry *is* an edge; every
consumer would then test for a link the type says is always there). Derive the count in the
panel from the returned entries (wrong the moment the 400-row limit truncates).

**Frozen.** The ledger's highlight list comes from `annotations`, and the count beside a group is
computed under the same predicates the entries are (`LIVE_EDGE`, no derived edge with both ends
inside the file), so the number can never disagree with the rows. Order is
`listByDocument`'s — down the page — so the ledger and the annotation sidebar agree.

---

## 2026-08-01 — Send to a notebook asks one question, and a claim is a link target (E01, E02)

**Decision.** `Send to notebook…` sits fourth in the reader's strip on the same subject rule as
`Link…` (highlight if one is selected here, else the file), runs `COMMAND_IDS.sendToNotebook`
(`Cmd+Alt+S`, "make something from here"), and opens a picker that asks only *which notebook* —
then writes through `question:attach`. Separately, `linkTypesFor` gained `→ hypothesis` branches
and the link picker gained a Claims section fed by a new `hypothesis:list`.

**Evidence.** `question-references-…` and the four `…-supports-hypothesis` types were in the
vocabulary and no gesture in the app could make one. For E02 the milestone said "only the picker
cannot see a hypothesis"; that was half — `linkTypesFor` had no hypothesis branch, and
`createDocumentLink` re-validates with the same function, so the edge could not have been written
even with the button hard-coded. A hypothesis has no row in `documents` or `notes`, so
`everythingInLibrary` structurally could not reach one.

**Alternatives.** Send to "the notebook in hand" (`notebookInHand()` exists) — puts evidence
somewhere nobody chose. Offer `related-to` to a claim — an edge that appears on neither the *For*
line nor the *Against* line and counts for nothing.

**Frozen.** Sending writes the same `question-references-…` edge a dropped card is; the
relationship to a claim is supports/opposes and nothing else; discarded notebooks are not offered
as a destination. Not frozen: where else the gesture appears (the ledger and a context menu are
obvious next homes — both should run the same command).

---

## 2026-08-01 — Delete is only reachable from the discarded shelf (I01)

**Decision.** `question:delete` refuses a notebook whose status is not `discarded`, and the
control appears only on the discarded rows, beside `Restore`. It is a hard delete: the row, and
by cascade its journal, claims and tags, and by hand every edge with the notebook, one of its
claims or one of its days at an end — which takes the desk, because a card *is* such an edge.

**Evidence.** `discarded` already carries a required reason and `Restore` already brings a
notebook back with everything it had. `links` has no foreign key to `questions`, `hypotheses` or
a journal day, so nothing in the schema removes those edges.

**Alternatives.** Offer delete on every row (an irreversible act one click from a reversible one,
on the same row). A second soft-deleted state (a shelf nobody empties).

**Frozen.** Deleting a notebook never deletes a document or an annotation — the reading is the
library, not the notebook — and the precondition is enforced in the main process rather than only
in the panel. Not frozen: whether the notebook directory grows the same control.

---

## 2026-08-01 — The wiki draws a highlight once something links it (V01)

**Decision.** `graph:overview` admits an annotation node exactly when it carries a live link
other than the `annotation-belongs-to-document` edge it was born with. `DRAWN_KINDS` is where
that lives, so the same predicate decides which highlights appear *and* what a degree counts. The
node carries a `snippet` — the words that were marked — and the page draws it in quotation marks
on a smaller filled disc, beside the paper it belongs to.

**Evidence.** The researcher: "highlights in a wiki must appear with a little bit of text that
was highlighted so it is easy to tell them apart from page nodes." Three comments in the tree
argued the opposite decision and gave the reason it was taken: a corpus drawn with *every*
highlight is a picture of the annotations. Both are true, and gap 9 is the collision — two papers
joined because a sentence in one bears on a sentence in the other (`H02`) looked exactly like two
papers that have never met.

**Alternatives.** Draw every highlight (the picture-of-annotations problem, and 300 nodes of one
paper's reading). Draw none and thicken the line between two papers whose highlights are joined
(the view inventing a row nobody wrote — the rule `overview` already refuses). A second budget for
highlights (a cap nobody asked for on a set that is already bounded by "has been linked").

**Reason.** "Has become structure" is the property the map is *of*, and it is free: the
containment edge is the one edge a new highlight has, so it is also the exclusion that keeps
`REDRAWS_THE_MAP` true — making a highlight still cannot change this answer, and the link that
puts one on the map arrives as `library:changed` with reason `link`.

**Frozen.** A highlight's degree never counts its containment edge, and a paper's degree is never
its highlight count. Not frozen: whether the wiki grows a control for showing marked sentences or
hiding them, and whether the focused view's snippet and this one should be one field.

---

## 2026-08-01 — Every day is drawn; the fold is a parameter nobody sets (V03)

**Decision.** The journal page lays its range out as weekday-aligned month grids with no day
elided. `calendarCells` keeps its collapse and its `[J02]` tests; `calendarMonths` is that same
description asked with the fold turned off.

**Evidence.** The researcher, on gap 8: "render all days." The strip read `20 21 · 9 days · 31`,
which is a sensible compression of a sparse month and looks like a calendar that failed to load.

**Alternatives.** Delete the collapse (turns `J02` red, and the fold is the right answer for any
surface that has one row to spend). Keep the fold and label it ("2 days written, 9 skipped") —
still a strip, and still not a calendar.

**Frozen.** Which days exist and whether each is logged is answered in one place. Not frozen: the
week's first day is Monday, chosen rather than asked.

---

## 2026-08-01 — The saved-page lever multiplies the fit, and leaves the layout width alone (V04)

**Decision.** `HtmlReaderView` keeps `DESKTOP_WIDTH_PX` and its documented reason; the zoom lever
scales the frame on top of the fit, and past 1× the viewport scrolls sideways.
`data-snapshot-scale` publishes the effective scale. The setting lives on
`ArticleReaderPanelSchema.zoom`.

**Evidence.** Gap 2, and the researcher's "I will only ever do two side by side, plus maybe
something on the bottom" — so the lever is per panel, not a preference. A page laid out below its
own breakpoint renders its phone layout and drops its navigation, which is the reason the fixed
width exists and is not what the gap is about.

**Alternatives.** Lay the page out at the panel's width (the phone layout, which is the bug the
fixed width fixed). A global reading-size setting (two saved pages side by side want two sizes).

**Frozen.** The attribute reports what is drawn — the webpage suite computes every click inside
the archive from it, and a lever that moved the picture without moving the attribute would put
every click on the page's `<body>`.


## 2026-08-01 — A context menu is a reading of the command registry, not a list of actions (R01)

**Decision.** `packages/workbench/src/menus.ts` holds command **ids** per surface and nothing
else; `buildContextMenu` resolves each against the command and keybinding registries at click
time, so every word a menu shows — title, category, chord — is the registries', and help and the
guide already know it. Three declarative filters keep an entry off a menu: its `when` clause, the
arguments the target could supply (`requires`), and the kinds of thing it applies to (`forTypes`).
A block had no registered action, so three were added (`editBlock`, `addTextBlock`,
`addCodeBlock`, category *Writing*) rather than the menu inventing any.

**Evidence.** The criterion: "a menu is the command registry read contextually — never a second,
parallel list of actions — so help and the guide already know everything a menu offers". The e2e
asserts exactly that, by reading the menu and then looking each item up on the help page.

**Alternatives.** Per-surface menu components with their own handlers (the second list, by
construction). Greying disabled items as the palette does — rejected: a palette is an inventory
of the application, a menu is a claim about the thing under the pointer.

**Frozen.** No menu offers discarding or deleting a notebook. Both are the queue's, guarded and
in that order (`I01`), and a menu that reached past a guard would be the guard's second door.
No menu deletes a block either: an emptied block disappears on commit, so removing prose stays
where the prose is visible.

**Composed, not collided.** A right-click inside the archive frame is an event in a sandboxed
nested browsing context and never crosses into the renderer's document — it is how a selection
leaves a saved page (`H01`). The reader's chrome carries the menu; the frame carries the
selection.


## 2026-08-01 — The guide is generated against the registries, in three tiers (O01)

**Decision.** A `Guide` page (`Cmd+Shift+U`, `wr.openGuide`, and a status-bar button beside
Help) that answers *what is this app and how do I use it*, where help answers *which key does
this*. `packages/workbench/src/guide.ts` holds fourteen chapters in the order a researcher meets
the app; each chapter owns only prose and **ids**. Every title and chord it displays is read out
of the command and keybinding registries at draw time — the same discipline as `menus.ts`, so
help, the menus and the guide are three readings of one authority.

**How it cannot rot**, since "a feature is not done until the guide shows it" is otherwise a
habit. Three tiers, all mechanical:

1. *Commands.* `guideCoverage` runs against the live `CommandRegistry` on mount. A command no
   chapter names is `missing`; a chapter naming an unregistered command is `unknown`. Both fail
   `packages/workbench/test/guide.test.ts` **and** are drawn on the page in a warning band, so a
   gap is visible to whoever is looking at the app, not only in CI. The e2e cross-checks it the
   only honest way: against the help page, which *is* `commands.all()` rendered.
2. *Panel controls.* The graph filter, the saved-page zoom lever, discard and delete, the
   excerpt insert — features that act on the panel in front of you, so nothing is gained by
   putting them on the global registry. `PANEL_CONTROLS` declares them; the panel that draws one
   carries `data-control="<id>"`; `tests/integration/guide-controls.test.ts` reads the renderer's
   source and asserts the two sets are equal **in both directions**, and forbids a computed
   `data-control={…}` because nothing can be read out of source about one.
3. *Context menus.* Every `ContextMenuKind` must be covered, so the right hand is taught.

Prose is the one part no test can judge; keeping a chapter to a paragraph and a few steps is the
mitigation.

**Motion is vendored, and stops.** Fourteen inline SVGs animated by keyframes in
`apps/desktop/src/renderer/guide.css`. No animation library, no video, nothing fetched — a
local-first reader that reached a CDN to explain itself would contradict the sentence it was
drawing. Every drawing's static attributes are its **resting** state, so
`prefers-reduced-motion: reduce` switches all of it off and leaves a diagram; the e2e asserts
both directions with `emulateMedia`.

**Alternatives.** Grouping `commands.all()` by category and calling that a guide — rejected: a
category is what a command is *about*, a chapter is *when you would want it*, and a generated
grouping teaches nothing. Adding the guide's coverage to the help page — rejected: a reference
needs you to already know the word you are looking up.

**Frozen.** The guide never spells out a command's title or chord. `U` is the guide's letter
because `G` is the link graph's and the page family takes the first free letter, left to right.

---

## 2026-08-01 — Display truncation is its own function, and never `normalizeText`

**Decision.** `collapseWhitespace` and `ellipsize` live in
`packages/document-model/src/display.ts`. One contract: `limit` is the width of the answer,
**ellipsis included**, so a caller with room for forty characters asks for forty. Everything
that shortens text for a label, a tooltip, a status line or a graph snippet goes through them.

**Evidence.** Seven copies of the same two lines: twice in `@wr/database` — the second saying in
a comment that it was "the same shape `EntityResolver` uses" — once in `excerpt.ts`, four in the
renderer. They disagreed about whether the ellipsis was inside the budget, so the same
sentence came back one character shorter on the wiki than in a picker.

**Alternatives.** Reuse `normalizeText` (rejected, below). One helper per package (three copies
instead of seven). Leave them (the disagreement was already there and invisible).

**Reason.** `@wr/document-model` is the one package the renderer and the main process both
already depend on, and truncation is a property of the text, not of a surface.

**Frozen.** These are **display only**. `normalizeText` is versioned by
`NORMALIZATION_VERSION` and every persisted anchor offset is computed against it, so a change
to how a title reads under a disc must not be able to move an anchor. Nothing stores or anchors
from what `display.ts` returns, and the file says so at the top.

**Consequence.** `foldCharacters` — the five steps `normalizeText` and
`normalizeTextPreservingParagraphs` share before they disagree about line structure — is now
written once, for the same reason: a change made to one copy would have given the two functions
different alphabets under one version number.

---

## 2026-08-01 — A panel widget runs a command; it does not do its own IPC

**Decision.** The annotation card's Note button runs `COMMAND_IDS.newNoteFromHere` with the
highlight it is drawn for. Any panel control whose effect a command already names does the same.

**Evidence.** The button ran its own `annotation:get` + `note:create` + navigate — the same four
calls, the same `Note on “…”` title and the same forty characters as the command that the
palette, the keybinding and the context menu all reach.

**Alternatives.** Keep both and test both (two paths to one gesture is how they drift; the
titles were already produced by two different truncators). Delete the button (`R01` and the
guide both want the gesture where the reading is).

**Reason.** "Panels never manipulate each other directly — everything goes through the command
registry" is a standing invariant, and a panel calling IPC to do what a command does is the same
failure one layer down.

**Frozen.** A control that duplicates a command's effect runs that command. A control that has
no command — the graph's filter, the zoom lever, discard and delete — stays a `PANEL_CONTROLS`
entry, because putting it on the global registry would buy nothing and cost a `when` clause.

---

## 2026-08-01 — A notebook is one document; what lands on it lands *in* it

**Decision.** The desk board is retired (`P06`). A `question-references-…` edge still records
what a notebook was built from, and it is now *shown* as a block appended to `questions.body`:
a paper as `[Title](document://…)`, a highlight as the excerpt `S03` already defined. The
margin goes with it (`P10`) — front matter, the outline and the hypotheses are sections of the
one scrolling page, reached by a jump strip under the title. `Cmd+S` saves that page without
closing the block being typed in (`P12`).

**Evidence.** The board and the page held the same edges and neither was the notebook. `E01`
sent a highlight to a surface the researcher had to look away from the paper to read;
`notebookPage` answered with a `cards` array the page drew twice over.

**Alternatives.** Keep the board and make it narrower (the researcher's feedback was that a
page you write in should not be a quarter of its own panel). Move positions into a JSON column
(a position is a fact about a surface that no longer exists).

**Reason.** "All relationships are typed directed edges in `links`" was never in question — what
was, was how many places draw them. One document is one place.

**Frozen.** `appendNotebookBlocks` (`main/notebook-body.ts`) is the only way the main process
writes prose into a page, and it skips a block whose internal link the page already carries —
so a send, a drop and the one-time migration off the desk are each idempotent without any of
them knowing about the others. An unwritten page appends to `blankNotebook()` rather than to
the empty string, or landing a paper would replace four template headings with one line. The
one caller that writes its own block passes `landsAsBlock: false`: the excerpt picker puts the
quote where the caret is, and a second copy at the end of the document is not a feature.
`card_positions` was dropped in migration 014 rather than left behind.

**Frozen.** `Cmd+S` carries **no** `!textInputFocus` guard — saving while typing is the point —
and `BlockEditor.save()` re-parses its rows only when the store answered with markdown that is
not what it was sent, because a rebuilt row is a textarea React has replaced and that takes the
caret with it. Menu accelerators pre-empt the renderer, so `main/menu.test.ts` asserts that no
menu item anywhere binds `Cmd+S`; the E2E half cannot see a menu at all.


---

## 2026-08-01 — The page is handled: blocks move, days open ready, the journal pops up

**Decision.** Four gestures the writing surfaces were missing. A block is dragged by a grip and
deleted by a × or a menu item (`P07`). A surface that asks for it opens an empty document with
its first block ready to type in, which is what a new journal day is (`P08`). The journal opens
as a **pop-up over the workspace** and expands into a page of it (`P09`, superseding `N09`). A
figure is resized by dragging its corner, and the width lands in the markdown (`P11`).

**Evidence.** The researcher's feedback of 2026-08-01. A page whose blocks can only be appended
is an outline, not a draft. A journal tab makes a glance — what did I do yesterday — cost the
reading it interrupted. A figure arrives at whatever size the file happens to be.

**Alternatives.** HTML5 drag-and-drop for the reorder (the preload's file-drop listener is
watching `drop` on these very elements, so a synthetic block drag would look like a picture
arriving). A width column beside the document (a second store to drift from the markdown). A
second command for "open the journal as a pop-up" (placement is the host's decision, the way
`applyPlan` decides split from reveal — `openJournal` is still the one command every door runs).

**Reason.** Everything here is still an edit of one markdown document: order *is* the document,
so `moveBlock` plus a write is the whole of a reorder.

**Frozen.** The grip and the × are drawn **outside** the block's own box. `offsetFromClick`
reads `element.textContent` to place the caret (`P05`), so a glyph inside would shift every
offset in the paragraph past it. The figure's corner handle is childless for the same reason —
an empty button contributes nothing to `textContent`.

**Frozen.** `BlockEditor` keeps a write ticket and takes rows only from the newest write's
answer. Deleting a block that is being typed in blurs first, so two writes are in flight at
once, and the older answer landing last used to bring the deleted block back.

**Frozen.** `P08`'s seed fires on an *arrival* — a `surfaceId` never seeded (the id names the
notebook **and** the day, so switching days is a different surface) or a document emptied down
to no blocks — and never merely because a block was left blank. "Re-open whenever the document
is empty" is a focus trap: clicking the calendar with an untouched block open would blur, notice
the emptiness and take the caret straight back off the day being reached for. A blank block left
behind carries the invitation the empty state used to.

**Frozen.** A resized figure's width is one word (`w=320`) in markdown's own title slot, and
`IMAGE_ONLY` tolerates that slot — `classify` runs on every keystroke, and a resized image whose
source stopped looking like a lone image would become a `text` block and lose its handle, its
drawing and its width together. A caption in the same slot survives a drag.

**Frozen.** The journal pop-up is the shared `Overlay`, so it is modal: a test that opens it and
then reaches for the workspace has to dismiss it. It is not part of the saved layout.

**Frozen.** The chrome's persisted size is bounded by `CHROME_BOUNDS` in `layout.ts`, never by a
CSS `min-width` — a floor in CSS lets the workspace *store* a width the panel is not drawn at,
and the restart is where the two disagree. `chromeExtent` is the one function that answers how
big a panel is, so the inline style and any assertion read the same number.

**Frozen.** The chrome rides as a **defaulted key** on `SerializedWorkspaceSchema`.
`WORKSPACE_LAYOUT_VERSION` is not bumped for a new key: `deserializeWorkspace` refuses any other
version outright, so a bump would trade the researcher's whole arrangement for a feature about
arranging things.

**Frozen.** Folding a panel is not closing it (`U09`). A folded panel is still open, its activity
button stays lit, and `chrome.minimized` is separate from `sidebars` for exactly that reason. The
rail is `CHROME_RAIL_SIZE` wide and holds **one** control — two of them overflow it and put the
second button over the document, where it is a control drawn outside the panel it belongs to.

**Frozen.** The annotations column's ✕ runs `COMMAND_IDS.toggleAnnotationSidebar` rather than
writing `sidebars`, so a lit activity button over a panel that is not there is unreachable.

**Frozen.** `questions.trashed_at` is the bin (`U11`) and is not a fourth status. A binned
notebook is still `discarded` and still carries its reason, which is what keeps
`question:delete`'s discard-first precondition — the one `menus.ts` cites for offering delete
nowhere else — true unchanged. `question:emptyTrash` is the only channel that destroys a line of
work; it takes no argument, because emptying a bin is one decision about everything in it.

**Frozen.** `library:removeDocument` does **not** enter the bin. It already keeps the file's
highlights and links, so it is a different act from deleting a notebook, and one bin holding both
would tell the researcher that putting a paper back would put a notebook back too.

**Frozen.** A search hit is one of four things and only two are a file (`U10`). `searchTarget`
maps each kind to the entity the workbench already opens; a note has no `documentId` by
construction, which is exactly what the old `if (result.documentId === null) return;` swallowed
without a word.

## 2026-08-01 — The wiki lays out by force, deterministically, and focus stops hiding

**Decision.** The wiki's arrangement is a **deterministic force relaxation written in
`@wr/graph`**, not Cytoscape's `cose` (`F08`). The ranked sunflower spiral survives as the
*seed*; `forcePositions` then relaxes it — repulsion between every pair, a spring with a rest
length along every link, gravity toward the middle, a cooling schedule — and a separation phase
after the forces pushes any two overlapping discs apart until none overlap at all.

**Reason.** Cytoscape is here and its force layouts were the obvious answer, and they are the
wrong answer twice. `cose` draws from `Math.random` on every run, so the same library comes back
a different shape each time it is opened — the map stops being a *place*, which is the property
`F01` was built on and the reason the spiral was chosen over a force cloud in the first place —
and nothing could then assert where anything was drawn. Headless with `styleEnabled: false` it
also has no node sizes to keep apart, and sizes are exactly what "none overlap" is about.
Nothing in `forcePositions` reads a clock or a random number, so the same input is the same
output; the E2E asserts that by asking for the map twice and comparing every disc.

**Frozen.** The forces run in a plane with **no walls**, and the finished arrangement is brought
into the box afterwards. A hard wall during the forces stops one node and lets its neighbour
carry on, so a crowded library grows a boundary layer of discs stacked against the frame — a
state the separation cannot dig out of, because the direction it needs to push in is the
direction the wall is. With nothing pinned the result is *fitted* (one translation and one
scale over everything at once, never enlarging); with something pinned it is clamped, because
a pinned node is a fixed point and you cannot scale a picture round one. The room each disc
needs comes off the box **before** the scale is chosen: folding it into the span instead
overflows whenever the scale is under one, and a hub drawn fourteen units past the bottom of the
scene is a node no hand can press.

**Frozen.** A held node — a marked sentence and the paper it was made in (`V01`) — is **carried**
by its holder at exactly the offset the seed gave it, never relaxed. Relaxing it would pull it
off the paper it belongs to, which is the one thing the arrangement is saying about it. Its
holder's radius is widened to cover the whole cluster instead, so the separation keeps everything
clear of the ring rather than of the disc in the middle of it, and a satellite ring widens with
the number of sentences on it so siblings cannot touch either.

**Frozen.** Focusing **reframes**; it does not filter (`F09`). The focused state of the wiki
draws the file, the sentences marked in it and the files it reaches exactly as `F02` laid them
out — that band is *pinned*, so the criterion's geometry is untouched — and the rest of the
library is drawn round them in a field outside the outer ring, dimmed and still clickable. The
researcher's words were that focus should not hide things, just centre around the focused thing.
`--faded` is that dimming and is deliberately **not** `--dimmed`: the filter's says "this is not
what you typed" and this says "this is not what the view is about", a node can be both, and one
class for two claims would make `V02` and `F09` unable to disagree.

**Frozen.** The picker's copy of the focused view draws **no** context. Its two stages are
already the whole library and then one file inside it, so a library drawn behind the file would
put the same discs on the screen twice, meaning different things a press apart.

**Frozen.** Typst is compiled by **`@myriaddreamin/typst-ts-node-compiler` in the main process**,
never by the WASM build in the renderer (`S04`). The WASM route costs `'wasm-unsafe-eval'` in the
window's `script-src`, which is a permanent widening of the one CSP the security invariants rest
on, bought for a latency saving that measurement puts at under a millisecond: creating the
compiler is ~50 ms once, a warm block compile is ~0.7 ms, and the IPC round trip is the cost
either way. The addon is NAPI, so one binary loads under Node 20 and Electron 33 alike and it
needs no `build_electron_native.mjs` equivalent. Its specifier is in the verifier's
`FORBIDDEN_RENDERER_IMPORTS` so the boundary is enforced rather than intended. It links an HTTP
client and has no switch to disable the package registry, so `refuseNetworkImports` runs *in
front of* every compile — `@preview/` and `@local/` never reach it.

**Frozen.** **Nothing already written is converted.** `questions.body_format` defaults to
`'markdown'`, so every page written before the switch goes on saying what it is and goes on
rendering through the markdown pipeline; only notebooks minted after migration 016 are Typst.
The alternative — a converter — is a guess about somebody's paper that cannot be checked until
after it has overwritten the original, and "nothing is lost" then rests on the quality of a
regex rather than on a column nobody rewrote. Markdown's `INLINE_CONSTRUCT_RE`, `projectText` and
`foldBlock` stay markdown's; Typst gets `@wr/document-model/typst.ts` beside them and the two
never merge.

**Frozen.** The three things that had to survive the language have **one** Typst spelling each,
in `@wr/document-model`: an excerpt is `#quote(block: true, attribution: link("annotation://…")[…])`
(Typst's own element, so the HTML target gives it a `<blockquote cite>` with a real `<a>` beside
it); an internal link is `#link("<scheme>://<id>")[…]`; a wikilink is `#link("wiki://<target>")[…]`,
because Typst has no `[[…]]` and a scheme is what both languages can carry. `notebook-body.ts`'s
idempotency key is the **scheme and id**, not the punctuation round them — the old pattern
required markdown's parentheses and would have silently written a second copy of every excerpt
sent twice.

**Frozen.** The HTML target **drops mathematics without erroring**. `#show math.equation: it =>
html.frame(it)` is prepended to every block compiled for reading, so an equation is typeset to an
inlined SVG instead of vanishing. A show rule rather than a regex over the source: the compiler
is the thing that knows where an equation is, and a silent drop of the researcher's formulas is
the milestone-8 shape of the bug milestone 7 spent itself on.

**Frozen.** A picture reaches the compiler as `mapShadow('<workspace>/img/<internal file id>',
bytes)`, and the document names it `#image("/img/<file id>")` (`S06`). The workspace root is
virtual — nothing is written there and the directory does not exist — and the bytes come through
`resolveFileRequest`, the same allow-list `rrfile://` uses. So the name inside a notebook is an
internal id, there is no path for the renderer to receive and none for a document to forge.

**Frozen.** The live render's placement is a **pure function of the panel's box**
(`liveRenderPlacement`), not a media query and not a stored value: wider than 1.3× its height →
beside, taller than 1.3× its width → stacked, anything between → nothing. Only the stacked case
has a setting (`below` / `top` / `off`), because only it has a choice to make. A stored placement
would be a second answer that goes stale the moment a splitter moves.
