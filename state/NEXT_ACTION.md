# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12). The W-tags are **active** in
`scripts/verify_completion.py`, so the verifier fails until each has a passing tagged test.

Done: **W01–W10**. The graph is finished. The verifier is at 89/92: only `W11`, `W12` and a
dirty tree remain.

Next: **W11** — highlight colours.

1. Six names, stored by name so theming cannot break them: `default`, `tan`, `spruce`,
   `ochre`, `clay`, `signal`. Today `annotation:create`/`update` take a free-form `z.string()`
   and `panels.tsx` writes the hex literal `DEFAULT_HIGHLIGHT_COLOR = '#ffd54f'` — both go.
   Put the enum in `@wr/shared-types` and let the readers map name → CSS variable.
2. The popover also edits the comment and deletes. `annotation:update` already takes
   `color`/`comment`, and `annotation:delete` exists; the UI is what is missing.
3. Integration test: create → recolour through the router → restart → the name is still there.
   Existing highlights carry hex; decide what an unknown stored value renders as and assert it
   rather than leaving it to the reader.

Then W12 (scoped Zotero import, additive across collections).

## Landed this session

- **W09** `tests/e2e/graph.spec.ts`. The activity bar's ◈ runs `openLinkGraph` on the active
  entity; the panel draws SVG nodes (`graph-node-<entityId>`) and edges (`graph-edge-<linkId>`)
  and clicking a node navigates **to the side**, so the graph stays open behind what it opened.
- `panelSubjectKey` keyed `markdown-reader` by kind alone, so every markdown page was "the same
  panel": opening a second one revealed the first instead. Now keyed by document, like the other
  readers. This is also what a wikilink chip hits.
- **W10** `graph:neighbourhood` — seed + depth (≤3) + node cap (≤300), all capped in the
  contract so a renderer cannot widen them. `packages/graph` holds the Cytoscape model
  (`createGraph` / `boundedNeighbourhood` / `layoutPositions`); `GraphRepository` expands the
  frontier in SQL one indexed lookup per node and bounds the result with that same module, so
  "within N hops" means one thing in both processes. Elision is reported (`truncated`,
  `elidedNodes`), never silent.
- `NotImplementedError` is gone from `@wr/workbench` — `openLinkGraph` was its only thrower.
  `[L09]` now asserts an *unknown* command rejects, plus that `openLinkGraph` plans a
  `link-graph` panel.

## Re-importing skips unchanged items — it bit W05, it will bite again

`ZoteroImporter` short-circuits an item whose Zotero `version` is unchanged, and skipping the
item skips **its attachments**, so the bytes are never re-hashed. `import({force:true})` is the
other way in.

## [M05] counts the corpus too — don't "fix" it back

The library sidebar lists the Zotero import **plus** the corpus pages, so `[M05]` asserts
`documents.length + corpusPageCount`.

## The verifier's e2e gate was broken — don't reintroduce it

`pnpm test:e2e -- --reporter=json` forwards the literal `--` to Playwright, which demotes
`--reporter=json` to a positional file filter. The verifier calls it with no separator and
points `PLAYWRIGHT_JSON_OUTPUT_NAME` at `logs/verify/playwright.json`, unlinking it first.

`check_state` still requires `phase == "milestone-1-complete"`; the `milestone` field tracks
milestone 2. Flip the phase (and widen that check to accept both) only when W01–W12 are green.

## Toolchain — read before diagnosing database failures

Node pinned to 20.19.3 in `.nvmrc`, pnpm 9.15.4 via corepack. Homebrew's node 26 (ABI 147) and
pnpm 11 **break the build**. ~93 failing database tests means the ABI, not the code. Shells
here need `source ~/.nvm/nvm.sh && nvm use` first.

## Don't

Rebuild the e2e harness. Weaken the verifier. Widen milestone-2 criteria to the rest of
SPEC.md. Show an Electron window in automated runs. Let the renderer send or receive a
filesystem path.
