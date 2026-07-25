# Next action

## What is happening now

Milestone 1 is **five E2E criteria** from complete: `M06`, `M07`, `M11`, `L02`, `L08`.
`tests/e2e/shell.spec.ts` is done and passing (5 specs, covering `M01`, `M02`, `M05`).
`tests/e2e/reader.spec.ts` is in progress and targets M06/M07/M11.

**`docs/SPEC.md` was amended on 2026-07-25** to merge Field Station's wiki-reader brief:
markdown documents, the wiki corpus, `[[wikilinks]]`, the librarian and reviewer agents, the
bulletin board, the graph view. See `state/DECISIONS.md`. The milestone-1 criteria do **not**
cover that scope — a green verifier proves the slice works, not that SPEC.md is implemented.

**Milestone 2 is fully planned in `docs/MILESTONE2.md`**: 30 criteria (`W01`–`W30`) in seven
phases, build order, the write-mediator design, and how agents are tested without a live
model. Those tags are inert until deliberately added to the verifier. **Do not start
milestone 2 while any milestone-1 criterion is red.**

## What was last verified

- `pnpm test` 330 passing; `pnpm typecheck` and `pnpm lint` both exit 0.
- `tests/e2e/shell.spec.ts` — 5 specs passing in a real Electron build.
- Electron E2E runs in background mode (`WR_BACKGROUND=1`): the window is never shown and
  never takes focus. Verified across 5 launches.
- Verifier was 61/72 before this session; the lint blocker and the audit gate have changed
  since, so re-run it rather than trusting that number.

## Next exact action

Finish the five remaining criteria in `tests/e2e/`. The harness is built and is not the
problem — `support/workspace.ts` seeds a temp dir by running the **real** `ZoteroImporter`
over recorded fixtures and returns `documents` / `pdfDocuments` / `noteId`.

`reader.spec.ts` currently runs **6 passed, 3 failed**. Start from these three, in order:

1. `reader.spec.ts:51` (M06) — `page.evaluate` throws
   `TypeError: Cannot read properties of undefined (reading 'files')`. Something the spec
   reads off the exposed object is not there; check the shape actually returned before
   asserting on it.
2. `reader.spec.ts:86` (M06) — page-count mismatch: the `"N pages"` label says 3 but
   `[data-testid^="pdf-page-"]` resolves to 4 elements, stably. Either the reader renders an
   extra page node (spacer / overscan placeholder) that should not carry that testid, or the
   label is under-counting. Decide which side is wrong before changing the assertion —
   loosening it to `toBeGreaterThan` would hide a real rendering bug.
3. `reader.spec.ts:124` (M11) — the selection does not become a painted, stored highlight.

Note the verifier reports **all** E2E criteria as failing whenever the Playwright run exits
non-zero, including `M01`/`M02`/`M05`, which do pass on their own
(`pnpm test:e2e tests/e2e/shell.spec.ts` → 5 passed). Fixing the three failures above should
restore all eight at once.

Selectors that already exist: `app-shell`, `activity-bar`, `dockview-container`,
`library-sidebar`, `library-item-<documentId>`, `pdf-reader` (`data-document-id`),
`pdf-page-count`, `pdf-scroll`, `pdf-page-<i>`, `pdf-highlight-<id>`, `selection-toolbar`,
`create-highlight`, `bottom-panel`, `reference-row-<i>`, `peek-overlay`, `status-bar`.

Mechanics worth knowing: a highlight needs a real DOM selection inside
`.wr-pdf-page__text-layer` followed by `mouseup` on `pdf-scroll`; Cmd/Ctrl-click a `ListRow`
opens to the side (M07); F12 maps to `goToTarget` only when `linkUnderCursor` is set, which
the note editor sets on link hover (L02).

## Command a fresh session should run

```bash
python3 scripts/verify_completion.py --fast 2>&1 | tail -20
pnpm test:e2e 2>&1 | tail -30
```

## What must not be repeated

- Do not rebuild the e2e harness, the skeleton, `docs/SPEC.md`, or the verifier.
- Do not re-run `corepack prepare`; pnpm is already active.
- Do not weaken the verifier. Its audit gate now requires an `Audited-commit:` line naming a
  real ancestor of HEAD, a `## Findings` section, and no placeholder text.
- Do not widen the milestone-1 criteria to cover the merged SPEC scope, and do not narrow
  SPEC.md to match the criteria. Milestone-2 criteria are a deliberate, separate act.
- Do not show an Electron window in automated runs. Background mode is mandatory.
