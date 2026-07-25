# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12). **W01–W11 are done.** Only **W12** and a clean
pushed tree stand between here and `verify_completion.py` exiting 0.

**W12 — scoped Zotero import, additive across collections.** Today `ZoteroImporter.import()`
walks the whole library: `importCollections` mirrors every collection, then every top-level
item. The criterion wants an import *scoped to a named collection*, and a second import of a
different collection must **add to** the library rather than replace it.

Where to work: `packages/zotero-adapter/src/importer.ts` (scope option + item filter),
`client.ts` (`/collections/<key>/items` exists in the local API — prefer it to filtering the
whole item list), the `zotero:import` channel in `packages/shared-types/src/ipc.ts`, and its
handler. Integration test alongside the existing recorded fixtures in
`packages/zotero-adapter/test/fixtures/` — add a second collection's items rather than
inventing one.

The assertion that makes the criterion real: import collection A, then import collection B,
then assert A's documents are **still there** and B's are present. A test that only checks B
arrived passes on a replace.

## Traps that already cost time

- **Re-import skips unchanged items.** `ZoteroImporter` short-circuits an item whose Zotero
  `version` is unchanged, which skips its attachments, so bytes are never re-hashed.
  `import({force:true})` is the other way in. This bit W05.
- **`[M05]` counts the corpus too.** The sidebar lists the Zotero import *plus* corpus pages,
  so the assertion is `documents.length + corpusPageCount`. Don't "fix" it back.
- **Don't reintroduce the e2e gate bug.** `pnpm test:e2e -- --reporter=json` forwards the
  literal `--`, which demotes the reporter to a positional file filter. The verifier calls it
  with no separator and points `PLAYWRIGHT_JSON_OUTPUT_NAME` at `logs/verify/playwright.json`,
  unlinking it first.
- **`check_state` still requires `phase == "milestone-1-complete"`.** The `milestone` field
  tracks milestone 2. Flip the phase — and widen that check to accept both — only when W01–W12
  are green.
- **Renderer component tests are possible now.** `tests/integration/highlight-color.test.ts`
  runs under `// @vitest-environment jsdom` with `react-dom/client` and `act` from `react`
  (root devDeps). Set `IS_REACT_ACT_ENVIRONMENT = true` or React warns on every render.

## Toolchain — read before diagnosing database failures

Node pinned to 20.19.3 in `.nvmrc`, pnpm 9.15.4 via corepack. Homebrew's node 26 (ABI 147) and
pnpm 11 **break the build**. ~93 failing database tests means the ABI, not the code. Shells
here need `source ~/.nvm/nvm.sh && nvm use` first.

## Don't

Rebuild the e2e harness. Weaken the verifier. Widen milestone-2 criteria to the rest of
SPEC.md. Show an Electron window in automated runs. Let the renderer send or receive a
filesystem path.
