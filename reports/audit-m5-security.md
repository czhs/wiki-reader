# Milestone 5 — security audit (IPC surface, validation, `rrfile://`, the archive frame)

Audited-commit: f934770
Audited-milestone: 5
Range: `7796795..HEAD` (29 commits)
Lens: the IPC surface, zod validation, `rrfile://` roots, the sandboxed archive iframe, and
anything milestone 5 widened — regressions against the invariants in `CLAUDE.md`.

Method: read every diff touching `apps/desktop/src/main`, `apps/desktop/src/preload`,
`packages/shared-types/src/ipc.ts`, `packages/database/src/**`, and the readers; read the
new panels for injection sinks and path handling; read the tests that back `H01`, `P04`,
`H03` and the milestone-4 tests they replaced. Ran
`packages/workbench`, `packages/graph` (173 tests) and
`tests/integration/{security,highlight-links,journal}.test.ts` (26 tests) — all green. The
E2E suite was not run.

## Verdict

The headline security question of this milestone — *can a saved web page be highlighted
without loosening the frame that contains it* — is answered correctly. `packages/html-reader`
is untouched in the whole range: `sandbox=""`, `referrerPolicy="no-referrer"`, the served CSP
in `snapshotSecurityHeaders`, the remote-request cancel in `blocksRemoteRequest` and the
resource-bounding in `resolveFileRequest` are all exactly as milestone 4 left them. The
selection is taken from Chromium's context-menu parameters in the main process
(`main/index.ts:111-145`) and only a document id and the words cross back. No sandbox token, no
CSP relaxation, no second iframe, no `webSecurity` change. `verify_completion.py` gained two
lines and lost none.

No critical findings. No major findings. Four minor ones follow.

## Findings

### 1. `document:getSnapshotText` reads any library file whole, untyped and unbounded — minor

`apps/desktop/src/main/handlers.ts:658-672`. The contract
(`packages/shared-types/src/ipc.ts:381-399`) describes this channel as "the text of a saved
page's snapshot", and the renderer only calls it from the article panel. The handler enforces
neither half of that: it takes any `documentId`, resolves `files.primaryForDocument`, and does

```ts
text: extractHtmlText(await readFile(resolved.path, 'utf8')),
```

with no `docType` check and no size ceiling. The allow-list check above it is correct and is
the part that matters, so this is not a path escape and not a confidentiality escalation — the
renderer can already fetch the same bytes over `rrfile://<file id>`. What it is: a
renderer-triggerable whole-file read into the memory of the process that owns the database. A
300 MB PDF becomes a 300 MB+ string and then a second one inside `extractHtmlText`; the failure
mode is an OOM or a long stall of main, not a refusal.

The asymmetry is the argument. `snapshotResource` (`main/protocol.ts:310-327`) refuses a
non-HTML entry outright — *"only an archived page has resources"* — precisely so a PDF row
cannot be used as a handle on something it is not. This channel is the same question asked
again and does not ask it. Fix is two conditions: `document.docType === 'webpage'`, and a
ceiling on `file.byteSize`, which is already on the row.

### 2. The new `webpage:selection` topic is unbounded, broadcast, and has no negative test — minor

`packages/shared-types/src/ipc.ts:1162-1165` declares `text: z.string().min(1)` with no
maximum, published from `main/index.ts:144` through `router.publish`, which sends to every
window's `webContents` (`main/router.ts:239-241`). Every other size-sensitive field in this
contract carries a bound (`paths` is `max(4096)`/`max(50)`, `nodeLimit` is `max(300)`,
`limit` is `max(2000)`). A select-all on a large archived page ships the page's whole text to
every renderer on every right-click.

More to the point: `reportSnapshotSelection` is module-private in `main/index.ts`, which has no
test file, and the suite right-clicks exactly once — `tests/e2e/webpage.spec.ts:168`, the
positive path. Nothing asserts the three refusals the comment claims: a frame URL that is not
`rrfile://<file id>`, a URL addressing a resource *inside* a snapshot rather than its entry,
and a file whose document is not a `webpage`. The one new main-process capability of the
milestone is the one with no test for what it refuses. The refusals are real — I read them, and
`parseFileId` is covered — but they are held by construction only, in a file the verifier's
`ipcMain` rule does not reach and no unit test loads.

### 3. Subframe navigation is not locked, and milestone 5 made the frame URL load-bearing — minor

`apps/desktop/src/main/index.ts:103-108` binds `will-navigate`, which on Electron 33 fires for
main-frame navigations only; `will-frame-navigate` is the subframe event and is not bound. This
predates the range, and two other layers still hold: the app document's CSP is `frame-src
rrfile:` (`renderer/index.html:18`) and every remote request is cancelled in
`blocksRemoteRequest`, so a link in a hostile saved page cannot take the frame off the scheme.

What changed in this milestone is that the frame's URL is now an *identity*: the file id in it
decides which document a selection is attributed to. A link inside an archived page pointing at
an absolute `rrfile://dfl_.../` navigates the frame to another library file — the protocol
handler serves it, because it bounds resources to a snapshot but does not refuse cross-file
addressing at the top of a frame. The practical effect is small (the panel filters
`payload.documentId !== documentId`, so a mismatched selection is dropped and highlighting
silently stops working rather than attaching to the wrong paper), which is why this is minor
rather than major. Binding `will-frame-navigate` to refuse anything but the frame's own file
would close it and would cost one handler.

