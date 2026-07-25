# Next action

## Now

**Milestone 1 is complete.** `scripts/verify_completion.py` exits 0 at 80/80, `reports/AUDIT.md`
has no open critical or major finding, the tree is clean and HEAD is on `origin/main`.

Start milestone 2: `docs/MILESTONE2.md`, twelve criteria `W01`–`W12` — markdown, saved web pages in
their original form, `[[wikilinks]]`, the graph. Nothing else from `docs/SPEC.md`.

First step: activate the tags in `scripts/verify_completion.py` — add `W02`, `W04`–`W08`, `W10`–`W12`
to `UNIT_TAGS` and `W01`, `W03`, `W09` to `E2E_TAGS`. They will fail until each criterion has a
passing tagged test, which is the point.

`extractHtmlText` in `@wr/document-model` already exists (written for T05) and is what the
saved-page reader should feed the indexer and the anchor resolver. It produces text only and
tracks no element nesting, so it cannot decide what is safe to *render* — that is the sandboxed
iframe's job, and `packages/html-reader` is still a stub that throws.

## What the audit left open (minor, none blocking)

Recorded in `reports/AUDIT.md` and in the gaps list of `docs/SECURITY.md`:

- Five IPC request fields are `z.unknown()`; `link:create` ids and types are unconstrained
  strings even though typed id schemas exist. Worth closing when the graph starts minting edges.
- A TOCTOU window between `realpath` and `open` in `rrfile://`.
- `[M04]` never reaches the real `hashFileOnDisk` probe; nothing joins the `[M14]` store
  round-trip to the renderer's serializer.

## The verifier's e2e gate was broken — don't reintroduce it

`pnpm test:e2e -- --reporter=json` forwards the literal `--` to Playwright, whose parser treats
it as end-of-options and demotes `--reporter=json` to a positional *file filter*. The verifier
calls `pnpm test:e2e --reporter=json` (no separator) with `PLAYWRIGHT_JSON_OUTPUT_NAME` pointed
at `logs/verify/playwright.json`, unlinking it first so a stale report cannot outlive a failing
run.

## Toolchain — read before diagnosing database failures

Node pinned to 20.19.3 in `.nvmrc`, pnpm 9.15.4 via corepack. Homebrew's node 26 (ABI 147) and
pnpm 11 **break the build** — better-sqlite3 11.10.0 has no prebuild for ABI 147. That looks
like ~93 failing database tests. **It is not a code bug.** `loop.sh` aborts before iteration 1.

## Useful

Selectors: `app-shell`, `activity-bar`, `dockview-container`, `library-sidebar`,
`library-item-<documentId>`, `pdf-reader`, `pdf-total-pages`, `pdf-scroll`, `pdf-page-<i>`,
`pdf-highlight-<id>`, `selection-toolbar`, `create-highlight`, `annotations-sidebar`,
`bottom-panel`, `close-bottom-panel`, `reference-row-<i>`, `peek-overlay`, `status-bar`.

`rr.invoke` returns the raw `IpcResult` envelope — unwrap it in `page.evaluate`. To read the
app's database from a spec, use `openDatabase({ file, readonly: true, migrate: false })` in the
Playwright process; `electronApplication.evaluate` has no module scope.

## Don't

Rebuild the e2e harness. Re-run `corepack prepare`. Weaken the verifier. Widen milestone-2
criteria to cover the rest of SPEC.md. Show an Electron window in automated runs.
