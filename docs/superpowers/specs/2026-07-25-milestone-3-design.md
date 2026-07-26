# Milestone 3 — queue, journal, librarian

Design agreed 2026-07-25. Criteria live in `docs/MILESTONE3.md`; this is the reasoning behind
them and the decisions a reader would otherwise have to reverse-engineer.

## What this milestone is

Milestone 2 built a reader. It knows what you *have*. It knows nothing about what you are
trying to find out, and it cannot help you find it.

Three parts, in dependency order:

- **Queue** — the research questions, with a status and a hand-chosen order.
- **Journal** — a dated diary, orthogonal to any single question.
- **Librarian** — a headless `claude` that reads the wiki and works it.

Queue and journal come first because the librarian links its findings *to* them. Build the
targets before the thing that points at them.

Both queue and journal are migrations of features that already exist and are in daily use in
`~/Desktop/fieldstation`, a Jekyll notebook. That is the reference implementation: it says what
the shape should be. What it stores in a browser `localStorage` blob and a committed
`state.json`, wiki-reader stores in SQLite as first-class entities.

## The queue

A **question** is a research question being worked on. From fieldstation's `_notebook/*.md`
front matter, the fields that carry weight:

- `status` — `active` | `queued` | `discarded`. Which list it appears in.
- `importance`, `started`, `next_action` — what makes the active list readable at a glance.
- `discarded_reason` — why it was dropped. Kept, because the reason is the useful part.

Order is **manual and meaningful**: fieldstation keeps a `queueOrder` array of slugs precisely
because the owner arranges the queue by hand and the arrangement is a judgement about what to do
next. Sorting by date or importance would throw that away, so the order is stored, not derived.

Questions connect to the rest of the app through the existing `links` table as typed directed
edges — a question to the papers that bear on it, to the annotations that evidence it. No new
relationship mechanism; `Q04` asserts the edges are the same kind everything else uses.

**Hypotheses** are deliberately not modelled yet. Fieldstation carries them inside a question's
prose, and the eventual shape — the thing the librarian will cite against — is not yet settled.
A wrong entity now is more expensive than a missing one.

## The journal

A dated research diary: one markdown entry per ISO date, project-global rather than per-question.
It answers "what did I do, and what did I learn" across everything, which is a different question
from "where is this one thread".

Two behaviours worth keeping from fieldstation, both about honesty of display:

- A day with a blank entry is **unlogged**, and is deleted rather than stored as an empty string.
  "No entry" and "an empty entry" are the same fact and should not look different.
- A run of four or more consecutive unlogged days **collapses** into one marker. A calendar that
  renders every empty day as an empty bubble buries the days that have something in them. Today
  always shows, logged or not, and splits a run.

`J02` covers the collapse because it is the piece with an off-by-one in it.

## The librarian

A headless `claude`, spawned with `--system-prompt-file` — which *replaces* the default system
prompt rather than appending to it — plus `--add-dir <workspace>`, `--permission-mode acceptEdits`,
and `--output-format stream-json` so progress can be streamed into the app and cancelled.

### The wiki is the whole app

There is no separate wiki document class. The papers, the saved pages, the notes, the questions,
the journal — that is the wiki. What distinguishes the librarian from the researcher is not what
it can see but **what it may touch**: it reads all of it, and writes only in its own workspace,
where it keeps its own notes, maps and connection logs. This is the arrangement a Karpathy-style
wiki gives a collaborator, and within that workspace its reach across threads is deliberately
wide.

So the `source` column already carries what is needed — `zotero`, `corpus`, and now `librarian`
for the agent's own notes. A write is legal if and only if it lands in the workspace.

### The write boundary

A **path boundary**, enforced twice: the spawn is given only the workspace directory, and every
write is re-checked against it before it lands. Belt and braces, because a saved web page is
hostile input and a page that talks the agent into writing elsewhere has to fail at the tool
boundary regardless of what the prompt said.

### How it works: co-presence, not retrieval

This is the load-bearing decision of the whole milestone, and it is the one most likely to be
quietly undone by someone trying to help.

The librarian's connections come from **many documents being in one context at the same time**.
Two papers turn out to disagree, or to be the same idea in different vocabulary, because both
were read together and the difference was noticed. That is not a property that survives being
turned into a similarity query: top-k retrieval decides what is related *before* the model
thinks, which is precisely the judgement the librarian exists to make.

So there is no RAG in the agent path — no embeddings, no vector store, no ranking. The librarian
is agentic and crawls the wiki however it likes: listing, opening, following `[[wikilinks]]`,
reading documents whole. The FTS5 index built in milestone 1 stays what it was, something the
researcher searches with. It is not a retrieval layer under the agent, and `A11` exists because
"the corpus is bigger than the context, add retrieval" is the reflex answer and it is wrong here.

### Organisation, not compression

The answer to a corpus bigger than the context is a better-organised corpus — not a compressed
one. The distinction matters more than it first appears.

