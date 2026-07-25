# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12). The W-tags are **active** in
`scripts/verify_completion.py`, so the verifier fails until each has a passing tagged test.

Done: **W01**, **W02**, **W06**, **W07**, **W08**.

Next: **W03–W05** — saved web pages.

1. `packages/html-reader` is still the milestone-1 stub. W03 is **E2E**: a saved page renders
   as the original, loading its own images and CSS from the snapshot.
2. W04 is **integration** on `rrfile://`: it serves a snapshot's resources and refuses both
   paths outside that snapshot and remote origins. `apps/desktop/src/main/protocol.ts` already
   has the allow-list; what W04 needs is the snapshot-scoped case and its refusals.
3. W05 mirrors W02 for an HTML anchor. `tests/integration/markdown-highlight.test.ts` is the
   shape to copy — close and reopen the database, rebuild the anchor from disk.
4. Archived HTML is hostile input: sandboxed iframe, scripts off, restrictive CSP, navigation
   blocked. The e2e workspace already materializes a small archived page per HTML attachment.

Then W09–W10 (graph), W11 (six colours), W12 (scoped Zotero import).

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
