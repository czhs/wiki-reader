# Milestone 4 audit — field notebooks (N01–N08)

Auditor scope: criteria N01–N08. Repo `/Users/hshi/Desktop/wikireader`, branch `main`,
HEAD `c072375`, milestone-4 diff `fde3e38..HEAD`. Read-only audit; no repo file was changed
except this report. E2E was **not** executed (per instructions); every E2E claim below is
established by reading the spec and the code it drives, and by proving the main-process /
renderer seam it depends on.

Executed once, to confirm the in-scope vitest files are genuinely green rather than absent:

```
pnpm exec vitest run tests/integration/notebook.test.ts tests/integration/local-files.test.ts \
  packages/document-model/src/notebook.test.ts packages/workbench/test/panel-targets.test.ts
→ 4 files passed, 51 tests passed
```

---

## Summary

**No critical or major findings.** I could not falsify "N01–N08 are complete". Three minor
findings are recorded, one of them a proven implementation defect (F1), one a test that is
weaker than its own comment claims (F2), one a coverage gap between the criterion's wording
and the shipped UI (F3), plus a hygiene note (F4).

---

## Findings

### F1 — minor — a multi-line setext heading leaks its underline into the section body (N02)

`packages/document-model/src/notebook.ts:95-104`

```ts
function endOfHeading(source: string, offset: number): number {
  const lines = source.startsWith('#', offset) ? 1 : 2;
  ...
```

The comment says "a setext heading is underlined on a second line, so it ends at the newline
after that". A setext heading's *text* may span more than one line, in which case the heading
occupies N+1 lines and only 2 are skipped.

Proved by executing the built module (outside the repo, no files written):

```
node -e "import { notebookSections } from '.../packages/document-model/dist/notebook.js'"
input:  "A heading that\nspans two lines\n===============\nbody line one\nbody line two\n"
output: [{ heading: "A heading that\nspans two lines", depth: 1,
           body: "===============\nbody line one\nbody line two" }]
```

The `===============` underline is reported as the first line of the section body. No test
covers setext headings at all — the six `[N02]` tests use ATX (`##`) throughout.

I also tested the adjacent case I suspected and it **holds**: an indented ATX heading
(`  ## Indented heading`) slices correctly, because mdast's `position.start.offset` points at
the first `#` and not at the indentation.

Severity minor: the app's own template and its editor produce ATX headings, so this is only
reachable if the researcher hand-writes a setext heading whose text wraps. It does not falsify
N02 ("the body keeps its sections"), which the passing tests do establish, including the trap
the criterion was written around (a `##` inside a fenced code block is not a section).

### F2 — minor — the `[N06]` E2E's anti-regression guard does not discriminate

`tests/e2e/board.spec.ts:136-139`

```ts
placed = await dragCard(window, cardFor(window, dragged.id), 96, 84);
// The drag moved it somewhere it was not: an implementation that committed the position
// it already had would pass every other assertion here.
expect(placed.x + placed.y).toBeGreaterThan(0);
```

The comment names exactly the right failure mode, but the assertion does not detect it. The
first card's un-dragged default is `defaultSpot(0) = { x: 16, y: 16 }`
(`apps/desktop/src/renderer/desk-board.tsx:41-46`), so `x + y = 32 > 0` holds for a card that
was never moved. A regression in which `commit()` sent `spotOf(card, index)` instead of
`live.current` would set `data-placed="true"`, round-trip those coordinates through the
restart, and pass the entire `[N06]` spec. Asserting the delta (e.g. `placed.x >= 96`) would
close it in one line.

What `[N06]` *does* prove, and I verified end to end, is the harder half: the position is
persisted, and it survives a **real** restart (two separate `launchApp` calls over one
workspace directory, `tests/e2e/support/app.ts:36-87` — a second Electron process, not an
in-memory re-read), and the card nobody dragged comes back `data-placed="false"`.

### F3 — minor — two of the six things N03 names cannot be reached from the running app

Criterion N03: "A notebook page carries description, importance, started, next action, tags,
cover". The integration test (`tests/integration/notebook.test.ts:247-274`) drives all six
through the real router and asserts all six after a restart, so the criterion is met at the
bar the milestone set for it (Kind: integration). But in the shipped renderer:

