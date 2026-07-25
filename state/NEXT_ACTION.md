# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12) is in progress. The W-tags are **active** in
`scripts/verify_completion.py`, so the verifier fails until each has a passing tagged test.

Done so far: **W06**, **W08** (`packages/document-model/src/markdown.test.ts`).

Next: **W01** — a markdown document opens in a tab and renders.

1. `packages/markdown-reader` (new): renders the mdast to React. Never `dangerouslySetInnerHTML`.
   The renderer fetches the source over `rrfile://<fileId>` — bytes still reach it only that way.
2. Panel kind `markdown-reader` in `packages/workbench/src/layout.ts`, `readerDescriptorFor`,
   `titleFor` in `apps/desktop/src/renderer/host.ts`, `DOCKVIEW_COMPONENTS` in `panels.tsx`.
3. Corpus ingestion, main-side: the markdown root comes from `WR_MARKDOWN_ROOT` or
   `<userData>/corpus`, never from the renderer, and joins `services.allowed` roots. The e2e
   workspace seeds through the same importer so the rows are real.
4. e2e spec `tests/e2e/markdown.spec.ts` tagged `[W01]`.

Then W02 (markdown highlight survives restart), W03–W05 (saved pages), W07 (re-index replaces
derived links, keeps manual), W09–W10 (graph), W11 (six colours), W12 (scoped Zotero import).

## Landed this session

- `documents.slug`, `wanted_pages`, and widened CHECKs in migration `002_markdown`.
- `markdown` added to `DocumentType`, `DocumentLocation`, `AnnotationAnchor`, `ReaderSelection`,
  and the chunk kinds; `anchorColumns()` in the annotations repo replaces the two-branch ternary.
- `parseMarkdown` / `resolveWikilinks` / `createMarkdownAnchor` in `@wr/document-model`.

## The verifier's e2e gate was broken — don't reintroduce it

`pnpm test:e2e -- --reporter=json` forwards the literal `--` to Playwright, whose parser treats
it as end-of-options and demotes `--reporter=json` to a positional *file filter*. The verifier
calls `pnpm test:e2e --reporter=json` (no separator) with `PLAYWRIGHT_JSON_OUTPUT_NAME` pointed
at `logs/verify/playwright.json`, unlinking it first.

`check_state` still requires `phase == "milestone-1-complete"`; the `milestone` field tracks
milestone 2. Flip the phase (and widen that check to accept both) only when W01–W12 are green.

## Toolchain — read before diagnosing database failures

Node pinned to 20.19.3 in `.nvmrc`, pnpm 9.15.4 via corepack. Homebrew's node 26 (ABI 147) and
pnpm 11 **break the build**. ~93 failing database tests means the ABI, not the code. Shells here
need `source ~/.nvm/nvm.sh && nvm use` first.

## Don't

Rebuild the e2e harness. Weaken the verifier. Widen milestone-2 criteria to the rest of SPEC.md.
Show an Electron window in automated runs. Let the renderer send or receive a filesystem path.
