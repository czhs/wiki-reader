# Milestone 4 audit — N09, N10, N11, K01, K02, K03

Auditor: independent. Branch `main`, HEAD `c072375`. Diff under audit: `fde3e38..HEAD`.
Method: read-only. `git diff`, `git show`, `grep`, and one scratch Node harness in `/tmp`
(a verbatim copy of `parseBlocks`/`serializeBlocks`, so nothing in the tree was touched).
No E2E was run; the suite is reported green and other auditors hold the tree.

Goal: falsify "milestone 4 is complete" for these six criteria. Everything below is a trace,
including the ones that ended in "it holds".

---

## Findings

### F1 (minor) — no test distinguishes "the project began" from "the first entry was written"

`docs/MILESTONE4.md` names the trap for `N10` in exactly these words: *"the calendar starts
when the **project** began, not when the first entry was written"*.

The implementation is **correct**. `packages/database/src/repositories/journal.ts:106-113`:

```ts
projectStart(): string {
  const row = this.db.prepare('SELECT MIN(applied_at) AS created FROM schema_migrations').get() ...
  const created = localDay(row?.created ?? this.clock.now());
  const first = this.firstDate();
  return first !== null && first < created ? first : created;
}
```

`schema_migrations(applied_at)` is real and is written at first migration
(`packages/database/src/migrator.ts:38-45`, `:101-103`), so `MIN(applied_at)` genuinely is the
day the library was made. I verified the table and column exist and are populated with
`new Date().toISOString()`.

The **tests**, however, cannot tell that implementation apart from the wrong one the trap names.

`tests/integration/journal.test.ts:162-182` is the only test that touches the distinction. Its
four assertions are:

1. cold workspace → `projectStart === todayLocal()`
2. after writing `MONDAY` (2026-07-20) → `projectStart === MONDAY`
3. after also writing `THURSDAY` → `projectStart === MONDAY`
4. after restart → `projectStart === MONDAY`

Now substitute the wrong implementation `projectStart() { return this.firstDate() ?? localDay(this.clock.now()); }`
— i.e. "the calendar starts at the first entry, or today if there is none":

1. `firstDate()` is null → today ✔ passes
2. `MIN(date)` = MONDAY ✔ passes
3. `MIN(date)` = MONDAY ✔ passes
4. ✔ passes

All four pass. The test rules out only the strictly-null variant (`firstDate()` with no
fallback), which the comment in the test says it is ruling out — but that is not the variant
the trap warns about, and it is not the variant that ships as a plausible bug.

The E2E `[N10]` (`tests/e2e/journal.spec.ts:201-269`) does not help either: it seeds an entry
at `daysAgo(12)` into a database that `createWorkspace()` made *today*, so
`min(created=today, first=12d ago)` and `firstDate()` return the identical value. The spec's
own preamble claims the gap is the point, but the seeded entry *is* what sets the range, so
"since the project began" and "since the first entry" are indistinguishable in that fixture.

Discriminating was feasible: `runMigrations(db, migrations, now)` takes an injected clock
(`packages/database/src/migrator.ts:77-81`), and the integration harness owns the file, so a
workspace whose migrations were applied a month ago and whose journal is empty would separate
the two in one assertion.

Severity **minor**, not major: the shipped behaviour is right, so no researcher is harmed. What
is missing is the falsification. Flagged because the milestone doc named this specific trap and
the tagged tests do not close it.

- `tests/integration/journal.test.ts:162`
- `tests/e2e/journal.spec.ts:201`
- `packages/database/src/repositories/journal.ts:106`

### F2 (minor) — "+ code", clicked and never typed into, marks the day as logged

`apps/desktop/src/renderer/journal-blocks.ts:93-106` documents its own contract:

> A block that is only whitespace is dropped: an inserted block nobody typed into is an
> intention, not content, and writing it out would leave the day looking logged.

It does not hold for code blocks. `EMPTY_CODE_BLOCK` is `` '```\n\n```' `` (`journal-blocks.ts:133`),
which `+ code` inserts (`journal-panel.tsx:352`). The filter in `serializeBlocks` is
`src.trim() !== ''`, and a bare fence pair does not trim to empty:

```
$ node /tmp/wraudit/probe2.mjs
markdown written: "```\n\n```\n"
journal.write would treat as blank (delete)? false
reparsed blocks: [{"type":"code","src":"```\n\n```"}]
empty text block -> ""
```

