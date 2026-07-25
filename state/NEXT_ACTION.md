# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12). The W-tags are **active** in
`scripts/verify_completion.py`, so the verifier fails until each has a passing tagged test.

Done: **W01**, **W06**, **W07**, **W08**.

Next: **W02** — a markdown selection becomes a highlight that survives restart.

1. `createMarkdownAnchorFromSelection` and `resolveMarkdownAnchor` already exist
   (`packages/markdown-reader/src/anchoring.ts`, `@wr/document-model`). The panel already
   creates highlights; what has no test is that the anchor *re-resolves* after a restart.
2. W02 is tagged **integration** in `docs/MILESTONE2.md`, so it belongs in `tests/integration/`
   over a real database and a real corpus file on disk — not in the e2e suite.
3. The interesting case is the one the anchor design exists for: the markdown file is edited
   outside the app between the two runs, text shifts, and the quote still resolves.

Then W03–W05 (saved pages), W09–W10 (graph), W11 (six colours), W12 (scoped Zotero import).

## Landed this session

- `packages/markdown-reader`: mdast → React, never `dangerouslySetInnerHTML`; raw HTML renders
  as visible text. Wikilink chips carry `data-wanted`. Source fetched over `rrfile://`.
- Panel kind `markdown-reader` through `layout.ts`, `readerDescriptorFor`, `titleFor`,
  `DOCKVIEW_COMPONENTS`. `isReaderPanel(descriptor)` narrows the descriptor — `isReaderPanelKind`
  only narrows the *kind*, which does not typecheck at the use sites.
- Main scans the corpus once at startup (`index.ts`, after `createWindow`) and publishes
  `library:changed`; the renderer builds `wikilinkTargets` from the library list's slugs.
- e2e workspace seeds a real `.md` wiki and passes `WR_MARKDOWN_ROOT`; the app imports it with
  the real `MarkdownCorpusImporter`, so no row is hand-inserted.

## [M05] counts the corpus too — don't "fix" it back

The library sidebar now lists the Zotero import **plus** the corpus pages, so `[M05]` asserts
`documents.length + corpusPageCount`. Reverting that to the Zotero count alone will fail.

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
