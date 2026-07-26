# Agents

An agent here is a headless `claude` process, spawned with `--system-prompt-file` so its system
prompt is *replaced* rather than appended to. It gets `--add-dir <workspace>` and nothing else.

## Writing prompts for them

Keep them short. State the goal, state the boundary, stop.

A long prompt is not a more careful one. Fieldstation's librarian prompt ran thirty lines and
spent most of them specifying a JSON schema; what came back was schema-shaped and thin. The
model is better at deciding how to organise a wiki than any of us are at describing it in
advance, and every sentence of instruction is a sentence of judgement given up.

So: say what the wiki is for, say what must not be touched, and leave the shape open. If output
has to be machine-readable, validate it on the way in rather than describing it on the way out —
a schema in the prompt is a request, a schema at the boundary is a guarantee.

Two things always belong in the prompt, because they are about intent rather than mechanism:

- what the wiki is **for** — a research wiki, built from what has actually been read, where
  what was read becomes something that can be thought with;
- what may be **written** — the agent's own workspace, and nothing else.

The boundary is still enforced in code (`A02`). Saying it in the prompt is courtesy, not
security: a saved web page is hostile input, and a page that talks the agent into writing
somewhere else must fail at the tool boundary regardless of what the prompt said.

## The librarian, in full

Roughly what should be on disk as the system prompt. If it grows past a screen, something has
gone wrong.

> You are the librarian for a personal research wiki.
>
> The whole wiki is yours to read: the papers, the saved pages, the researcher's notes, the
> open questions, the journal. You write only in your own workspace — your notes, your maps,
> your logs. Everything else is read-only.
>
> Your work is to make what has been read into something that can be thought with. Connect
> threads across it, however far apart they sit. Say plainly where two sources disagree, and
> cite both. Set out the evidence for and against a question, on both sides.
>
> Read widely and read whole documents. Connections come from holding many of them in mind at
> once, not from searching for the ones that look related — a search has already decided what
> is related before you get to think about it. Crawl wherever the material leads.
>
> Leave the wiki denser than you found it. Your notes exist so that a later pass can hold more
> of the wiki at once than you could: a map worth having is one that can be read *instead of*
> the documents it covers. Say which documents each note covers. Text that restates a source
> without compressing it costs context and returns nothing.
>
> Cite everything. A claim without a source is worse than a missing claim.
>
> Organise your workspace however serves someone trying to make progress. Use `[[wikilinks]]`
> so the graph is real.

The capabilities are appended to that, one line each, and only the enabled ones (`A09`):

> Where the material points somewhere worth going next, say so.

## How the librarian actually finds things: no retrieval

Connections come from **many documents being in one context at the same time**. Two papers
disagree, or turn out to be the same idea, because both were read together and the difference
was noticed. Nothing about that survives being turned into a similarity query.

So there is no RAG in the agent path. No embeddings, no vector store, no top-k. The librarian is
agentic: it crawls the wiki however it likes — listing, opening, following `[[wikilinks]]` — and
reads documents **whole**. The FTS5 index stays what it has always been, a thing for the
researcher to search with, not a retrieval layer bolted underneath the agent.

This is a real constraint and it is easy to violate by accident, because retrieval is the
reflex answer to "the corpus is bigger than the context". It is the wrong answer here: top-k
chunks are exactly the input that cannot produce a connection, since the ranking already
decided what was related before the model got to think about it.

## Density is the mechanism, not a side effect

The context window is the budget, and the librarian's job is to make more of the wiki fit inside
it. Every run leaves the wiki better organised than it found it, so the *next* run can hold more
of it at once and see connections the previous one could not. Organisation buys context, context
buys connections, connections are worth organising. That loop is the whole design.

Which means the librarian's workspace notes are not merely its output — they are the mechanism.
A good map is one a later run can load *instead of* the twenty documents it stands for, and be
no worse off. So a note says what it covers: the documents it compresses, by id, so a later run
can decide whether to load the map or go to the sources.

Density must go **up, never down**. A run that adds notes without raising what fits in a context
has done nothing, however much it wrote. Prose that restates a source without compressing it is
a loss — it costs context and returns nothing.

## Capabilities are data, not prose

The librarian's remit is a set — connect, contradict, evidence, and for now suggest-directions
— and each is a line appended to the prompt only when it is on. How much reach the librarian
should have is an open question, so switching one off has to *remove* it rather than argue
against it in a longer prompt. That is also the only version a test can check, which is what
`A09` asserts.

Connecting, contradicting and weighing evidence are the core and are not expected to move.
Suggesting directions is the one under review.

## A lens is a reading list, not a prompt

The reviewer — milestone 4, but the shape is decided — critiques a research journal as a
demanding mechanistic-interpretability mentor. What makes it that particular reviewer is not
adjectives in its prompt. It is that it reads two essays first, verbatim: Nanda's *How to become
a mechanistic interpretability researcher* and *A pragmatic vision for interpretability*. The
stance comes from the sources; the prompt only says to go and read them.

This is the same principle as keeping prompts short, arrived at from the other side. Nobody
could write those 29,000 words of judgement into a system prompt, and a paraphrase would be a
worse reviewer. Point at the material instead.

In wiki-reader that costs nothing extra, because **both essays are already in the library** —
they were imported from Zotero like any other saved page. Fieldstation had to keep a second copy
under `wiki/reviewer/` because its agents could only see the wiki folder; here the wiki is the
whole app, so a lens is a list of document ids and the agent reads them where they already live.
Anything a reviewer's charter is grounded in should be a document in the wiki, not a file beside
the prompt — that way it is one thing, readable by the researcher too, and it stays current when
the source is re-imported.

The charter itself stays short and says what to do rather than what to think: restate the claim,
ask the questions that expose unstated assumptions, name the single strongest objection and
steelman it, propose the cheapest informative next experiments with the prediction that would
change your mind. Critique only; never rewrite the researcher's hypotheses, never edit their
journal.

## Why they are proposals

The librarian never writes into the wiki directly; it produces proposals a person accepts or
rejects (`A05`). This is not distrust of the model so much as the thing that keeps the wiki
worth having — a wiki that accumulates unread machine output stops being a wiki and becomes a
log. The accept step is where a person decides it is true.

## Disclosure

Agents are off until switched on, and switching them on says what leaves the machine first
(`A03`). With them off, nothing in the app touches the network. Keep that true, and keep the
sentence in `README.md` that promises it.
