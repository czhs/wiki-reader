# Milestone-7 audit — the one-document notebook

Range `be7508a..HEAD` (`a912606`). Lens: the notebook as one document — desk migration, in-page
front matter, block drag/delete/resize, the journal pop-up and its expansion, `Cmd+S` — and
whether the superseded tests (`E01`, `N06`, `N07`, `N09`) prove the titles they now carry.
`docs/MILESTONE7.md`'s **Supersessions** rule was read first: the retired board, the retired
journal tab and the retired 240px margin are re-promises, not regressions.

Unit and integration suites run for this lens, all green:
`apps/desktop/src/renderer/block-source.test.ts` (19), `packages/document-model/src/excerpt.test.ts`
(15), `apps/desktop/src/main/menu.test.ts` (4), `tests/integration/notebook.test.ts` (35),
`packages/workbench/test/guide.test.ts` (13), `tests/integration/guide-controls.test.ts` (3).
The E2E suite was not run.

---

## Findings

### 1. (major) The desk migration stops after 500 edges per notebook, then records itself done

`apps/desktop/src/main/desk-retirement.ts:84` calls

```ts
db.links.findReferences({ entityType: 'question', entityId: question.id, direction: 'outgoing' })
```

with no `limit`, and `packages/database/src/repositories/links.ts:202` defaults it to **500**
(`ORDER BY l.created_at, l.id LIMIT ?`). A notebook carrying more than 500 outgoing edges gets
blocks for its oldest 500 cards and nothing for the rest — and then
`desk-retirement.ts:92` writes `notebook.deskRetired = true`, so the pass returns `0` on every
later start and the remainder can never land. `docs/MILESTONE7.md:75` states the property this
file exists to keep: "nothing the researcher placed is lost". The edges survive in `links`, so
the graph and the ledger still have them, but the one surface that showed them has been removed
and the replacement is silently incomplete past the cap.

The file's own three properties (idempotent, additive, silent about paths) all hold; this is a
fourth one — *total* — that is not stated and not met. `retireTheDesk` returns a count and the
logger says `added`, so a partial run is indistinguishable from a complete one in the log.

Same root cause, lesser blast radius, at `apps/desktop/src/main/handlers.ts:296-301`
(`receivePageDrop` builds its already-referenced set from the same capped query, so on a
501-edge notebook a re-dropped paper can grow a second edge).

Fix is one word: pass an explicit `limit` (or add a paged/unbounded read for this one caller).

### 2. (major) `Cmd+S` becomes a dead key after any second writing surface unmounts

`registerBlockSurface` sets `inHand`, and its disposer at
`apps/desktop/src/renderer/block-surfaces.ts:36` clears it:

```ts
if (inHand === surfaceId) inHand = null;
```

`COMMAND_IDS.saveWriting` runs `host.runBlockAction({ action: 'save', surfaceId: null, … })`
(`packages/workbench/src/workbench.ts:1406-1413`), which resolves through
`blockSurface(null)` → `inHand` → `null` → the error branch at
`apps/desktop/src/renderer/host.ts:819-825`: *"Open a notebook page or a journal day first."*

Reachable sequence, all of it inside `P09`'s own workflow:

1. open a notebook page (`inHand = notebook:X`);
2. glance at the journal — the pop-up mounts a second `BlockEditor` (`journal:X:2026-08-01`,
   `journal-panel.tsx:341`), so `inHand` moves to it;
3. close the pop-up — the disposer sets `inHand = null` while the notebook page is still mounted;
4. press `+ text` and type. `insert` (`blocks.tsx:370-375`) never calls `touchBlockSurface`, and
   `registerBlockSurface` will not re-run because the editor's `handle` and `surfaceId` are stable
   (`blocks.tsx:551`);
5. `Cmd+S` reports the error and writes nothing.

Only clicking an existing block or right-clicking one restores `inHand` (`blocks.tsx:659`, `674`).
`P12`'s E2E cannot see this: `tests/e2e/notebook-one-page.spec.ts:181` never mounts a second
surface, so the criterion passes against a key that dies in the milestone's own layout. The
docstring at `block-surfaces.ts:40-43` ("the one a bare command means") is the invariant being
broken — a fallback to the sole remaining surface, or to the most recently registered one, would
restore it.

