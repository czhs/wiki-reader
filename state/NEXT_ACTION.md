# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12). The W-tags are **active** in
`scripts/verify_completion.py`, so the verifier fails until each has a passing tagged test.

Done: **W01**, **W02**, **W04**, **W06**, **W07**, **W08**.

Next: **W03** then **W05** — saved web pages.

1. W03 is **E2E**: `packages/html-reader` is still the milestone-1 stub that throws. A saved
   page must render *as the original*, loading its own images and CSS from the snapshot —
   never extracted text as a fallback. Fail loudly instead.
2. The transport W03 needs already exists and is tested: `rrfile://<file-id>/assets/style.css`
   serves a resource beside the entry page (W04). The reader can point a sandboxed iframe at
   the entry page's `rrfile://` URL and let relative URLs resolve themselves.
3. W05 mirrors W02 for an HTML anchor. `tests/integration/markdown-highlight.test.ts` is the
   shape to copy — close and reopen the database, rebuild the anchor from disk.
4. Archived HTML is hostile input: sandboxed iframe, scripts off, restrictive CSP, navigation
   blocked. The e2e workspace already materializes a small archived page per HTML attachment.

Then W09–W10 (graph), W11 (six colours), W12 (scoped Zotero import).

## W04 landed — the shape of the widening

`parseFileRequest` replaces `parseFileId` internally and returns `{fileId, resourcePath}`.
`parseFileId` is kept and still returns null for any path within, so single-file callers can't
silently start accepting one. Three boundaries hold, each tested next to what it permits:

- only a `text/html` row has resources at all (a PDF row is not a handle on its directory);
- a resource resolves inside its own snapshot **lexically and again after symlinks** — the
  allowed roots are the whole library and would happily serve a sibling item;
- `blocksRemoteRequest` cancels what archived markup fetches on its own (tracking pixels).

## [M05] counts the corpus too — don't "fix" it back

The library sidebar lists the Zotero import **plus** the corpus pages, so `[M05]` asserts
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