- `importance` — no control anywhere. Exhaustive grep over `apps/desktop/src` and `packages`
  finds it only as a field in a helper type at `apps/desktop/src/renderer/notebook-panel.tsx:186`
  (never passed a value), in the main-process handlers, and in the librarian's wiki view.
  It is never displayed and never editable.
- `coverFileId` — rendered at `notebook-panel.tsx:241-247` (`rrfile://<file id>`, correctly),
  but nothing in the renderer ever *sets* one. Grep for `coverFileId` across the tree returns
  only tests, schemas, the repository, the handler and that read-only `<img>`.

By the milestone's own N08 principle — "a feature nothing points at is a feature nobody has" —
importance and cover are, today, data only the tests and the agent can see. Recorded as minor
rather than major because N03's verb is "carries" (unlike N01's "edited in-app"), the criterion
is typed as integration, and the page does display the cover once one exists.

### F4 — minor — a Playwright artifact is committed

`test-results/.last-run.json` was added in the milestone-4 range (`{"status":"passed",
"failedTests":[]}`) and `test-results/` is not in `.gitignore` (only `logs/` is). A generated
run-status file in version control is noise at best and a stale "passed" claim at worst.

---

## What I checked and found sound

Recorded because a verified invariant is worth as much as a finding.

### N01 — the page behind a question

- `[N01] keeps the markdown source, byte for byte, across a restart` asserts `page.body === body`
  on a body containing a YAML fence and a two-trailing-space hard break. An implementation that
  stored rendered HTML, or normalised the fence, fails. `writeBody`
  (`packages/database/src/repositories/questions.ts:108-117`) is a plain `UPDATE … SET body = ?`
  with no transformation, and `question:writeNotebook` (`handlers.ts:768-772`) adds none.
- The restart is real: `Workspace.restart()` (`tests/integration/notebook.test.ts:63-66`) calls
  `services.close()` — which calls `db.close()` (`services.ts:287-295`) — and then
  `createTestServices` again against the same file. `createTestServices` is a one-line wrapper
  over the production `createServices` (`services.ts:453-457`), so the restart exercises the
  production assembly, not a test double.
- `[N01] opens a page nobody has written on the blank template, without storing one` reads the
  raw `questions.body` column and asserts `''`. The template is presentation
  (`handlers.ts:215`), not something written into the researcher's row. This test would fail
  against the obvious "seed the template on create" implementation.
- The E2E half (`tests/e2e/notebook.spec.ts:69-94`) types into the panel rather than calling
  the channel, closes the tab (destroying renderer state), and reopens from the queue.

### N02 — sections

- Genuinely AST-driven: `notebookSections` (`notebook.ts:56-87`) reads `parseMarkdown().headings`,
  whose `sourceOffset` comes from the mdast node position (`markdown.ts:149`). The
  `[N02] does not invent a section out of a heading inside a code fence` test would fail against
  any line-regex implementation, which is the discriminating case the criterion was written for.
- "Shallowest headings win" and "prose above the first heading is an anonymous section" are both
  asserted, and neither is satisfiable by a constant.
- One gap: no setext coverage — see F1.

### N03 — front matter

- `[N03] gives the renderer a cover it can load without ever seeing a path` asserts the file id
  resolves to real bytes in the main process **and** that `JSON.stringify(page)` contains
  neither the workspace directory nor `cover.png`. That is the seam, tested from both sides
  with different values on each side.
- The renderer-safe projection is enforced structurally too: `DocumentFileRefSchema` is
  `DocumentFileSchema.omit({ path: true })` (`packages/shared-types/src/domain.ts:85-86`) and
  `NotebookPage` carries no path-bearing field.
- `[N03] refuses a cover that is not a file in the library` asserts `NOT_FOUND` specifically
  (not merely "an error"), which requires the id to be a well-formed `dfl_…` and the handler
  check at `handlers.ts:706-708` to exist.
- Tag replacement is asserted to *replace*, and to land in the same `tags` rows the library
  uses — no parallel tag mechanism.

### N04 — hypotheses as entities

- Two hypotheses get distinct ids, a status change survives a restart, ordering is by stored
  `ordinal`, and a hypothesis on one question does not appear on another.
- `[N04] refuses a status outside the four, at the schema and not only above it` asserts both
  the zod refusal (`INVALID_REQUEST`) **and** that hand-written SQL throws — which is only true
  because migration 007 carries
  `CHECK (status IN ('open','supported','refuted','abandoned'))`
  (`packages/database/src/migrations/007_notebooks.ts:42-43`). The test would fail if the
  constraint were only in TypeScript.