### 3. (major) Expanding the journal drops the day being read, and `P09`'s test cannot tell

`JournalPopup`'s Expand (`apps/desktop/src/renderer/journal-panel.tsx:569-575`) passes only
`questionId` to `COMMAND_IDS.expandJournal`, which opens the descriptor
`{ kind: 'journal', questionId }` (`packages/workbench/src/workbench.ts:918-925`). The day is
`JournalView`'s local state, initialised to today (`journal-panel.tsx:80`), so a pop-up open on
2026-07-15 expands into a page showing **today**. Nothing "carries" across the expansion at all:
the two views independently ask the database for their own day.

`tests/e2e/journal.spec.ts:266` is titled *"the journal is written in over the reading, and
carries into the page it expands to"*, and every assertion in it is made on today's day
(`journal-block-0` before and after). It would pass unchanged against an implementation where
Expand simply opened a fresh journal on the notebook — which is what it does. The test's title
promises more than the code keeps, and the gap is exactly the case a researcher hits when they
glance back at yesterday and decide it is worth sitting in.

`N09` (`journal.spec.ts:183`) does prove its new title — pop-up over the workspace with the
interrupted page underneath, scrim, no dockview journal page, no `— today` tab; then Expand into
a tab at a reader's width, calendar in the margin, one page per notebook. Only the "carries"
clause of `P09` is unproven.

### 4. (minor) A re-drop of something already on the page is reported as a drop the notebook could not hold

`receivePageDrop` returns `added` from `appendNotebookBlocks`
(`apps/desktop/src/main/handlers.ts:322`), which skips blocks whose internal link the page
already carries. So dropping the same paper (or the same picture) twice legitimately answers
`added: 0` — the behaviour `tests/integration/local-files.test.ts:242-259` asserts. The page then
draws that as an error: `apps/desktop/src/renderer/notebook-panel.tsx:278-282` shows
*"Nothing this notebook can hold was in that drop."* for both "nothing usable was in it" and
"it is already here". The second message should say so; the two cases are distinguishable in the
main process (documents were added, blocks were not).

### 5. (minor) Dragging a block while another block is open re-targets the open editor

`startDrag` cancels the pointer event (`apps/desktop/src/renderer/blocks.tsx:455`), which in
Chromium suppresses the compatibility `mousedown` and therefore the focus change — so a textarea
that was open stays open and `editing` stays set. The drag then reorders `rows`
(`blocks.tsx:478-480`) without remapping `editing.index`, and the textarea is chosen purely by
index (`blocks.tsx:617`). Dragging block 3 above block 1 while block 2 is being typed in closes
block 2's textarea and opens a textarea on whatever row now sits at index 1, with the caret
clamped to the old offset.

No content is lost — `rowsRef` keeps every row's `src` and `onUp` commits the whole document —
and `setEditing(null)` at the end of the drag tidies up, so this is a wrong-box-under-the-caret
bug rather than a data bug. Neither `P07` test opens a block before dragging
(`tests/e2e/blocks.spec.ts:126`, `:181`), so it is uncovered. Remapping `editing` inside `onMove`
(or clearing it in `startDrag`) closes it.

### 6. (minor) `w=` in the title slot is not a width to anything but this app

`apps/desktop/src/renderer/block-source.ts:154-158` justifies keeping a figure's width in the
markdown title slot on the grounds that "a figure resized in this app is still a figure of that
width to anything else that reads the file". It is not: `![a](rrfile://f1 "w=320")` renders in
every standard markdown pipeline as an image with the tooltip `w=320`, at its natural size.
`P11`'s promise ("An image in a block is resized by hand") is met and the round-trip is properly
tested (`block-source.test.ts:201-253`, `tests/e2e/blocks.spec.ts:225`); only the stated reason
for the storage choice is wrong, and it is the reason a later reader would rely on when deciding
whether the convention may change.

### 7. (minor) `N11`'s block counts would count an open editor

