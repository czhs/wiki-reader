# Audit — milestone 5, the notebook lens

Range `7796795..HEAD` (`f934770`). One lens: the notebook, the journal, blocks, images, and the
retirement of "question". The question asked of every `P` test is whether it keeps the promise
its title makes, or is satisfied by a mock, a stub, or a happy path.

Method: read `docs/MILESTONE5.md`, `state/NEXT_ACTION.md`, every `P0*`-tagged test and the code
under it; ran `apps/desktop/src/renderer/journal-blocks.test.ts`,
`journal-calendar.test.ts`, `tests/integration/journal.test.ts`, `notebook.test.ts`,
`questions.test.ts`, `packages/database/test/migrations.test.ts` (57 + 16 passing). The E2E
suite was not run.

## What holds

- **`P02` is the strongest work in the range.** The day is keyed `(notebook_id, date)` at the
  schema (`012_notebook_journals.ts`), the repository has no method that can read or write a day
  without naming its notebook, the link endpoint carries the notebook
  (`journalEntityId`/`parseJournalEntityId`), and the *upgrade* is tested with a real
  migration-011 database carrying a real edge (`migrations.test.ts:254`, `:306`). The
  orphan-journal case adopts rather than deletes. Nothing here is stubbed.
- **`P04` is not satisfied by a mock.** `tests/e2e/support/drop.ts` builds the `File` from a real
  file input so `webUtils.getPathForFile` is genuinely exercised; the drop payload is
  zod-validated in `router.ts:49-69`; the assertion that the bytes arrived is
  `naturalWidth > 0` over `rrfile://`, not the presence of an `<img>` tag; and the inode/size/
  `findByName` checks prove nothing was copied.
- **`P03`'s persistence is real**: `question:update` → column with a `GLOB` check → re-read
  through `journal:loggedDates`, asserted across a services restart *and* across two Electron
  processes.
- No renderer-side filesystem path, no new `ipcMain.handle` outside the router, no weakening of
  `scripts/verify_completion.py` (the only change adds `D01`/`D02`).

## Findings

### 1. `[P01] no surface calls a notebook a question` checks only happy-path screens — the word survives in every error the researcher can be shown *(major)*

`tests/e2e/notebooks.spec.ts:118` reads `innerText` of seven surfaces in their success state. It
never provokes a failure, and failure is where the retired word lives.

- `apps/desktop/src/renderer/ipc.ts:31` — `super(\`${channel}: ${error.message}\`)`. Every
  user-facing message from a `question:*` channel is *prefixed with the channel name*.
- `apps/desktop/src/main/handlers.ts:295, 813, 832, 862, 868, 874, 918, 931, 943` — nine sites
  throw `notFound('question', …)`, whose message is the literal string `question not found`.
- That string is rendered verbatim: `store.setStatus(describeError(failure).message, 'error')`
  → `[data-testid="status-message"]` (`App.tsx:548-552`), and
  `setError(describeError(failure).message)` → `<ErrorState>` on the notebook page
  (`notebook-panel.tsx:133-135`). A researcher opening a notebook whose row is gone reads
  **"question:notebook: question not found"** on the page that milestone 5 renamed.

The retirement was clearly done deliberately elsewhere in the same file — the drop path and the
journal channels say `notFound('notebook', …)` (`handlers.ts:126`, `:181`, `:1001`) — so this is
nine missed call sites, not a decision.

### 2. The directory never re-reads while the app is running *(major)*

`apps/desktop/src/renderer/notebook-directory.tsx:87-99`: `load` is a `useCallback` with an empty
dependency list, run from a single `useEffect`. The component subscribes to nothing — it is the
only panel in the renderer that displays library-derived counts and has no
`subscribe('library:changed' | 'notebook:changed' | 'journal:changed', …)` (compare
`journal-panel.tsx:254`, `notebook-panel.tsx:166`, `ledger-panel.tsx:100`, `wiki-panel.tsx:91`).

Dockview does not remount it. `defaultRenderer` is unset, so panels are `onlyWhenVisible`
(`dockview-core/dist/cjs/dockview/dockviewComponent.js:346`), and `onlyWhenVisible` only
`appendChild`/`removeChild`s the content element
(`.../components/panel/content.js:101-108, 141-145`). React does not unmount a portal whose host
node is detached, so revealing the hidden directory tab re-attaches the same mounted tree and no
effect re-runs.

Consequence: open the directory, open a notebook's journal from its row, write today's entry, go
back to the directory tab — the row still says `Journal — nothing yet, from …`. The same is true
of a notebook created from the "What next" sidebar: it never appears on the shelf.

`tests/e2e/notebooks.spec.ts:90-115` claims "the shelf is re-read rather than remembered", but
the only in-session refresh it observes comes from `add()`'s own explicit `await load()`
(`notebook-directory.tsx:119`), and the genuine re-read it asserts happens in a **second
process**. The promise in the comment is not the promise the code keeps.

### 3. `[P05]`'s gating E2E does not exercise the rendered→source mapping its own comment claims *(minor)*

`tests/e2e/journal.spec.ts:462-464` seeds
`'## Sweep notes\n\nLayer fourteen head three copies the previous occurrence'` and says the
heading "is what makes the rendered text differ from the source, which is the case that gets this
wrong quietly". But `parseBlocks` splits that into two blocks, and the test clicks
`journal-block-1` (line 470) — the bare paragraph, whose rendered text is character-for-character
its markdown source. `sourceOffsetFor` is therefore the identity function for the whole of this
test; the assertion proves `caretRangeFromPoint` works, not the mapping.

