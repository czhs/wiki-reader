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
> Cite everything. A claim without a source is worse than a missing claim.
>
> Organise your workspace however serves someone trying to make progress. Use `[[wikilinks]]`
> so the graph is real.

The capabilities are appended to that, one line each, and only the enabled ones (`A09`):

> Where the material points somewhere worth going next, say so.

## Capabilities are data, not prose

The librarian's remit is a set — connect, contradict, evidence, and for now suggest-directions
— and each is a line appended to the prompt only when it is on. How much reach the librarian
should have is an open question, so switching one off has to *remove* it rather than argue
against it in a longer prompt. That is also the only version a test can check, which is what
`A09` asserts.

Connecting, contradicting and weighing evidence are the core and are not expected to move.
Suggesting directions is the one under review.

## Why they are proposals

The librarian never writes into the wiki directly; it produces proposals a person accepts or
rejects (`A05`). This is not distrust of the model so much as the thing that keeps the wiki
worth having — a wiki that accumulates unread machine output stops being a wiki and becomes a
log. The accept step is where a person decides it is true.

## Disclosure

Agents are off until switched on, and switching them on says what leaves the machine first
(`A03`). With them off, nothing in the app touches the network. Keep that true, and keep the
sentence in `README.md` that promises it.
