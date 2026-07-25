# Next action

## Now

Every milestone-1 criterion is green — 330 unit tests, 11 E2E specs, all 34 tags matched by the
verifier. `scripts/verify_completion.py` is at **72/77**. Five checks remain, and three of them
are the audit:

1. **The audit.** `reports/AUDIT.md` is still the shipped placeholder. It needs an
   `Audited-commit: <sha>` line naming an ancestor of HEAD, a `## Findings` section, no
   placeholder wording, and no unresolved critical/major findings. Brief: `docs/LOOP.md:15`.
   Resolve any real finding *before* writing the report — a report listing an unresolved major
   finding blocks completion, correctly.
2. **`state/experiment_state.json` phase** → `milestone-1-complete` (currently `audit`). Flip it
   only once the audit is clean.
3. **Clean tree + push.**

Then milestone 2: `docs/MILESTONE2.md`, ten criteria `W01`–`W10` — markdown, saved web pages in
original form, `[[wikilinks]]`, the graph. Nothing else from SPEC.md. Activate the tags by
adding `W02`,`W04`–`W08`,`W10` to `UNIT_TAGS` and `W01`,`W03`,`W09` to `E2E_TAGS`.

## The verifier's e2e gate was broken — don't reintroduce it

`pnpm test:e2e -- --reporter=json` forwards the literal `--` to Playwright, whose parser treats
it as end-of-options and demotes `--reporter=json` to a positional *file filter*. The config's
`list` reporter stayed in effect, no JSON was written, and `tests: e2e produced results` failed
every run — while the suite itself was passing 11/11. The verifier now calls
`pnpm test:e2e --reporter=json` (no separator) with `PLAYWRIGHT_JSON_OUTPUT_NAME` pointed at
`logs/verify/playwright.json`, unlinking it first so a stale report can't outlive a failing run.

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

Rebuild the e2e harness. Re-run `corepack prepare`. Weaken the verifier. Widen milestone-1
criteria to cover SPEC.md. Show an Electron window in automated runs.
