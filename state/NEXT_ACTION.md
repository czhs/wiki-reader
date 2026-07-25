# Next action

## What is happening now

Every criterion that a Vitest test can honestly prove is **verified** (26 of 34). The only
work left in milestone 1 is the Playwright end-to-end suite: 8 criteria that require a real
Electron process. The harness exists; the spec files do not.

## What was last verified

- `pnpm test` — 330 tests, 22 files, all passing.
- `pnpm typecheck`, `pnpm lint` — clean (0 errors, 0 warnings, 0 `any`).
- `python3 scripts/verify_completion.py` — **61/72 checks pass**. All security, IPC-router,
  renderer-isolation, docs, and git checks pass. HEAD `6ef509f` is pushed to `origin/main`.
- Remaining failures are exactly: the 8 E2E criteria, `tests: e2e produced results`,
  `state: phase`, and `git: working tree clean`.

## Next exact action

Write the spec files under `tests/e2e/`. The harness is already built and is not the problem:

- `playwright.config.ts` — 1 worker, 180s timeout, `globalSetup` runs `pnpm build`.
- `support/workspace.ts` — `createWorkspace()` seeds a temp dir by running the **real**
  `ZoteroImporter` over recorded fixtures, returns `documents` / `pdfDocuments` / `noteId`.
- Point Electron at it with env `WR_DATABASE_PATH` and `WR_ZOTERO_DATA_DIR`.

Selectors that already exist: `app-shell`, `activity-bar`, `dockview-container`,
`library-sidebar`, `library-item-<documentId>`, `pdf-reader` (`data-document-id`),
`pdf-page-count`, `pdf-scroll`, `pdf-page-<i>`, `pdf-highlight-<id>`, `selection-toolbar`,
`create-highlight`, `bottom-panel`, `reference-row-<i>`, `peek-overlay`, `status-bar`.

Mechanics worth knowing: a highlight needs a real DOM selection inside
`.wr-pdf-page__text-layer` followed by `mouseup` on `pdf-scroll`; Cmd/Ctrl-click a
`ListRow` opens to the side (M07); F12 maps to `goToTarget` only when `linkUnderCursor` is
set, which the note editor sets on link hover (L02).

## Command a fresh session should run

```bash
python3 scripts/verify_completion.py --fast 2>&1 | tail -20
pnpm test:e2e 2>&1 | tail -30
```

## What must not be repeated

- Do not rebuild the e2e harness, the skeleton, `docs/SPEC.md`, or the verifier.
- Do not re-run `corepack prepare`; pnpm is already active.
- Do not weaken the verifier. Do not mark an E2E criterion verified without a passing spec.