So: open the journal on an unlogged day, click **+ code**, click away. `commit()` serializes
`` "```\n\n```\n" ``, `journal:write` sees non-blank markdown
(`packages/database/src/repositories/journal.ts:34-36`), a row is created, and the calendar
bubble for that day flips to `data-logged="true"`. Two clicks, no typing.

That contradicts the serializer's stated rule and `N10`'s "empty means unlogged". The commands
margin does *not* list it (`codeBody` of an empty fence trims to `''`, filtered at
`journal-panel.tsx:243-251`), so the day is marked logged with nothing visible to explain why.

The `+ text` path is correct — `serializeBlocks([{type:'text',src:''}])` → `''` — and that is
the only path `[J01]`/`[N10]` exercise (`journal.spec.ts:117`, `:245`). No test covers the code
path.

Severity **minor**: recoverable (clear the block, the day deletes itself), and not a stated
criterion assertion.

- `apps/desktop/src/renderer/journal-blocks.ts:101-106`, `:133`
- `apps/desktop/src/renderer/journal-panel.tsx:352`

### F3 (minor) — writing a day and switching to another in one gesture leaves the calendar stale

`apps/desktop/src/renderer/journal-panel.tsx:204-218`:

```ts
const result = await call('journal:write', { date, markdown });
if (selectedRef.current !== date) return;      // <- bails out here
setEntry(result.entry);
setRows(toRows(parseBlocks(result.entry?.markdown ?? '')));
await loadCalendar();                          // <- never reached
```

Clicking another day's bubble while a block editor is focused fires blur (→ `commit()`) before
the click (→ `setSelected`). The write itself is safe — it is already in flight with the
captured `date`, and the row lands. But by the time it resolves `selectedRef.current` is the
*new* day, so the guard returns early and `loadCalendar()` is skipped. The day just written
keeps `data-logged="false"` until some later commit refreshes the calendar.

Not exercised: `[N10]` always blurs via `addBlock` (which commits while the day is still
selected) before clicking the next bubble, so the interleaving never occurs
(`tests/e2e/journal.spec.ts:242-261`).

Severity **minor**: display-only, self-heals on the next successful write or reload.

- `apps/desktop/src/renderer/journal-panel.tsx:210-217`

---

## Traces that held

These are recorded because a verified invariant is worth as much as a finding.

### N09 — "a page in the workspace, at a reader's width", not a sidebar

The trap asks whether the test proves *where* it lives or only that it renders. It proves where.

`tests/e2e/journal.spec.ts:147-199` asserts, against a real Electron process:

- `[data-testid="journal-sidebar"]` has count 0, and `library-sidebar` is still visible — so the
  journal did not merely move into the left slot and evict the library;
- the page is matched *inside* `[data-testid="dockview-container"] [data-testid="journal-page"]`
  (`App.tsx:298` is the Dockview host), and there is exactly one `.dv-tab` reading "Journal";
- `pageBox.width > 600` **and** `toBeCloseTo(readerBox.width, 0)` against a PDF reader opened
  first — "a reader's width" measured against an actual reader rather than a magic number;
- `entryBox.width > calendarBox.width` and `calendarBox.x > entryBox.x + entryBox.width - 1` —
  the calendar is *beside*, not above.

Structurally the move is real, not markup renaming: `journal` is a `PanelKind`
(`packages/workbench/src/layout.ts:46`) with its own descriptor schema (`:176`), it is in
`SINGLETON_PANEL_KINDS` (`packages/workbench/src/panel-targets.ts:31`), and
`toggleJournalSidebar` is *gone* — `LEFT_SIDEBARS` is now `['library','questions','librarian']`
and the `journal` key was deleted from `SidebarStateSchema`, `emptyWorkspace()`,
`normaliseSidebars()`, `toggleSidebarState()` and `initialWorkspaceState()`. `grep -rn journal
… | grep -i sidebar` over `apps/desktop/src` and `packages/workbench/src` returns nothing. The
`toggleSidebar` host signature no longer accepts `'journal'`, so a regression would not compile.

The activity-bar button routes through the registry — `run(COMMAND_IDS.openJournal)`
(`App.tsx:223`) → `resolveOpen({kind:'journal'}, …)` → `host.applyPlan` — not a direct panel
poke. Singleton reuse is asserted at `journal.spec.ts:196-198`.

### N10 — every day since the start, one entry per day, empty means unlogged

Apart from F1, this holds and is well tested.

- Range: `calendarCells` is pure and dateless (`journal-calendar.ts:64-100`), fed
  `from = projectStart` (`journal-panel.tsx:266-272`). `daysBetween` iterates UTC midnights of
  local ISO date strings, which is the correct way to enumerate calendar days without DST drift.
  A `projectStart` in the future falls back to today rather than producing an inverted range.