Better organisation lets a later pass hold more of the wiki at once, and holding more at once is
what turns up connections and contradictions. That is a slow, cumulative effect and not a
per-run target: it is fine, and correct, for a pass over unchanged material to change nothing.

Compression is a different thing and is frequently a *loss*. A summary that drops the exact
detail two papers disagree about has destroyed precisely what the librarian exists to find. So
the preference is structure, cross-links and maps that **point** — over prose that replaces.
`A12` has a note record which documents it covers so a later pass can route between map and
sources; it is a routing aid, not a claim that the map substitutes for them.

`A13`'s second half guards the failure mode. An agent asked to improve a wiki will find something
to write every single time, and a pass that produces new notes over material it has already seen
is padding — which makes the wiki worse, slowly, in exactly the dimension this section is about.

### Scheduling

Roughly twice a day, more often after a batch of imports. Deliberately **not** event-triggered
per document: the work is cumulative rather than a reaction to any one arrival, and a pass earns
its keep when there is new material *or* when the previous one left threads it did not follow.

### What it produces, and how much reach it has

Its remit is a **set of capabilities**, not a paragraph of prompt:

| capability | status |
|------------|--------|
| connect threads across the wiki | core |
| name contradictions, citing both sides | core |
| surface evidence for and against a question | core |
| suggest research directions | **on, switchable off** |

The first three are what the librarian is for and are not expected to move. The fourth is under
review — how much reach the librarian should have is genuinely undecided, so it ships on and
must come off without touching anything else. That is why capabilities are data: each is a line
appended to the system prompt only when enabled, so switching one off removes it rather than
arguing against it in a longer prompt. `A09` asserts the removal, which is only testable in that
form.

Everything it produces is a **proposal**: nothing lands without an explicit accept (`A05`). A
wiki that accumulates unread machine output is a log, not a wiki — the accept step is where a
person decides it is true.

Accepting writes markdown with `[[wikilinks]]` into the workspace, so it stays readable in
Obsidian or Foam and lives in the researcher's own git repo. After that it is an ordinary file,
editable like any other; there is no separate staging-and-editing step because the file *is* the
editable artifact.

Every citation resolves against the database before a proposal is shown (`A04`). An agent asked
for citations will produce citation-shaped text whether or not the documents exist, so the
resolution is done at the boundary rather than trusted from the output.

### Prompts

Short. `docs/AGENTS.md` holds the reasoning and the librarian's actual prompt. The summary is
that a thirty-line prompt specifying an output schema returns schema-shaped output and no
judgement, and that anything which must be machine-readable should be validated on the way in
rather than described on the way out.

## Carry-over fixes

Three things milestone 2 left, folded in as `C01`–`C03`: scoping the Zotero import by picking
collections, choosing the notes folder in-app, and labelling the activity bar. The second also
purges the twelve stranded corpus records currently in the database — they were
ingested when `WR_MARKDOWN_ROOT` pointed at fieldstation's wiki, and now resolve to paths
outside the allowed roots, so opening one returns `403 Forbidden` from `rrfile://`.

## Testing

Same rule as before: a criterion is done when a test whose title carries its tag passes. Two
deserve attention because the obvious test passes against no implementation:

- `A02` — an agent told not to write outside its folder will mostly comply. Assert that a write
  which *tries* to escape is refused, not that a well-behaved run stayed inside.
- `A04` — assert citations resolve to rows, not that the text looks like a citation.

## Open, deliberately

- **Hypotheses as entities** — arrives with the rest of the fieldstation migration. They are
  what the librarian's evidence will attach to.
- **How much reach the librarian should have** — suggesting directions ships on and switchable.
  Whether it stays is a decision to make after using it, which is why it is a capability flag
  and not a paragraph someone has to edit out of a prompt.
- **The reviewer agent** — the spec's second agent, milestone 4. Out of scope here, but its
  shape is already decided and worth not re-deriving: it critiques a research journal as a
  demanding mechanistic-interpretability mentor, and what makes it *that* reviewer is that it
  reads Neel Nanda's *How to become a mechanistic interpretability researcher* and *A pragmatic
  vision for interpretability* verbatim first. The lens comes from those sources, not from
  adjectives in a prompt.

  Both are already in the library — imported from Zotero like any other saved page
  (`VWPWR9BS`, `VS7MANRS`). Fieldstation keeps a second copy under `wiki/reviewer/` only
  because its agents could see nothing but the wiki folder. Here the wiki is the whole app, so
  a lens is a **list of document ids** and the agent reads them where they already live: one
  copy, readable by the researcher too, current whenever the source is re-imported.

  This generalises. Any agent whose judgement is grounded in particular material should point
  at documents in the wiki rather than carry a paraphrase in its prompt — 29,000 words of
  essay cannot go in a system prompt, and the summary that would fit makes a worse reviewer.
  See `docs/AGENTS.md`.
- **Model choice** — the runner shells out to `claude`, so the model is whatever that CLI is
  configured with. No provider abstraction until something needs one.
