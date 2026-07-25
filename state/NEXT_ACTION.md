# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12). The W-tags are **active** in
`scripts/verify_completion.py`, so the verifier fails until each has a passing tagged test.

Done: **W01–W08, W10**.

Next: **W09** — the E2E half of the graph. The main-process query, the panel, the command and
the activity-bar button are all written and typechecked; what is missing is
`tests/e2e/graph.spec.ts`.

1. Open a corpus markdown page (`workspace.corpusPage.slug`, i.e. `spaced-repetition`), then
   click `[data-testid="activity-graph"]`. That runs `COMMAND_IDS.openLinkGraph` on the active
   entity, which opens the `link-graph` panel to the **side**.
2. Assert nodes and edges: `[data-testid="graph-panel"]` carries `data-node-count` /
   `data-edge-count`; each node is `[data-testid="graph-node-<entityId>"]`, each edge
   `graph-edge-<linkId>`. The corpus import derives the `spaced-repetition → forgetting-curve`
   wikilink edge, so both documents are nodes at distance 0 and 1.
3. Click the `forgetting-curve` node → a `markdown-reader` panel for that document opens
   (`workbench.navigate`, mode `current`). Assert the reader is visible with that document id.
4. Nodes are SVG `<g role="button">`, so Playwright clicks them directly — no canvas maths.

Then W11 (six colours: `default`, `tan`, `spruce`, `ochre`, `clay`, `signal`, stored by name,
edited from a popover that also edits the comment and deletes) and W12 (scoped Zotero import,
additive across collections).

## Landed this session

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