The mapping *is* covered, but only by the pure unit test at
`apps/desktop/src/renderer/journal-blocks.test.ts:121`. `P05` appears in `E2E_TAGS`
(`scripts/verify_completion.py:155`) and not in the unit table, so the criterion is gated on the
test that does not test it. Clicking `journal-block-0` (the heading) instead, and asserting
`selectionStart` lands after the `## `, would close this in two lines.

### 4. A dropped picture silently discards block text held only in component state *(minor)*

`apps/desktop/src/renderer/journal-panel.tsx:253-264` reloads the day on `journal:changed`
without regard to whether an editor is open; `loadDay` (`:210-218`) then does
`setRows(toRows(parseBlocks(found?.markdown ?? '')))` and `setEditing(null)`.

Block text lives in `rows` from the first keystroke (`onChange`, `:455-462`) and reaches the
database only on blur (`onBlur={() => void commit()}`, `:463`). Meanwhile `receivePictures`
(`handlers.ts:129-138`) appends the image to `db.journal.get(...)?.markdown` — the *stored*
document, which does not contain the unsaved text. If the textarea has not blurred when the drop
lands, the reload replaces the researcher's typed paragraph with the stored day plus the figure,
with no warning. Whether the blur has fired depends on platform focus behaviour during a
cross-application drag, which is exactly the kind of thing that should not decide whether writing
survives. The guard at `:256` already checks the date; it should also refuse to clobber an open
editor (or `commit()` first).

### 5. `JournalRepository.count()` is dead, and its comment claims it is the directory's count *(minor)*

`packages/database/src/repositories/journal.ts:116-122` documents `count()` as "How many days a
notebook has logged. The directory's count (`P01`)". Nothing calls it — the directory handler
uses `db.journal.loggedDates(notebook.id).length` (`apps/desktop/src/main/handlers.ts:906-910`),
and `loggedDates` delegates to `list()`, which is `SELECT * FROM journal_entries` (`:78-80`).
Opening the directory therefore materialises the **full markdown of every day of every notebook**
in the library to produce two integers. A stale doc-comment on a repository method is exactly the
duplicated authority `CLAUDE.md` warns about; the fix is one line at the call site.

### 6. `P03`'s criterion is one-directional in the implementation, and the tests bless the deviation *(minor)*

The criterion reads "A journal's start date is the researcher's to set, and the calendar begins
there". `packages/database/src/repositories/journal.ts:136-145` returns
`min(chosen ?? born, earliest entry)` — an entry older than the chosen day silently overrides it,
so the researcher can move the beginning back but never forward past an existing day.

The behaviour is defensible (no day falls off the front) and is disclosed in the UI, which shows
the chosen date and the resolved one as separate elements (`journal-panel.tsx:572-586`). But it is
asserted as intended at `tests/integration/journal.test.ts:275-283`, so the gap between the
criterion's letter and the build is not visible anywhere a reader of the tests would find it.
Worth a line in `state/DECISIONS.md` rather than code.

### 7. The materialised wiki still calls a notebook a question *(minor)*

`apps/desktop/src/main/agents/wiki-view.ts` — the researcher-readable markdown mirror — writes
`questions/<id>.md` (`:104`), stamps `type: question` in the front matter (`:253`), and its README
says ``- `questions/` — N research questions, in the order they are worked on.`` (`:335`). The
same file was edited in this range to file a day under its notebook (`:108-114`), so the
vocabulary was left behind in code the milestone touched. It is off unless agents are enabled,
which is the only reason this is minor rather than part of finding 1.

### 8. "Lists every notebook" is only proved for notebooks that are not discarded *(minor)*

`notebook-directory.tsx:132-133` splits the rows into `working` and `dropped`, and only `working`
goes into `[data-testid="directory-list"]` (`:178`). The dropped rows render in a second `<ul>`
with no test id. `tests/e2e/notebooks.spec.ts:48-51` asserts `toHaveCount(2)` on
`directory-list > li` and never seeds a discarded notebook, so a regression that dropped
discarded notebooks from `notebook:directory` altogether would leave the test green. One seeded
discard and an assertion on `directory-item-<id>` closes it.

### 9. A nested code fence is restructured the first time the day is saved *(minor)*

`apps/desktop/src/renderer/journal-blocks.ts:64` detects a closing fence with
`next.trim().startsWith(marker.slice(0, 3))`, so any run of three-or-more backticks closes a
four-backtick block. Verified by running the parser:

```
input       "````md\n```bash\nls\n```\n````\n"
parseBlocks [code "````md\n```bash\nls\n```", code "````"]
serialize   "````md\n```bash\nls\n```\n\n````\n"
```

The document is not lost, but it is rewritten — and the `[N11]` round-trip test
(`journal-blocks.test.ts:59`) only asserts stability from the *second* parse onward
(`serialize(parse(once)) === once`), which cannot see a first-pass mutation. Comparing against
the original input for a case with a nested fence would.

## Not findings, checked and cleared

- `seedNotebook` (`tests/e2e/support/workspace.ts:385-400`) writes through the real repositories
  into the real database file before Electron starts — not a fixture blob.
- Journal panels are keyed per notebook (`panel-targets.ts:85-88`), so two notebooks cannot share
  one log page.
- A milestone-4 workspace whose journal descriptor has no `questionId` is salvaged, not fatal:
  `deserializeWorkspace` drops the panel entry with a warning (`layout.ts:493-497`) and
  `JournalPanel` falls back to an empty state (`journal-panel.tsx:691-697`).
- `notebook:directory` returns discarded notebooks too (`handlers.ts:905`); the omission in
  finding 8 is in the page and the test, not the channel.
- The alt text of a dropped figure is the file's title, not its path; `[P04]`'s
  `not.toContain('attention-pattern.png')` passes on the extension, but a filename is not a path
  and the renderer still never receives one.
