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
