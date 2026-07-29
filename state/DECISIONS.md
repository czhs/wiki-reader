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