- Collapsed runs: `[N10]` seeds a project 12 days old with one entry on day 0, asserts exactly
  one `journal-run-*` marker reading "11 days", clicks it open, then asserts all 13 individual
  days are present. I recomputed the cell layout by hand against `calendarCells` and it matches:
  logged day, run of 11, today.
- One entry per day: enforced at the schema (`date` is the conflict target,
  `journal.ts:42-46`) and asserted at `tests/integration/journal.test.ts:119-131`.
- Empty means unlogged: `write()` with blank markdown *deletes* (`journal.ts:34-36`), the
  integration test asserts the row count is 0 **and** that a direct SQL insert of `''` throws
  (`journal.test.ts:143-159`), and `[J01]` asserts the bubble flips back to `data-logged=false`.
- Editing *that* day, not the page's one day: `[N10]:242-265` writes on a mid-range day, checks
  today is still empty and unlogged, then returns to the mid-range day and finds its text —
  which is what rules out "one entry the page re-dates".

### N11 — the block notebook is a view over one markdown document, one store

The trap: does the block model round-trip, or is there a parallel representation that drifts?

**There is genuinely one store.** `journal_entries.markdown` is the whole of it. No migration in
the milestone-4 set creates a block table — `grep -l block packages/database/src/migrations/`
returns only `001_initial.ts` and `002_markdown.ts` (pre-existing, unrelated), and 007/008 add
`question_tags`, `hypotheses`, `card_positions`. `commit()` serializes the whole document and
writes it through `journal:write`, then **re-parses the markdown the main process answered
with** rather than trusting its own row state (`journal-panel.tsx:204-218`) — so the document is
the authority, not the block list.

The commands margin is derived, not stored: `useMemo` over `rows` filtering
`type === 'code'` (`journal-panel.tsx:242-251`). The E2E asserts a *seeded* command appears in
the margin and that clicking it opens the block it came from with the exact fenced source
(`journal.spec.ts:345-351`), then that a command added afterwards appears there too — which is
the discriminating check for "second list kept in step".

Round trip: I ran twelve adversarial documents through a verbatim copy of
`parseBlocks`/`serializeBlocks`.

```
IDENTICAL  indented (4-space) code block with blank line
IDENTICAL  loose list with blank lines
IDENTICAL  markdown list with indented fenced code
CHANGED    hard line break at end of paragraph   ("line two  \n" -> "line two\n")
CHANGED    CRLF document                          (\r\n -> \n)
CHANGED    two blank lines between paragraphs     (\n\n\n -> \n\n)
IDENTICAL  blockquote containing a blank line
IDENTICAL  yaml frontmatter
IDENTICAL  html block with blank line
IDENTICAL  nested list indentation
IDENTICAL  setext heading
IDENTICAL  table then note
```

Every case is idempotent after one pass, and **no case loses content** — the three changes are
whitespace normalisation (a trailing-space hard break at the very end of a block, CRLF, and
runs of blank lines). Worth knowing that opening a hand-written day and pressing "Save day"
can reflow it slightly, but nothing drifts and nothing disappears. Not raised as a finding.

The unit tests (`journal-blocks.test.ts`) assert the weaker `serialize(parse(once)) === once`
rather than `=== DAY`; for `DAY` the stronger form happens to hold, so this is a missed
tightening rather than a hidden defect.

Main surface: `[N11]` measures `blocksBox.width > sideBox.width` and
`sideBox.x > blocksBox.x + blocksBox.width - 1`, and requires `journal-calendar` and
`journal-commands` to both be *inside* `journal-side` (`journal.spec.ts:330-341`). Block kinds
are asserted by `data-block-type` with the rendered content checked (`h2` text, `code` text,
an `img` element), and the restart pass re-reads all five blocks including the two that were
never touched. No execution anywhere: `BlockBody` renders code as a `<pre><code>` of the literal
source (`journal-panel.tsx:89-102`).

Image safety: an image block resolves through `renderMarkdown` → `<img src={safeHref(url)}>`
(`packages/markdown-reader/src/render.tsx:131-132`), and the renderer CSP is
`img-src 'self' data: blob: rrfile:` (`apps/desktop/src/renderer/index.html:18`) — a pasted
remote URL is a broken image, not a request. The spec's comment on this is accurate.

### K01 — two documents linked from the reader, with a typed relationship

Holds, and the "typed" part is the load-bearing assertion rather than decoration.

