# Milestone 6 — a paper-grade notebook, reading that flows in, a guide that shows

The researcher's decisions on `reports/DESIGN_GAPS.md` set this milestone; read the
`Descision:` lines there before building — they are the spec's voice. The center: the journal
is tweets to oneself; **the notebook does the heavy lifting** — a full publishable scientific
paper must be writable in it.

## Rules

- **Whatever the librarian can do with links, the researcher can do by hand.**
- **The guide is maintained.** From this milestone on, a feature is not done until the guide
  shows it. The guide enumerates from the registries (like help), never a hand-written list.
- **Layout may assume at most two panels side by side**, plus perhaps one along the bottom —
  the researcher's stated usage. Design for that, not for arbitrary tiling.
- **Local-first still holds.** Math and motion render from vendored code, never a CDN.
- Gaps without a decision (1, 4–7, 13) stay proposals; improvement passes may take the small
  ones as clarity work. Everything else in `docs/SPEC.md` is still later.

## Criteria

### The notebook writes the paper

| Tag | Criterion | Kind |
|-----|-----------|------|
| S01 | A notebook page is written in blocks like a journal day — one writing surface, and the page takes the room | E2E |
| S02 | LaTeX math renders in notebook blocks, inline and display | E2E |
| S03 | A highlight is inserted into a notebook as a quoted excerpt that keeps its link to the source | E2E |

### Reading flows in

| Tag | Criterion | Kind |
|-----|-----------|------|
| E01 | "Send to a notebook" sits beside link and note in the reader, takes a highlight or a file, and lands on that notebook's desk | E2E |
| E02 | A hypothesis is a link target: the researcher attaches supporting or opposing evidence by hand | E2E |
| E03 | The ledger lists every highlight of the file, linked or not | integration |

### Seen and found

| Tag | Criterion | Kind |
|-----|-----------|------|
| V01 | A highlight on the wiki carries a snippet of its text, told apart from a file at a glance | E2E |
| V02 | The graph is searched in place: a filter dims what does not match and pans to what does | E2E |
| V03 | The journal's calendar renders every day, none elided | E2E |
| V04 | A saved page stays readable at half-screen width: the researcher holds a zoom or width lever | E2E |

### Ideas live and die differently

| Tag | Criterion | Kind |
|-----|-----------|------|
| I01 | Discarding a notebook sets it aside and it comes back; deleting is a distinct, confirmed act, and gone | E2E |

### The right hand

| Tag | Criterion | Kind |
|-----|-----------|------|
| R01 | Right-clicking a thing offers the actions that make sense there — a library row, a tab, a graph node, a highlight, a notebook, a block | E2E |

### The guide

| Tag | Criterion | Kind |
|-----|-----------|------|
| O01 | A guide page covers every feature the registries know, showing how to use it — with motion where showing beats telling | E2E |

## The ones that hide a bug

`S01`–`S03` — the block editor exists (the journal's day); the work is promotion, not
invention. LaTeX needs a vendored renderer. The excerpt insert already has a Tiptap node
(`EmbeddedExcerpt` in @wr/note-editor) that nothing surfaces.

`E02` — the vocabulary (`…-supports-hypothesis`) and both reader lines (*For* / *Against*)
already exist; only the picker cannot see a hypothesis. Fix the seeing, not the vocabulary.

`I01` — "discarded" exists as a status today; delete does not. Deletion is the destructive
act: confirm it, and decide (and say in the test) what happens to the journal, links and desk
of a deleted notebook.

`O01` — the guide is not the help page. Help says what keys do; the guide shows what the app
does. Coverage is asserted against the registries so it can never silently rot.

`R01` — a menu is the command registry read contextually, never a second list of actions; what
a menu offers, help and the guide already know. The archive frame's context-menu path already
carries `H01`'s selection transport — compose with it, don't collide.
