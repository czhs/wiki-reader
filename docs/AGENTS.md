# Agents

A headless `claude`, spawned with `--system-prompt-file` — which *replaces* the default system
prompt, unlike `--append-system-prompt` — plus `--add-dir <workspace>`. It reads the whole wiki
and writes only in its workspace. That boundary is enforced at the tool layer (`A02`); saying it
in the prompt is courtesy, not security, because a saved web page is hostile input and a page
that talks an agent into writing elsewhere must fail regardless of what the prompt said.

## Prompts stay short

Say the goal and the boundary, then stop.

A long prompt is not a more careful one. Fieldstation's librarian prompt ran thirty lines and
spent most of them on a JSON schema; what came back was schema-shaped and thin. Every sentence of
instruction is a sentence of judgement given up, and the model is better at deciding how to
organise a wiki than we are at describing it in advance.

If output must be machine-readable, validate it on the way in. A schema in the prompt is a
request; a schema at the boundary is a guarantee.

## A lens is a reading list

What makes the reviewer (milestone 4) a Neel-Nanda-style reviewer is not adjectives in its
prompt — it reads his *How to become a mechanistic interpretability researcher* and *A pragmatic
vision for interpretability* verbatim first, and the stance comes from the essays.

Both are already in the library (`VWPWR9BS`, `VS7MANRS`), imported from Zotero like any other
saved page. So a lens is a **list of document ids**, read where they already live: one copy,
readable by the researcher too, current whenever the source is re-imported. Ground an agent's
judgement in documents, never in a paraphrase — 29,000 words will not fit in a prompt and the
summary that would makes a worse reviewer.

## No retrieval

Connections come from many documents being in one context at the same time. Top-k ranking decides
what is related *before* the model thinks, which is the judgement the librarian exists to make.

So: no embeddings, no vector store, no ranking in the agent path. It crawls — lists, opens,
follows `[[wikilinks]]` — and reads whole documents. FTS5 remains the researcher's search, not a
retrieval layer underneath the agent. This is easy to undo by accident, because retrieval is the
reflex answer to "the corpus is bigger than the context". `A11` guards it.

## Organisation, not compression

Better organisation is what lets a later pass hold more of the wiki at once, and that is what
turns up connections and contradictions. It is a slow, cumulative effect — not a per-run target.

Compression is not the goal and is often a loss. A summary that drops the detail two papers
actually disagree about has destroyed the thing worth finding. Prefer structure, cross-links and
maps that **point** over prose that replaces. A note records which documents it covers (`A12`) so
a later pass can choose the map or go to the sources — routing, not substitution.

A run that finds nothing should leave the wiki alone. Writing something anyway to look productive
is the failure mode.

## The librarian's prompt

If it grows past a screen, something has gone wrong.

> You are the librarian for a personal research wiki.
>
> The whole wiki is yours to read: the papers, the saved pages, the researcher's notes, the open
> questions, the journal. You write only in your own workspace — your notes, your maps, your
> logs. Everything else is read-only.
>
> Your work is to make what has been read into something that can be thought with. Connect
> threads across it, however far apart they sit. Say plainly where two sources disagree, and cite
> both. Set out the evidence for and against a question, on both sides.
>
> Read widely and read whole documents. Connections come from holding many of them in mind at
> once, not from searching for the ones that look related. Crawl wherever the material leads.
>
> Leave the wiki better organised than you found it, so a later pass can hold more of it at once.
> Favour structure and cross-links over summary: a summary that drops the detail two papers
> disagree about has lost the useful part. Say which documents each note covers. If a pass turns
> up nothing worth recording, record nothing.
>
> Cite everything. A claim without a source is worse than a missing claim.
>
> Organise your workspace however serves someone trying to make progress. Use `[[wikilinks]]` so
> the graph is real.

## Capabilities are data

Connect, contradict, and weigh evidence are core. Suggesting research directions is on for now
and switchable off — how much reach the librarian should have is undecided, so it must come off
without touching anything else. Each capability is one line appended to the prompt only when
enabled, so switching one off removes it rather than arguing against it in a longer prompt.
`A09` can only be asserted in that form.

## Scheduling

Roughly twice a day, and more often after a batch of imports. Not event-triggered: the work is
cumulative rather than a reaction to any one document, and a pass is worth making when there is
new material *or* when the last one left threads it did not follow.

## Proposals and disclosure

Nothing an agent produces lands without an explicit accept (`A05`) — a wiki that accumulates
unread machine output is a log, and the accept is where a person decides it is true.

Agents are off until enabled, and enabling first discloses what would be sent (`A03`). With them
off, nothing in the app touches the network. Keep that true, and keep the sentence in `README.md`
that promises it.