- The gesture starts at a real button in the reader (`panels.tsx:264-274`) which runs
  `COMMAND_IDS.linkToDocument` — the same code path the `⌘⌥L` binding runs. The button prints
  its own chord.
- The command opens the picker and writes nothing (`workbench.ts` `linkToDocument` →
  `host.promptDocumentLink`); the picker collects two choices and hands them back through
  `run(COMMAND_IDS.createDocumentLink, …)` (`overlays.tsx:322-325`). So the panel does not
  manipulate anything directly — the invariant holds here.
- No default type: `linkType` starts `null`, `ready` requires both, and the command *also*
  refuses a missing type server-side of the UI (`workbench.ts` `createDocumentLink` throws
  rather than falling back to `related-to`). `tests/e2e/links.spec.ts:198-200` asserts the
  create button is disabled with the target chosen and no type, **and** that the database has
  no edge at that moment — that is the assertion that makes "typed" real.
- The edge is checked in SQLite, not in the UI: `edgesBetween()` opens the workspace database
  directly and the test asserts `[{ type: 'related-to', origin: 'manual' }]` — exactly one edge,
  of the chosen type, marked as the researcher's own (`links.spec.ts:214-216`). `origin:'manual'`
  matters: `host.ts:487-490` explains a `derived` origin would make it deletable by re-derivation.
- It is findable afterwards: Shift+F12 on the source document names the target and says
  "related to" (`linkTypeLabel('related-to')`, `entity-links.ts:99`).
- All relationships stay typed directed edges in `links` — no new table, no backlink table.

### K02 — a note made from the reader lands linked, and the annotation has *two* edges

The trap: "an annotation has two edges, not one — does the test assert both?" **It does.**

`tests/e2e/links.spec.ts:300-306`:

```ts
await window.keyboard.press('Shift+F12');
const rows = window.locator('[data-testid="references-list"] [data-testid^="reference-row-"]');
await expect(rows).toHaveCount(2);
const noteRow = rows.filter({ hasText: 'Note on' });
await expect(noteRow).toHaveCount(1);
await expect(noteRow.first()).toContainText('references this');
await expect(rows.filter({ hasText: first.title })).toContainText('highlighted in');
```

Two rows, and each is identified by *which* relationship it is: `highlighted in` is
`annotation-belongs-to-document` (the document it lives in), `references this` is the incoming
`note-references-annotation` (`entity-links.ts:89`, and `panels.tsx:955` appends " this" for
incoming direction). So the assertion is genuinely "the document it lives in, plus the thing
made from it", not just "two of something".

I checked the subject resolution, because the note is navigated to before Shift+F12 is pressed
and the assertion would be meaningless if the query ran on the note: `#subject` prefers the
link under the cursor, then `getActiveEntity()`, which returns the *selected annotation* before
the active panel (`host.ts:244-252`). The annotation is the subject. Correct.

Both edges are written by real code, not seeded: `annotation-belongs-to-document` is derived
inside annotation creation (`packages/database/src/repositories/annotations.ts:117`) and
`note-references-annotation` is written in the same transaction as the note
(`apps/desktop/src/main/handlers.ts:602-648`) — "the note and its edges are one unit", which is
precisely the failure K02 names. The test asserts the note's outgoing edge set equals exactly
`[{ note-references-annotation, targetId: <the one annotation in the DB>, origin: manual }]`,
read from SQLite.

One more thing the test closes: the button advertises what it will do
(`data-note-source="document"` → `"annotation"` after a highlight is made,
`panels.tsx:279`) and the test asserts the advertised source *and* the resulting edge type, so
a button whose label disagreed with `getActiveEntity()` would fail.

### K03 — every keybound action discoverable without knowing the key

The trap: is this a live rendering of the registries, or a hand-written sheet that can drift?
**Live.** And the test would catch an omission.

- `CommandList` (`overlays.tsx:81-179`) renders `workbench.searchCommands(query)` and
  `workbench.keybindings.chordsForCommand(command.id)`. `CommandRegistry.search('')` returns
  **every** registered command with no cap and no virtualisation
  (`packages/workbench/src/commands.ts:210-221`); `chordsForCommand` walks the live chord map
  (`keybindings.ts:340-348`). There is no static shortcuts table anywhere in the tree.
- `tests/e2e/shell.spec.ts:186-239` iterates `DEFAULT_KEYBINDINGS` **imported from the real
  registry module** and, for each rule, requires a row for `rule.commandId` to exist, to be
  visible, to have a non-zero layout box, to carry the platform-resolved chord in `data-chord`,
  to print a `<kbd>`, and to have a label that is not just the command id. It also asserts
  `DEFAULT_KEYBINDINGS.length > 10` so an emptied array cannot vacuously pass.