### N05 — the named trap: "evidence-shaped text is not evidence"

Followed it end to end; it holds.

- Write side: `hypothesis:attachEvidence` (`handlers.ts:814-835`) checks the cited entity
  exists (`documents.getById` / `annotations.get`) **before** the edge is written, and the zod
  request restricts `sourceType` to `document | annotation` and `stance` to
  `supports | opposes`. Both refusals are asserted (`NOT_FOUND`, `INVALID_REQUEST`), and the
  refusal case then re-reads the page to confirm nothing was written.
- Read side: `notebookPage` (`handlers.ts:201-212`) resolves citations through
  `db.links.findReferences` — the *same* query the references panel and the graph use — which
  resolves the far endpoint through `EntityResolver.describe`
  (`packages/database/src/entity-resolver.ts:43-70`).
- The assertion that decides it: the supporting citation comes back with
  `otherTitle` containing the highlight's own words and a non-null `otherLocation`
  (`notebook.test.ts:563-566`). Those come from `describeAnnotation` — `selected_text` and
  `anchorToLocation(anchor)` — so an implementation that stored ids and echoed them cannot
  produce either. `otherLocation` cannot be vacuously `undefined`, because `ResolvedLinkSchema`
  types it `DocumentLocationSchema.nullable()` (present, nullable) and the router re-parses
  every response against its own contract outside production (`router.ts:153-163`).
- No second mechanism: evidence is an ordinary row in `links`
  (`document-opposes-hypothesis` etc., registered in `KNOWN_LINK_TYPES`), and
  `[N05] is an ordinary typed edge, reachable from the paper as well` proves the edge is
  visible from the *document's* side through `link:findReferences`, with the hypothesis
  resolving as a non-broken endpoint via `describeHypothesis`. No evidence table exists.
- `broken: false` is asserted on both citations, and `broken` is `described === null`
  (`links.ts:321`) — so it is derived, not stored.

### N06 — the desk board

- A card **is** the edge: `boardCards` (`handlers.ts:230-246`) reads
  `question-references-*` links and joins only the positions. There is no `cards` table; the
  only new table is `card_positions`, keyed by `link_id` with
  `REFERENCES links(id) ON DELETE CASCADE` (migration 008).
- `[N06] takes the card off the board by deleting the edge, and the position goes with it`
  asserts `SELECT COUNT(*) FROM card_positions` is 0 after `link:delete`. That only passes
  because `PRAGMA foreign_keys = ON` is actually applied
  (`packages/database/src/connection.ts:25`) — so this test doubles as proof of the pragma.
- "Nothing is stored until a hand moves it" is asserted twice, once through the page
  (`position: null`) and once through raw SQL (`COUNT(*) = 0`).
- Cross-board writes are refused: `question:placeCard` checks the link's `sourceId` equals the
  question (`handlers.ts:781-791`), and `positionsForQuestion` joins through `links` so a
  hand-written row on someone else's edge cannot surface (`board.ts:35-45`).
