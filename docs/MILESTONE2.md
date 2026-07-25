# Milestone 2 — read, annotate, see connections

Milestone 1 already gives you the Electron shell, Dockview panes, the PDF reader, highlights,
notes, typed links, search, and Zotero import.

Build only these.

1. **Markdown documents** — the wiki is markdown; the app can't open it.
2. **Saved web pages** — `packages/html-reader` is a 19-line stub that throws.
3. **The graph** — links exist in the database but there's no way to see them.
4. **Two loose ends** that separate a demo from a daily driver: highlight colours are a
   free-form `z.string()` with no presets and no popover, and Zotero import pulls the whole
   library instead of the collection you're working from.

## Prerequisite

Finish milestone 1 first. Five E2E criteria remain (`M06`, `M07`, `M11`, `L02`, `L08`);
`state/NEXT_ACTION.md` has each failure with its line number.

## Rules

- **Show documents in their original form.** A PDF renders as the PDF, a saved page as the
  saved page with its images and CSS. Extracted text is for search and anchoring only — never
  the reading view, never a silent fallback when rendering fails. Fail loudly instead.
- **Parse markdown from the AST, not a regex.** `[[link]]` inside a code fence is code, and a
  `#` in a URL is not a tag. A wrong edge is worse than a missing one — it looks like a finding.
- Use `remark-parse` + `unist-util-visit` + `github-slugger`, matching Foam, so the corpus
  stays readable in Foam and Obsidian.
- Use **Cytoscape.js** (MIT, zero deps) for the graph. Its model runs headless in Node, so the
  same traversal code serves main-process queries and the rendered view.
- Everything else in `docs/SPEC.md` — the librarian, the bulletin board, the corpus/ground-truth
  model, scoped ingestion — is **later**. Don't build it.

## Criteria

Tagged like milestone 1: `it('[W01] opens a markdown document', …)`.

| Tag | Criterion | Kind |
|-----|-----------|------|
| W01 | A markdown document opens in a tab and renders | E2E |
| W02 | A markdown selection becomes a highlight that survives restart | integration |
| W03 | A saved web page renders as the original, loading its own images and CSS | E2E |
| W04 | `rrfile://` serves a snapshot's resources; refuses paths outside it and remote origins | integration |
| W05 | A web-snapshot highlight survives restart | integration |
| W06 | `[[slug]]` parses from the AST and resolves to a document; code fences are ignored | unit |
| W07 | Re-indexing replaces derived links and preserves manually created ones | integration |
| W08 | An unresolved `[[slug]]` is listed as a wanted page, not an error | unit |
| W09 | The graph renders nodes and edges, and clicking a node opens that document | E2E |
| W10 | Graph queries run in the main process; the renderer never receives the full graph | integration |
| W11 | A highlight's colour is one of six presets, changed from its popover, and survives restart | integration |
| W12 | Zotero import is scoped to a named collection, and importing another adds to it | integration |

`W11`: colours are `default`, `tan`, `spruce`, `ochre`, `clay`, `signal` — stored by name, never
as hex, so theming can't break them. The popover also edits the comment and deletes.

`W12`: importing a second collection must be additive, not a replace.

Build in order. W07 is the one that hides a bug: deleting links by `source_id` destroys manual
links and still passes a test that only checks wikilinks work — assert a manual link survives.

## Activating these

The tags are inert. `scripts/verify_completion.py` hardcodes `UNIT_TAGS` / `E2E_TAGS` and
doesn't read this file. Add `W02`, `W04`–`W08`, `W10`–`W12` to `UNIT_TAGS` and `W01`, `W03`, `W09` to `E2E_TAGS`
when milestone 1 is complete and pushed.