### 4. `[H01]`'s anchor always lands on the *first* occurrence of the selected words — minor

`apps/desktop/src/renderer/panels.tsx:669-682` builds the anchor with
`position: { start: 0, end: selection.length }`, because the selection comes from outside the
frame's world and carries no offsets. `locateNearest`
(`packages/document-model/src/text-quote.ts:57-76`) then picks the occurrence nearest the hint,
which for a hint of `0` is always the first — and `createQuoteSelector` takes the prefix and
suffix from *there*. Highlighting the second of two identical sentences stores an anchor whose
recorded position, prefix and suffix all describe the first one.

The comment in the panel names the trade honestly. The reason it is a finding anyway is that
nothing can see it go wrong: the archive is never painted (by design), the chip beside the page
shows `selectedText`, which is right, and `data-resolved` reads `"true"` because the anchor
does resolve — to the wrong sentence. `[H01]` asserts survival across restart and keeps that
promise; it cannot and does not assert placement. `CLAUDE.md`'s anchor invariant is about text
evidence that stays true, and here the evidence is true of a passage the reader did not mark.
The fix needs an offset hint out of the frame, which the sandbox forbids — so the honest
remedies are to record the ambiguity (`domFallback`, or a confidence marker) or to accept it
and say so in `state/DECISIONS.md`.

### 5. `notebook:directory` reads every day's markdown to count days — minor (efficiency)

`apps/desktop/src/main/handlers.ts:905-915` calls `db.journal.loggedDates(notebook.id)` per
notebook, which routes through `list()` — `SELECT *` plus a zod parse per row
(`packages/database/src/repositories/journal.ts:63-84, 95-101`). Mounting the directory page
therefore reads and validates the full markdown of every entry of every notebook in the
library, to produce a count and a maximum date. `JournalRepository.count()` (journal.ts:116-121)
was added in this milestone with the comment *"The directory's count (`P01`)"* and is called
from nowhere in the tree. The cheap path was written and then not used.

## Checked and clean

- **Preload** (`preload/index.ts`) still exposes exactly `invoke` and `subscribe` and nothing
  else. The new journal drop target is read off the DOM *in the preload's world* and its value
  (`<notebook id>:<date>`) is re-validated in the router against `QuestionIdSchema` +
  `JournalDateSchema` (`router.ts:63-66`). `wr:drop` remains unexposed and zod-validated.
- **No path crosses the boundary.** `grep` over `packages/shared-types/src/ipc.ts` finds no
  path-shaped field; `P04` writes `![title](rrfile://<file id>)` into the day's markdown *in
  main* (`handlers.ts:117-152`, the reference built at line 138), and the E2E test asserts the
  panel's markup contains neither the file name nor the workspace directory
  (`tests/e2e/journal.spec.ts:425-430`).
- **`rrfile://` roots are not widened by `P04`.** A dropped picture goes through
  `LocalFileLibrary.add`, which `realpath`s and admits **the single file**, capped at
  `MAX_ADMITTED_FILES`. `protocol.ts` is unchanged in the range.
- **Router** still validates every request before dispatch, re-checks responses outside
  production, maps errors to a code without leaking a message, and holds the only two
  `ipcMain.handle` calls. The removed `CHANNEL_NAMES` export had no callers at `7796795`.
- **New channels** (`graph:overview`, `graph:focus`, `link:findForDocument`,
  `notebook:directory`, the reshaped `journal:*`) are capped in the contract and all their SQL
  is parameterised; `graph:overview` deliberately has no default `nodeLimit`.
- **No injection sinks.** No `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `eval`,
  `new Function`, `window.open` or `location.assign` anywhere in `apps/desktop/src/renderer` or
  the renderer packages. Journal blocks render through `renderMarkdown`, which builds React
  elements, escapes raw HTML into a `<code>` block, and passes every URL through `safeHref`
  (unchanged, `rrfile:` was already allowed).
- **One iframe in the tree**, `HtmlReaderView.tsx:182`, untouched by this milestone.
- **`webPreferences`** unchanged: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webviewTag: false`, no `webSecurity: false`. No `shell.*`, no
  `openExternal`, no `focus()`; `WR_BACKGROUND=1` is still set on every E2E launch
  (`tests/e2e/support/app.ts:61`).
- **Renderer boundary**: no new import of `electron`, `better-sqlite3`, `@wr/database`,
  `@wr/zotero-adapter` or a node builtin in any renderer root.
- **Migration 012** keys the journal by `(notebook_id, date)` with a real foreign key, rewrites
  existing `links` endpoints rather than orphaning them, and mints its adopted notebook's id
  from `hex(randomblob(13))`, which the `qst_` id schema accepts. No day is dropped.
- **No tests were deleted to make this milestone pass.** `[J01]`, `[J03]`, `[N10]`, `[N11]`
  all still have passing tagged tests after the journal was re-keyed; no `.skip`, `.todo` or
  `.fixme` exists anywhere in the suite.
- `packages/database/src/repositories/graph.ts` stopped being a binary blob to git (two NUL
  bytes at `7796795`); that is a fix, not a regression.

## Not in this lens

Correctness of `F01`–`F03`, `D01`/`D02`, the keyboard scheme and the help page's coverage were
read only far enough to confirm they add no privileged surface. `reports/DESIGN_GAPS.md`
already carries the vision-alignment questions.