- A card whose document was hard-purged comes back `broken: true` rather than disappearing.
- Restart is real in both the integration test and the E2E (see F2's second paragraph).

### N07 — the named trap: "who supplies the path"

Followed it; it holds, and the design is stronger than the criterion requires.

- The path is produced by `webUtils.getPathForFile` **in the preload**
  (`apps/desktop/src/preload/index.ts:113`) and sent on `wr:drop` — a channel that is
  deliberately *not* on the bridge. The bridge still exposes exactly `invoke` and `subscribe`
  (`preload/index.ts:36-57`), so the page cannot address `wr:drop` at all; `bridge.invoke`
  wraps everything in the `wr:invoke` envelope, where `wr:drop` is not a contract channel and
  is rejected by `dispatch`. The E2E asserts exactly this (`board.spec.ts:257-293`), including
  that `/etc/hosts` reached no `document_files` row.
- `wr:drop` is still zod-validated in the main process before dispatch
  (`router.ts:49-58, 199-212`), bounded to 50 paths of ≤4096 chars.
- "Without leaving the disk": `LocalFileLibrary.add` (`local-files.ts:154-214`) stores the
  resolved real path and copies nothing; the integration test asserts same inode, same size,
  and no file of that name anywhere under the app's own directory.
- The price is paid honestly: adding a file **admits that one path** (`SwappableRoots.admit`,
  exact-match via `isAdmittedFile`, `paths.ts:101-104, 210-214`), never the folder. The test
  that proves it (`local-files.test.ts:136-152`) checks a sibling file in the same folder is
  still refused with reason `outside-roots`.
- The seam is not computed at both ends: the test calls `resolveAllowedPath(path,
  workspace.services.allowed)` — the *same function* `rrfile://` calls
  (`protocol.ts:249, 270`) with the *same live object* (`services.ts:192-200, 285`). Admission
  is persisted (`library.admittedFiles` setting) and re-applied at startup by
  `localFiles.restore()` (`services.ts:247`), and the restart test asserts the admitted file is
  readable afterwards while its neighbour still is not.
- The E2E closes the last gap by rendering the dropped PDF's first page over `rrfile://` in
  both the first and a second process, and by reading the stored path straight out of SQLite
  (`board.spec.ts:199-255`). The drop uses a `File` produced by the OS via
  `setInputFiles` (`tests/e2e/support/drop.ts`) — a JS-constructed `File` has no path, so the
  mechanism cannot be faked.
- I checked the inbox is genuinely outside every allowed root for the E2E workspace: roots are
  `zoteroDataDir`, `<agentRoot>/librarian`, `<dbdir>/card-art` and the corpus root — all
  siblings of `<workspace.dir>/inbox`, none containing it.
- `receiveDrop` refuses a drop on a nonexistent question **before** admitting anything, and the
  test asserts `remembered()` is empty afterwards, so a refusal cannot widen the allow-list.

### N08 — the named trap: "a feature nothing points at"

- The door is the question itself: the queue row's title is a button
  (`queue-panel.tsx:290-300`, `data-testid="queue-open-<id>"`) which runs
  `COMMAND_IDS.openNotebook` **through the command registry**
  (`queue-panel.tsx:163-172`) — the CLAUDE.md invariant "panels never manipulate each other
  directly" is kept.
- The page names its question: `notebook-question-title` renders `question.title`
  (`notebook-panel.tsx:250-252`), the panel's tab title is set from the loaded page
  (`notebook-panel.tsx:425`), and the E2E adds *two* questions and asserts the page shows one
  and `not.toContainText` the other — so a page that could be either fails.
- The unit half is real, not decorative: `panelSubjectKey` keys notebooks by `questionId`
  (`panel-targets.ts:48-50`) and the `[N08]` test asserts the second question *opens* rather
  than *reveals* the first. Keyed by kind alone the test fails.
- The command refuses to open with no question, naming what is missing
  (`workbench.ts:481-484`) — a legitimate guard, not a silent no-op.

### Invariants spot-checked for regression

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`
  unchanged (`apps/desktop/src/main/index.ts:178-190`); no `webSecurity: false` anywhere.
- Preload exposes exactly two functions; the drop listener *handles* rather than exposes.
- Every new channel (`question:notebook`, `question:writeNotebook`, `question:placeCard`,
  `hypothesis:*`) is defined with a zod request and response in the single contract file and
  dispatched through the single router; `wr:drop` is validated the same way.
- File bytes still reach the renderer only via `rrfile://<file id>`; the notebook cover follows
  that rule and migration 007 stores `cover_file_id REFERENCES document_files(id)`, never a path.
- All new relationships are typed directed edges in `links`; no untyped backlink or evidence
  table was introduced.
- No `any`, `as unknown as`, `@ts-expect-error` or `eslint-disable` was introduced anywhere in
  the milestone-4 diff for this scope (the only `as unknown as` hits are pre-existing
  `workbench.ts:172`, a deliberate null-injection in `layout.test.ts:217`, and `globalThis`
  casts inside `page.evaluate` in the E2E, which are unavoidable).
- `scripts/verify_completion.py` was only strengthened in this range: N09/N10/N11 and B05 were
  added to `E2E_TAGS`, and the B01 description was corrected to the replaced spec. Nothing was
  removed or loosened. N06/N07/N08 are in `E2E_TAGS` (their extra vitest tests only add
  coverage), N01–N05 in `UNIT_TAGS`; `check_tags` requires at least one *passing* tagged test
  and no failing one, and the whole vitest suite must exit 0.
- No skipped, `todo` or `fixme` tests exist in `tests/` or `packages/`.