- Would it catch a newly added binding the list omits? Yes, in the failure mode that can
  actually occur: a rule pointing at a command id that is not registered produces no row and
  `toHaveCount(1)` fails. (A rule pointing at a registered command *cannot* be omitted, because
  the list is the registry — which is the point.)
- The entry point is not itself keyboard-only: the test opens the list by clicking
  `status-commands` in the status bar (`App.tsx:438-450`), which is the exact circularity the
  criterion is about. The button prints its own chord, and the test then presses that chord to
  confirm it works.
- The list is also an *action* surface, not just documentation: it clicks the
  `toggleLibrarySidebar` row and asserts the sidebar actually closes.
- Disabled commands are shown greyed with `data-enabled="false"` rather than hidden, so a
  command that is momentarily unavailable is still discoverable.

Residual, not raised as a finding: a handful of element-scoped keys are handled outside the
registry — `Escape` to dismiss the overlays and the peek (`overlays.tsx:104`, `:217`,
`App.tsx:385`), `Enter` to open a block or add a claim, `ArrowUp`/`ArrowDown` to reorder the
queue (`queue-panel.tsx:155`). These are widget affordances on a focused element rather than
global actions, and the surrounding controls are visible, so I do not read them as "actions with
a keybinding" in K03's sense.

---

## Cross-cutting invariant checks

- **"Panels never manipulate each other directly — everything goes through the command
  registry."** Every new cross-panel gesture in scope routes through `run(COMMAND_IDS.…)`:
  `activity-journal` → `openJournal` (`App.tsx:223`), `reader-link` → `linkToDocument`
  (`panels.tsx:268`), `reader-new-note` → `newNoteFromHere` (`panels.tsx:280`),
  `link-picker-create` → `createDocumentLink` (`overlays.tsx:324`), `status-commands` →
  `showCommands` (`App.tsx:442`). The two overlays close themselves by writing their *own*
  store flag (`commandsOpen`, `linkDraftSourceId`) — that is local state of the overlay, not
  another panel, so I read this as intact. No panel touches `store.api` / Dockview directly.
- **"All relationships are typed directed edges in `links`. No untyped backlink table."** Held.
  New edges in scope (`related-to`/`child-of`/`document-cites-document` from the picker,
  `note-references-annotation` / `note-references-document`,
  `journal-entry-advances-question`) all go through `db.links.create` with an explicit `type`,
  `sourceType`, `targetType`. No new table in migrations 007–011 stores a relationship.
- **Type escapes.** `git diff fde3e38..HEAD` over `apps/desktop/src`, `packages/workbench`,
  `tests/` yields no new `: any`, `as any`, `@ts-expect-error`, `@ts-ignore` or `eslint-disable`.
  The only `as unknown as` additions are three lines in a security spec probing the preload
  bridge, which is the legitimate use. `entityFromArgs`'s `as unknown as EntityRef`
  (`workbench.ts:172`) is pre-existing, unchanged by this milestone.
- **Stubs / skips.** No `TODO`, `FIXME`, "not implemented", `test.skip`, `test.fixme`,
  `it.skip` or `.only(` anywhere in the scope files or the two test suites.
- **Mocks where integration was feasible.** None found in scope. `[K01]`/`[K02]` open the
  workspace SQLite file directly and assert on rows; `[N09]`–`[N11]` drive a real Electron
  window; `[N10]`'s integration case crosses the real router into a real database file and
  restarts the services against the same file. The workbench unit tests for the new commands
  do use a fake host, but they are tagged `[L09]` (the command-registry criterion from
  milestone 1), not `[K01]`/`[K02]` — no criterion is being claimed by a mock.
- **Verifier.** `scripts/verify_completion.py` was only *strengthened* in this diff: `N09`,
  `N10`, `N11` and `B05` were added to `E2E_TAGS`, and `B01`'s description was corrected to the
  round-trip wording. `K01`–`K03` were already armed. Nothing was removed or loosened.
- **Tag/criterion alignment.** Every tag in scope has at least one test whose title carries it,
  and each test's body exercises the thing the tag names. No misattributed tags found.

## Verdict for this scope

Nothing critical. Nothing major. Three minor findings: one test-strength gap on the trap
`N10` explicitly names (F1), and two small behavioural defects in the journal page (F2, F3).
None of them blocks the milestone.
