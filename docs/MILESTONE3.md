# Milestone 3 — the queue, the journal, and the librarian

Milestone 2 gave you a reader: Zotero papers, saved pages, markdown, highlights, typed links,
search, a graph. It reads what you already have. This milestone is about what you are *trying
to find out*, and about an agent that helps you find it.

Three things, in this order. The order matters: the librarian links its findings to questions
and journal entries, so those have to exist first.

1. **The queue** — research questions with a status and a hand-chosen order.
2. **The journal** — a dated research diary, orthogonal to any one question.
3. **The librarian** — a headless `claude` that reads the wiki and works it: connections,
   contradictions, evidence for and against.

## The wiki is the whole app

Papers, saved pages, notes, questions, the journal — that *is* the wiki. There is no separate
wiki document class and no separate wiki folder.

What separates the librarian from you is not what it can see but **what it may touch**. It reads
everything. It writes only in its own workspace, where it keeps its own notes, maps and
connection logs — the same arrangement a Karpathy-style wiki gives a collaborator. Within that
workspace it may connect any thread to any other; the reach is deliberately wide.

## Rules

- **The librarian writes only in its own workspace.** Everything else is read-only to it.
  Enforce it at the tool boundary — refuse and log — not by asking the agent nicely in a
  prompt. Its notes carry `source = 'librarian'`.
- **Agents are the only exception to local-first.** Off by default, the user's own credentials,
  a disclosure of what would be sent before the first run. With agents disabled nothing in the
  app touches the network. `README.md` says so plainly.
- **The librarian proposes.** Nothing it writes lands without an explicit accept.
- **Its remit is a set of capabilities, and they are switchable.** Connecting threads, naming
  contradictions and surfacing evidence for and against are the core. Suggesting research
  directions is on for now and must be switchable off without touching anything else — the
  question of how much reach it should have is open, and the code should not assume an answer.
- **No retrieval in the agent path.** No embeddings, no vector store, no top-k. The librarian
  crawls and reads whole documents; connections come from many of them being in one context at
  once, which is exactly what a similarity query destroys. FTS5 stays what it is — a thing the
  researcher searches with, not a retrieval layer under the agent.
- **Organisation, not compression.** Better organisation is what lets a later pass hold more of
  the wiki at once, and that is what turns up connections. It is cumulative, not a per-run
  target. Compression is often a loss — a summary that drops the detail two papers disagree
  about has destroyed the thing worth finding. A pass that finds nothing leaves the wiki alone.
- **It runs on a schedule**, roughly twice a day and more often after a batch of imports — not
  triggered by any single document, because the work is cumulative.
- Prompts the agent reads are **short**. State the goal and the boundary; let it choose the
  structure. A prompt that specifies the output schema in detail gets a schema back and no
  judgement. See `docs/AGENTS.md`.
- Everything else in `docs/SPEC.md` is still later. Don't build it.

## Carry-over from milestone 2

| Tag | Criterion | Kind |
|-----|-----------|------|
| C01 | Zotero import is scoped by picking collections, and the picks are remembered | E2E |
| C02 | The notes folder is chosen in-app; documents from a folder no longer in use are purged | integration |
| C03 | Every activity-bar control has a visible label, not only a glyph | E2E |

## Criteria

| Tag | Criterion | Kind |
|-----|-----------|------|
| Q01 | A question has a status — active, queued, discarded — that survives restart | integration |
| Q02 | The queue is hand-ordered and the order survives restart | E2E |
| Q03 | A discarded question keeps its reason and leaves the active list | integration |
| Q04 | A question links to documents and annotations as typed edges | integration |
| J01 | A dated journal entry is written, read back, and survives restart | integration |
| J02 | The calendar marks logged days and collapses long unlogged runs | unit |
| J03 | A journal entry links to the question it advances | integration |
| A01 | A headless `claude` runs under an overriding system prompt and streams progress | integration |
| A02 | An agent write outside its own workspace is refused and logged | integration |
| A03 | Agents are off until enabled; enabling first discloses what would be sent | E2E |
| A04 | Every citation in a proposal resolves to a document actually in the wiki | integration |
| A05 | Accepting a proposal writes it into the workspace; rejecting writes nothing | E2E |
| A06 | A connection names both threads it joins and why | integration |
| A07 | A logged contradiction cites both sides | integration |
| A08 | Evidence for a question is surfaced both supporting and opposing, each cited | integration |
| A09 | Suggesting research directions can be switched off, and then none are produced | integration |
| A10 | A citation navigates to its source location | E2E |
| A11 | The librarian reads whole documents; no retrieval step exists in its path | integration |
| A12 | A workspace note records the documents it covers, and they resolve | integration |
| A13 | The librarian runs on a schedule, and a pass that finds nothing writes nothing | integration |

`A02` is the one that hides a bug: an agent told not to write outside its workspace will mostly
comply, so a test that only checks the happy path passes against no enforcement at all. Assert
that a write which *tries* to escape is refused.

`A04` is the other: an agent asked for citations will produce citation-shaped text whether or
not the documents exist. Resolve every one against the database.

`A09` is why the capabilities are a set and not a paragraph of prompt. Switching one off has to
actually remove it, which a test can only check if capabilities are data.

`A11` guards against the reflex fix. When the corpus outgrows the context the obvious move is to
add retrieval, and it is the wrong one — top-k chunks are precisely the input that cannot yield
a connection, because the ranking decided what was related before the model saw it. Assert the
agent is handed whole documents and that nothing in its path ranks or embeds.

`A12` makes a note's coverage explicit so a later pass can route — decide whether the map is
enough or the sources are needed. It is not a claim that the map replaces them.

`A13`'s second half is the one worth writing a test for. An agent asked to improve a wiki will
find something to write every time; a pass over unchanged material that produces new notes is
padding, and padding is what makes the wiki worse over time.

Add each tag to `scripts/verify_completion.py` as you implement it. Strengthening it is
required; weakening it is never allowed.