`tests/e2e/journal.spec.ts:772` and `:841` count blocks with `[data-testid^="journal-block-"]`,
which also matches `journal-block-editor-N`. `tests/e2e/blocks.spec.ts:99` and
`tests/e2e/notebook-landing.spec.ts:69` both learned to exclude it
(`:not([data-testid*="editor"])`). The two N11 assertions are correct today only because the day
they seed is non-empty and therefore never auto-opens a block — which is precisely the invariant
`P08` introduced and could change again. Cheap to align with the other two specs.

---

## What the lens checked and found sound

- **Desk migration, apart from the cap.** Cards were only ever `question-references-…` edges
  (`packages/shared-types/src/domain.ts:360-363` has exactly the two types, both handled by
  `cardAsBlock`); `links` is untouched; migration 014 drops only `card_positions`, which held
  arrangement and nothing else (`git show be7508a:packages/database/src/repositories/board.ts`).
  Idempotence is load-bearing on the block's own internal link rather than on the settings mark
  (`apps/desktop/src/main/notebook-body.ts:38-65`), so a restored backup cannot double a page;
  `tests/integration/notebook.test.ts:679-720` exercises first run, two further runs, a run with
  the mark deleted, and prose already on the page. A page that was empty appends to
  `blankNotebook()` rather than to `''`, so the migration cannot look like a wipe. A card whose
  other end has gone is deliberately left as an edge, and `[N06] keeps the block when the paper is
  removed` (`notebook.test.ts:500`) pins the converse.
- **The board's one non-data capability survived.** `board-pick`/`board-add` are gone, but
  `sendToNotebook` is on the library row's, the tab's, the graph node's, the highlight's and the
  reader's context menus (`packages/workbench/src/menus.ts:82,103,124,137,177`).
- **`E01`, `N06`, `N07` prove their new titles.** `E01`
  (`tests/e2e/reading-into-notebooks.spec.ts:90`) asserts the edge in SQLite *and* the block in
  the page after a restart, with both internal-link schemes present. `N06`
  (`tests/e2e/notebook-landing.spec.ts:115`) asserts survival in a second process plus navigation
  through the chip. `N07` (`:212`, `:249`, `:307`) keeps inode, size, no copy anywhere under the
  workspace, no path in the markup, `rrfile://` after restart, and the bridge still exactly
  `['invoke','subscribe']`. The verifier's titles for all four were updated
  (`scripts/verify_completion.py:138-141,173`).
- **`P10`.** `tests/e2e/notebook-one-page.spec.ts:92` asserts the old margin by its *element*
  (`notebook-side`, count 0), the four sections inside the scroller, front matter's three fields
  inside the front-matter section, scroll-to for a section and for an outline heading, and that
  front matter still writes to the database from where it now lives.
- **`P12`'s other half.** `apps/desktop/src/main/menu.test.ts:31` asserts no menu on any platform
  binds `Cmd/Ctrl+S` and no `role:save` exists — the half CDP-delivered keys cannot see. The
  binding is deliberately unguarded by `!textInputFocus`
  (`packages/workbench/src/workbench.ts:409-415`), and `save()` is `commit()` minus the two things
  that would move the caret (`blocks.tsx:352-363`); the E2E asserts focus and input value after
  the keystroke, which is the assertion that makes the criterion honest.
- **`P07`/`P11` write the document, not a view.** `moveBlock` is pure and total
  (`block-source.ts:126-133`, `block-source.test.ts:161-192`); the E2E polls the *stored body*
  after the drag and after the delete, and restarts. The concurrent-write hazard a delete creates
  (blur-commit and delete-commit in flight together) is handled by `writeTicket`
  (`blocks.tsx:309-337`). `P11` reads the width back from the day's own markdown in a second
  process.
- **`P08`.** The seeding effect fires only on a surface never seeded or a document emptied to no
  blocks (`blocks.tsx:418-429`), so it is not a focus trap; `serializeBlocks` drops a
  whitespace-only block, so looking at a day does not log it, and the E2E proves that across a
  restart.
- **Guide coverage.** `block.rearrange`, `block.resize`, `block.picture`, `notebook.jump`,
  `notebook.outline`, `notebook.excerpt` all carry literal `data-control` attributes and
  `guide-controls.test.ts` (equality both ways) and `guide.test.ts` pass.
