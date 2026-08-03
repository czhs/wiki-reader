# Milestone 8 — Typst in the notebook, and the shell settles down

The researcher's feedback of 2026-08-03. The notebook's source language becomes Typst — the
paper is drafted in the tool papers are set in — and a batch of things found by use get fixed
for real.

## Rules

- **Typst is vendored.** The compiler runs local (WASM or native), no CDN, no network at
  compile time. Typst source is the researcher's ground truth like markdown was.
- **Nothing already written is lost.** Existing notebook bodies are markdown; decide the
  migration (convert, or render legacy read-only) and write the decision down.
- **The anchoring pipeline is markdown's** (`INLINE_CONSTRUCT_RE`, projection, folding).
  Notebook Typst needs its own answer; markdown documents elsewhere keep theirs — `M02`/`H02`
  and the corpus reader must not regress.
- **Supersessions.** The journal margin's Commands and Advances sections retire (the researcher
  does not want them); their tags' data-level promises (`J03`'s advances edge) may stay at the
  repository level — UI assertions move or go. Side-panel opens retire per `U15`; `U04`'s
  sidebar-replacement promise re-anchors on whatever chrome remains.
- Everything else in `docs/SPEC.md` is still later.

## Criteria

### The notebook speaks Typst

| Tag | Criterion | Kind |
|-----|-----------|------|
| S04 | A notebook is written in Typst and rendered by a local compiler; nothing already written is lost | E2E |
| S05 | A global header defines commands for every notebook; a local header adds this notebook's own | E2E |
| S06 | Images: block insertion stays, and Typst embedding also works | E2E |
| S07 | Live render sits beside a full-width tab, beneath a full-height one (setting: top/off), and hides otherwise | E2E |
| S08 | +text, +code, +image, +excerpt have shortcuts; each inserts after the active block, else at the end | E2E |
| S09 | A highlight drags from a reader into a notebook in another split, landing as an excerpt block | E2E |

### Found by using it

| Tag | Criterion | Kind |
|-----|-----------|------|
| U13 | Tabs stay inside the page at every window and panel size — nothing renders off it | E2E |
| U14 | There is one kind of minimize — the library button's — everywhere | E2E |
| U15 | What next, and everything else, opens as a tab, not a side panel | E2E |
| H11 | A highlight appears on the saved page the moment it is made — on the page, not a side collection | E2E |
| P13 | The journal margin has no Commands and no Advances section | E2E |

## The ones that hide a bug

`S04` — the block editor stays; the *language* changes. Blocks remain a view over one source
document. The excerpt block, wikilinks and `annotation://` chips must survive the language —
decide their Typst spelling once, in `@wr/document-model`.

`S07` — the placement rule is the panel's aspect: full-horizontal → right, full-vertical →
beneath (setting: top/off), neither → no render. Compile off the UI thread; a slow compile must
never hold a keystroke.

`U13` — the second tab report. `U12` fixed the title-bar band; something still escapes the
page. Drive the app at many sizes and find what overflows before fixing.

`H11` — `H10` marks the snapshot at serve time, which paints on *load*. A highlight made while
reading must appear without the researcher reloading anything, and the chips list beside the
page is not the answer to anything the researcher asked.

`U15` — the panel kinds already exist as tabs' content; this is where they open, not what they
are. The activity bar becomes a launcher of tabs.
