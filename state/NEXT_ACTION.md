# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12). The W-tags are **active** in
`scripts/verify_completion.py`, so the verifier fails until each has a passing tagged test.

Done: **W01–W08**. Saved web pages and markdown are both finished.

Next: **W09** and **W10** — the graph.

1. W10 is **integration**: graph queries run in the main process and the renderer never
   receives the full graph. So the IPC returns a *neighbourhood* (a seed plus a bounded
   radius/limit), never `links.list({})`. Assert on what crosses the boundary, not just on
   what renders — that is the criterion's whole point.
2. W09 is **E2E**: nodes and edges render, and clicking a node opens that document. Use
   **Cytoscape.js** (MIT, zero deps); its model runs headless in Node, so the same traversal
   code serves the main-process query and the view.
3. Edges come from `links` — all typed, directed, already written by the note editor
   (`mentions`) and the corpus importer (derived wikilinks, `generator`-scoped).
4. Panels never talk to each other: opening a document from the graph goes through the
   command registry / `workbench.navigate`, as the markdown wikilink chips do.

Then W11 (six colours: `default`, `tan`, `spruce`, `ochre`, `clay`, `signal`, stored by name,
edited from a popover that also edits the comment and deletes) and W12 (scoped Zotero import,
additive across collections).

## Landed this session

- **W04** `rrfile://<file-id>/assets/style.css` serves a resource beside the entry page.
  Bounded three ways: only a `text/html` row has resources; the target must stay inside the
  snapshot lexically *and* after symlinks; `blocksRemoteRequest` cancels what the markup fetches.
- **W03** `packages/html-reader` frames the snapshot from its own `rrfile://` origin, so
  relative URLs resolve themselves. `sandbox` with no tokens; `snapshotSecurityHeaders` serves
  `default-src 'none'` with the bytes. Its allowances name the `rrfile:` **scheme**, not
  `'self'` — a sandboxed frame's origin is opaque and `'self'` matches nothing, its own
  stylesheet included. Renderer CSP now has `frame-src rrfile:`.
- **W05** `html-anchor.ts` mirrors `markdown-anchor.ts`. A `readerMode` mismatch resolves to
  `null` rather than being attempted.

## Re-importing skips unchanged items — it bit W05, it will bite again

`ZoteroImporter` short-circuits an item whose Zotero `version` is unchanged, and skipping the
item skips **its attachments**, so the bytes are never re-hashed. A test that rewrites a file
and re-imports without bumping the version asserts against a stale row. `import({force:true})`
is the other way in.

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
