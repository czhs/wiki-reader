# Independent audit — milestone 4

Audited-commit: c072375f828c026e4f2f1fdafef3433df0cd0441
Audited-milestone: 4

Brief: falsify "milestone 4 is complete and safe". Four auditors read disjoint lenses against
`fde3e38..c072375` — the field notebooks (`N01`–`N08`), the journal and the link/note surfaces
(`N09`–`N11`, `K01`–`K03`), the library and the graph (`B01`–`B05`, `G01`–`G03`, `G06`), and
the security surface the milestone added (`G04`, `G05`, the drop and add-file paths, the IPC
router). None of them was the context that built the code. Their full working is in
`reports/audit-m4-notebooks.md`, `audit-m4-journal-links.md`, `audit-m4-library-graph.md` and
`audit-m4-security.md`, including the traces that ended in "I followed it and it holds".

Every criterion was green and the whole suite passed before the audit began, so nothing here
was found by running the tests. Each finding below was confirmed at the source and then
re-confirmed by mutation: the fix was reverted, the new test was watched to fail, and the fix
was restored.

## Findings — milestone 4

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | major | **A routine import silently undid the researcher's curation.** `zotero:import` falls back to the remembered picks when no collection is named (`handlers.ts:367`), and the importer's only test for "the researcher asked for this" was `scoped: scopeKeys !== null` (`importer.ts:303`), which then lifts the removal. So once any standing scope was ticked — the ordinary state of the app — the plain Import button was a *scoped* run, and every removal inside those collections came back. `[B01] a routine import leaves a removal alone` passed only because its fixture never wrote `zotero.importScope`. This is the exact failure `importer.ts:246-250` promises against: "no sync that quietly undoes a morning's curation", and the blacklist problem wearing the opposite face. | Fixed — the caller now says where the scope came from (`ScopeOrigin`, `'named'` vs `'remembered'`); only a collection named in *this* action lifts a removal. New test `[B01] a routine import leaves a removal alone even when the picks cover it` sets the standing scope to the victim's own collection, and asserts both halves: the routine run leaves it removed, and naming that same collection still brings it back. |
| 2 | major | **"Its text is queued to be searchable again" was a no-op.** The restore path enqueues an `index-fts` job (`importer.ts:415`) and nothing has ever drained one: the only consumer claims `'extract-text'` (`pipeline.ts:102`), and `workers/indexing` is a declared stub. `[B01]` cited that queued row as its evidence, so "queued to be reindexed" and "never reindexed" had the same observable. Because `library.remove` drops *every* entry carrying the document id, annotations included, a restored document stayed unfindable and its highlights stayed unfindable permanently — the researcher's own words, lost from search while the paper sat back on the shelf looking whole. The local-file restore path (`local-files.ts:173`) queued nothing at all. | Fixed — `SearchIndexer.reindexDocument` re-projects the document record, its chunks and its annotations from rows that never left; the pipeline drains `index-fts`; the local-file restore enqueues one too. `[B01]` now drains and searches instead of reading the queue, and a new `[B03] a highlight answers searches again once the paper is back` asks through `search:query` for the words the researcher selected. |
| 3 | major | **Card art's "one allow-listed host" was enforced on the first hop only.** `#request` checked `new URL(url).host` against the constant and then passed `redirect: 'follow'`, with nothing reading `response.url`. The bytes, the content type and the destination could all come from whatever a `Location` header named. Not theoretical: `artUrl` asks for `format=image`, which Scryfall answers *with a redirect*, so following an unchecked hop was the normal path, and the picture arrived from a host named in neither the disclosure, `docs/SECURITY.md` nor `README.md`. A `Location: http://…` was followed too, and main-process `fetch` is Node's, so the window's request blocker never sees it. | Fixed — redirects are followed by hand with the allow-list applied to **every** hop, scheme and port included, bounded at three. The image CDN is now named as what it is (`CARD_ART_IMAGE_HOST`), and the disclosure, `README.md` and `docs/SECURITY.md` all name both hosts, because the honest fix was to disclose the request the app actually makes rather than to keep a bargain that described a different one. Three new `[G05]` tests: the real one-hop path is followed, a hop off the list is refused *before* the second request is made, and `http:` or a port of its own is refused. |

No critical finding was raised, and no major finding remains open.

### Minor findings left open, with reasons

Recorded rather than fixed; none bears on a criterion's evidence, and each is named so its
absence is not mistaken for coverage.

- **A setext heading spanning two lines leaks its underline into the section body**
  (`notebook.ts:95-104`): `endOfHeading` hard-codes a two-line setext heading. No `[N02]` test
  uses setext at all. Proved by execution against the built module.
- **`[N06]`'s anti-regression guard does not discriminate**: `expect(placed.x + placed.y)
  .toBeGreaterThan(0)` (`board.spec.ts:139`) is satisfied by the *un-dragged* default
  `defaultSpot(0) = {16,16}`, so an implementation that committed a card's pre-drag position
  on pointer-up would pass the whole spec. The comment above the line names this failure mode.
- **Two of the six things `N03` names have no way in**: `importance` is never displayed and
  `coverFileId` can never be set from the running app. The criterion is integration-kind and is
  met through the real router, but by the milestone's own `N08` principle these point nowhere.
- **`N10`'s trap is not discriminated by any test**: the shipped `projectStart()` correctly
  reads `MIN(applied_at)` from `schema_migrations`, but substituting `firstDate() ?? today`
  leaves all four assertions passing. `runMigrations` takes an injected clock, so telling "when
  the project began" from "when the first entry was written" was feasible.
- **An empty code block marks an unlogged day as logged**: `EMPTY_CODE_BLOCK` does not trim to
  empty, so `serializeBlocks`' "a block nobody typed into is dropped" is false for `+ code`.
- **Writing a day then switching days in one gesture leaves the calendar marker stale**
  (`journal-panel.tsx:210-217`): the write lands, the bubble does not update.
- **The 8 MB card-art cap bounds the disk, not the process**: the cap is checked after
  `arrayBuffer()`, and undici decompresses transparently — measured at 65,250 bytes on the wire
  expanding to 67,108,864 in heap.
- **`SwappableRoots.withdraw` has no caller**: the admitted-file allow-list is monotonic, so a
  removed local document's path stays readable for the life of the installation.
- **`question:update.coverFileId` checks that the file exists but not that it is an image**,
  where `graph:setNodeIcon` checks both.
- **Four new channels take `entityId: z.string().min(1)` with no maximum**, and
  `graph:setNodeName` writes without an existence check — the same gap `docs/SECURITY.md`
  already records for `link:create`.
- **Three tests tagged `[B05]` test environment-variable parsing, not importing a collection.**
  `B05` is an E2E tag, so the verifier reads the real evidence at `library.spec.ts:223`; the
  tags on the unit tests are wider than what they exercise.

### What was checked and held

Named here because a verified invariant is worth as much as a finding, and because the next
session should not re-derive them.

- `B04`'s hash covers a real, openable `zotero.sqlite` at exactly the path the services are
  built with — sha256, size, mtime, and the absence of `-wal`/`-journal`.
- The `B01` blacklist is genuinely gone: no `listRemoved`, no `restoreDocument`, no Removed
  list, no stale table and no test still asserting the replaced behaviour.
- `N05`'s trap is closed. Citations resolve through the same `findReferences`/`EntityResolver`
  the references panel uses, and the test asserts the highlight's own words plus a non-null
  anchor-derived location, which an id-echoing implementation cannot produce.
- `N07`'s seam is real and not computed at both ends: the path comes from
  `webUtils.getPathForFile` in the preload over `wr:drop`, which is genuinely off the bridge,
  and admission widens the allow-list by exactly one file. The E2E proves `/etc/hosts` lands
  nowhere.
- `G03` asserts the document title unchanged *in the database* after a `force` re-import.
  `G06`'s parentage comes from the graph query, is withheld when the container was not sent,
  and uses real Cytoscape compound nodes.
- `K02` asserts both of an annotation's edges and identifies each by relationship. `K03` is a
  live rendering: `search('')` returns every registered command uncapped, the test iterates the
  real `DEFAULT_KEYBINDINGS`, and the list is opened by clicking rather than by chord.
- `N11` has one store, structurally: no block table in any migration, and `commit()` re-parses
  the markdown the main process answered with. `N09` measures the page against a real reader,
  and `toggleJournalSidebar` is gone from the type union, so a regression would not compile.
- `rrfile://` containment re-verified **by execution** against the real `paths.ts`: traversal,
  a prefix-collision root, a planted symlink, a sibling of an admitted file, the containing
  directory, relative paths, NUL and `%2e%2e` — all refused.
- No channel accepts a filesystem path or a URL; `ipcMain` appears only in `router.ts`; no new
  loose zod; `contextIsolation`, `sandbox` and `nodeIntegration` unchanged; and no `any`,
  `as unknown as`, `@ts-expect-error` or `eslint-disable` anywhere in the milestone-4 diff.

## Gates after the fixes

`pnpm typecheck` 0 · 650 unit tests in 53 files, 0 failures (645 before; the three fixes added
five tests) · `pnpm test:e2e` 65 specs, 0 failures.

---

# Independent audit — milestone 3

Audited commit (milestone 3): f6fbede0099d8f5e0348ff87f194b09f73a9d232

The tree the auditor read, deliberately not HEAD: fifteen findings were opened against
`f6fbede` and the commits after it are the fixes. The full working is kept in
`reports/audit-m3-security.md` — every trace, including the ones that ended in "this is safe",
because "I followed it and it holds" is worth as much as a finding.

Brief: falsify "milestone 3 is complete and safe". Scope: the librarian surface —
`main/agents/*`, the IPC router and handlers, `protocol.ts`, `paths.ts`, `services.ts`, the
renderer panel that drives them, and the tests that claim to cover them. The `[A01]` stream
buffering defect was excluded, having already been diagnosed and fixed in `5ff789b`.

## Findings — milestone 3

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | critical | `agent:progress` published **absolute filesystem paths** to every renderer and painted them on screen, falsifying `CLAUDE.md`'s "the renderer never receives or builds a filesystem path" and `docs/SECURITY.md:14,32`. Both free-text fields leaked: tool targets, because Claude Code's `Read` takes an absolute `file_path`, and message prose, because the model narrates its own working directory. The topic's own contract claimed a relative form. | Fixed — `withoutFilesystemPaths` (`main/paths.ts`) reduces each path to root-relative or basename; `AgentServices.progressRoots` names the roots once so a publisher cannot omit them. `tests/integration/agent-progress.test.ts` runs the real recorded transcript and finds none; it caught nine before the fix. |
| 2 | major | The materialised wiki — full text of every document, every highlight and comment, every question and journal entry — was **never removed in production**. `WikiView.remove()` had no non-test caller. `README.md:16` and the disclosure's withhold line are read by someone deciding whether they can change their mind, and neither was true of switching back off. | Fixed — `agent:enable{false}` awaits `view.remove()` after stopping the timer and cancelling runs. Asserted by running a real pass, checking the copy exists, then switching off. |
| 3 | major | **TOCTOU in `agent:accept`**: the pending check sits two awaits before the state change, so two concurrent accepts both passed it. The proposal row is protected by `WHERE status = 'pending'`; `documents.create` is not, and `documents_slug_idx` is not unique — so a double click minted a second document and `upsertByPath` orphaned the first, leaving a librarian note with citation edges and no file, in the library and the graph, unopenable. | Fixed — `LibrarianService.accept` shares its in-flight promise per proposal id. A later accept still fails the status check. |
| 4 | major | **"One pass at a time" had a race window spanning `materialise()`** — `runner.busy` reads the map the spawn populates, so it was false for the whole of the expensive part. Two runs inside it both passed the guard, both rebuilt the wiki on one root with one `rm -rf`ing while the other sealed, and both spawned a `claude`. | Fixed — `LibrarianService.busy` is true from the moment a pass is entered. Both readers of the stale flag were corrected: the `agent:run` guard and `observe()`, which is what `decidePass` reads. |
| 5 | major | **`A02` asserted a door the agent does not use.** Every test exercised `AgentWorkspace`, which bounds the writes the *app* makes; the spawned `claude` writes with its own tools and never calls it, despite the class header saying "there is no other path". No test had the child attempt an escape. | Fixed — `fake-claude.mjs` now writes into every `--add-dir` root it was given and records the errno; the test asserts the kernel refused each one and no file landed. `ENOENT` is excluded, because an absent wiki would refuse those writes too. The outer boundary is a third party's and is now named as such rather than implied to be covered. |
| 6 | major | **`A13`'s "a pass that finds nothing writes nothing" passed on the wrong cause.** The recorded run *did* produce a finding; it landed in the run-directory root, where `harvest` does not look. "Found nothing" and "wrote it where nobody reads" have the same observable from those assertions. | Fixed — the pass is genuinely quiet now, and a new assertion fails if any markdown the child wrote is left anywhere in the run directory. Checked against the old behaviour: it catches the historical defect. |
| 7 | major | **No test harvested a real agent's output.** Every proposal was hand-staged into a path the test computed itself, so both ends of the write/read seam were the test's arithmetic — the same seam finding 6 showed was broken in the only recording that exists. | Fixed — the child writes to `./proposals/` relative to the working directory the runner gave it, which is what the task instructs, and the real `ProposalReader` finds it. The recorded argv is asserted to still carry that instruction, so a change to either end goes red. |
| 9 | minor | **`docs/SECURITY.md` had no milestone-3 content**, and two of its lines were false. | Fixed — threat-model rows for prompt injection through a hostile saved page and for the child process; four invariant rows; four gaps stated plainly, including the ones below. |

No critical or major finding remains open.

### Minor findings left open, with reasons

Each is recorded in `docs/SECURITY.md` where it bears on the threat model.

- **8 — the `rrfile://` allow-list holds the whole agent workspace**, not just the `notes/`
  directory accepted proposals land in, so `.runs/` staging is inside the served root. Traced
  and not reachable: `rrfile://` takes file ids, not paths, and the only code that mints a row
  under this root does so for `notes/*.md`; the corpus importer skips dot-entries. A widened
  seam, and narrowing it is a change to the root wiring rather than a fix to a hole.
- **10 — the child inherits the whole main-process environment.** Real, and the honest
  mitigation is an allow-list of variables the CLI needs, which is a behaviour change to a
  third-party spawn best made with a live `claude` to test against.
- **11 — a child that ignores SIGTERM wedges the librarian.** No SIGKILL escalation and no
  settle-on-timeout, so `busy` stays true and every later pass is refused. A real availability
  defect, bounded by the app's lifetime and needing no data recovery.
- **12 — `WR_AGENT_EXECUTABLE` names an arbitrary binary to spawn.** Same class as
  `WR_DATABASE_PATH`; an attacker who can set the environment can already run code.
- **13 — no size or count cap on harvested proposals.** Every staged `.md` is read whole into
  memory while the run summary is capped at 4000. One enormous file is a main-process OOM.
- **14 — `A03`'s E2E observable is sound by ordering, not by construction.** `<agentRoot>/wiki`
  catches a spawn only because `pass()` materialises before spawning. The main-process side of
  `A03` is asserted directly in `agent-channels.test.ts`; what is missing is a spawn counter in
  the E2E.
- **15 — dead clause** at `workspace.ts:220`: `parent !== root` is unreachable because
  `isInsideRoot(root, root)` is `true`. Harmless.

### What was traced and found sound

Stated because a trace that ends in "it holds" is evidence too. Full working in the lens file.

- **`A03`, off means off.** No path from a fresh launch to `materialise()`, a spawn,
  `scheduler.start()` or the network with agents disabled. Double-gated: `decidePass` returns
  `disabled` *and* the timer is never armed. Enabling is gated on the disclosure at the channel,
  not in a component. The only outbound primitive with agents off is the Zotero loopback client.
- **Path traversal via `agent:accept`.** The renderer supplies only a constrained id; the
  written path is `notes/<[a-z0-9-]{1,60}>-<6 chars of a minted id>.md`. `resolveWrite`
  independently closes empty/NUL, absolute, lexical `..`, and symlink-through-an-existing-
  ancestor, each asserted with an escape attempt rather than a happy path.
- **One router, zod before dispatch, `contextIsolation`/`sandbox`/`nodeIntegration`, the
  two-function preload, the renderer import boundary.** All hold; no `any`, no
  `eslint-disable`, no `as unknown as` anywhere in milestone-3 code.
- **`A11`, no retrieval.** No `@wr/search` import in the agent path; whole documents by
  chunk-index concatenation with no limit or ranking; no web tool; `--strict-mcp-config` with
  no MCP config.
- **Agent-authored markdown cannot become HTML.** No `dangerouslySetInnerHTML` or `innerHTML`
  in the reader packages or the renderer.
- **The agent cannot choose which table a citation resolves against** — the type comes from the
  id prefix. And the front-matter reader is two hand-parsed forms, not a YAML deserializer.

### Gates after the fixes

`pnpm typecheck`, `pnpm lint`, `pnpm test` (549 in 46 files) and `pnpm test:e2e` (45) all pass.
Each fix was written test-first, and the three that guard a race or a boundary were checked in
both directions — the guard removed must make them red. Two were rewritten after that check
showed they passed anyway: the accept race reproduced only three times in six as a plain race,
and the first barrier that made it deterministic released its writer too early to open the
window at all.

---

# Independent audit — milestones 1 and 2

Audited-commit: 4420cea8ee5998fddae26db66c0c795c9c8852ba

Milestone 2 is audited below at `4420cea8`; the milestone-1 audit at `fa5672a8` is kept after
it. Two findings were opened against `4420cea8` and fixed in the commits that follow it, so the
audited commit is deliberately not HEAD — what it names is the tree the auditors read.

## Milestone 2 (W01–W12)

Brief: falsify the claim that milestone 2 is complete. Two lenses, run independently, each
keeping its full working:

- `reports/audit-m2-tests.md` — test honesty: does each tagged test exercise the criterion its
  tag claims? Findings proved by mutating production code and re-running the suite.
- `reports/audit-m2-security.md` — the security and architecture invariants in `CLAUDE.md` and
  `docs/SECURITY.md`, against the source rather than the docs' claims about it.

### Findings — milestone 2

| # | Sev | Finding | State |
|---|-----|---------|-------|
| W-1 | major | `[W11]` built its own copy of the popover's edit handlers, so no-op'ing `AnnotationsView`'s handlers left all seven `[W11]` tests green — the criterion says the colour is changed *from the popover* | closed — the wiring moved to `apps/desktop/src/renderer/annotation-actions.ts`, one definition used by both panel and test; the same mutation now fails `[W11] changes the colour from the popover` |
| W-2 | major | Nothing drove `zotero:import`, so the channel's zod contract and the handler that forwards `collection` were asserted by nothing: the handler could drop the scope and every `[W12]` test would still pass | closed — `tests/integration/zotero-import.test.ts` drives the channel over the real router; dropping the scope in the handler now fails 3 of its 4 tests |
| W-3 | minor | `packages/graph/src` is renderer-consumed (`graph-panel.tsx:16`) but was absent from `RENDERER_SOURCE_ROOTS`, so the forbidden-import rule never reached it | closed — added to `scripts/verify_completion.py`; the package was already clean |
| W-4 | minor | `protocol.ts:258-279` gates snapshot containment on `resourcePath !== ''`, so `rrfile://<file-id>/` is served to a snapshot frame; the comment at `protocol.ts:342-343` overstates the guarantee | open — no exfiltration path (scripts off, opaque origin, remote requests cancelled); the overstated comment is the defect |
| W-5 | minor | `[W10] sends no edge whose other end was withheld` cannot fail — the frontier loop cannot produce the half-edge it describes; removing the edge filter left it green | open — the node-cap test does catch the real elision bug |
| W-6 | minor | `[W03]`/`[W05]` archived pages are markup written by the harness; no recorded snapshot fixture exists | open — the harness writes real files with real CSS and images to disk and the assertions are a computed font and a non-zero `naturalWidth`, which a fallback rendering cannot satisfy; a recorded snapshot would still be better evidence |
| W-7 | minor | `[W01]`'s `rrfile://` test asserts the response shape without performing the fetch; `[W06]`'s resolution test resolves against a hand-built `Map` (the real coverage is untagged, `corpus.test.ts:96`); no test asserts a non-default colour is painted in a reading view | open — each names a seam the tag claims more of than it proves |

No critical finding was raised. Both major findings are closed, each with a mutation that fails
the suite as it now stands and passed against the code as it was. The minor findings above stay
open with their reasons; none of them blocks a criterion.

### What the mutations showed

The suite caught, unprompted: the `[W02]` lost-highlight fallback (a mutation found in the
working tree at the start of the session — resolving a lost anchor to its stored offsets rather
than reporting it lost), the `[W07]` `source_id` delete bug, the `[W10]` node cap, and the
`[W12]` scope filter. `[W04]` is the strongest suite in the milestone. The two majors above are
the cases where a mutation went unnoticed.

### Gates at the fixed tree

`pnpm typecheck` 0 · `pnpm lint` 0 · 432 unit tests in 32 files, 0 failures · 17 E2E specs
against a real Electron launch, 0 failures.

---

# Independent audit — milestone 1

Audited-commit: fa5672a823e48faa1c3376672f97ad25551e8f7f

Brief: falsify the claim that milestone 1 is complete. Specifically — tests that assert
nothing meaningful, criteria satisfied by mocks where real integration was feasible, regressed
security invariants, `any` reintroduced, stubs presented as working, and tests tagged with a
criterion ID that do not exercise it.

Two lenses were run against the source tree, the built artefacts and the running suite. Their
full working is kept rather than summarised away:

- `reports/audit-security.md` — the security and architecture invariants in `CLAUDE.md` and
  `docs/SECURITY.md`. 9 findings (3 major, 6 minor).
- `reports/audit-tests.md` — test honesty: does each tagged test exercise the criterion its tag
  claims? 8 findings (3 major, 5 minor), three of them proved by mutating production code and
  re-running the suite.

Every critical and major finding is closed, each with a test that fails against the code as it
was. The minor findings still open are listed below with the reason.

---

## Findings

| # | Sev | Finding | State |
|---|-----|---------|-------|
| S1 | major | Remote-request block bypassable by any host prefixed `localhost`; `ws://`/`wss://` never intercepted | closed — `fafc6cb` |
| S2 | major | `rrfile://` and the extraction pipeline checked paths lexically, so a symlink inside an allowed root read bytes from outside it | closed — `fafc6cb` |
| S3 | major | `docs/SECURITY.md` threat model said hostile PDFs are parsed in the main process; the reading view parses them in the renderer | closed — `4ab6c28` |
| T1 | major | `[L03]` was satisfied by a test that never listed a reference | closed — `f460aee` |
| T2 | major | `[L04]` asserted a pass-through, not a listing | closed — `f460aee` |
| T3 | major | `[T05]` claimed "HTML text normalization" while every test fed plain strings or PDF text items | closed — `f460aee` |
| S4 | minor | `docs/SECURITY.md` §2 and its gaps list described a preload and a router that no longer exist | closed — `4ab6c28` |
| S7 | minor | The renderer-boundary gate never scanned `apps/desktop/src/renderer` | closed — `4ab6c28` |
| S8 | minor | No `setPermissionCheckHandler`; synchronous permission checks fell back to Chromium defaults | closed — `4ab6c28` |
| S9 | minor | Navigation hardening was per-window; the dev allow-check was a prefix match | closed — `4ab6c28` |
| S6 | minor | `zotero:import` returned raw `Error.message` text to the renderer | closed — `fa5672a` |
| T4 | minor | A `[T05]` test asserts on a compile-time constant | open — accepted |
| T5 | minor | A `[T07]` test is vacuous in isolation | open — accepted |
| T6 | minor | A `[T04]` test computes its expectation with the function under test | open — accepted |
| T7 | minor | No `[M04]` test reaches the real `hashFileOnDisk` probe | open — accepted |
| T8 | minor | Nothing joins the M14 store round-trip to the renderer's serializer | open — accepted |
| S5 | minor | Five IPC request fields are `z.unknown()`; link ids and types are unconstrained strings | open — recorded in `docs/SECURITY.md` |
| — | minor | TOCTOU window between `realpath` and `open` in `rrfile://` | open — recorded in `docs/SECURITY.md` |

### The three major security findings

**S1.** `callback({ cancel: !details.url.startsWith('http://localhost') })` admitted
`http://localhost.attacker.example/` — a public, DNS-resolvable host that merely shares the
prefix. This is the same collision `isInsideRoot` was written to prevent for paths, 260 lines
away in the same process. The filter also listed only `http://*/*` and `https://*/*`, so
`ws://` and `wss://` were never handed to the handler. `isLoopbackUrl` now parses the URL and
compares `hostname`; the filter covers all four schemes. CSP would have stopped the request
first in a packaged build — the finding is that the layer documented as the outright block
was not one.

**S2.** `isAllowedPath` compares strings. `stat` and `createReadStream` follow symlinks, and
`grep -rn realpath` over the repository returned zero hits, so a row pointing at
`<zoteroDataDir>/storage/ABCD/paper.pdf`, where that entry is a symlink to `~/.ssh/id_rsa`,
passed the check and was streamed to the renderer with `200 OK`. The same gap sat in the
extraction path. `resolveAllowedPath` now resolves the candidate and re-checks containment
against roots that are themselves resolved, and returns the real path so callers open what was
checked — checking one path and opening another is the hole itself. The adversary must already
be able to place a symlink under the library, which is precisely the tampered-data adversary
the module claims to defend against.

**S3.** A documentation defect, and the most consequential one: `CLAUDE.md` names
`docs/SECURITY.md` as the authority for these invariants, and on the primary row of its threat
model it described a different architecture — parsing in the main process, the renderer
receiving only extracted text and page images. The reading view calls `getDocument` on an
`rrfile://` URL in the renderer and starts a PDF.js worker there. The implementation is
defensible; the document could not be used as evidence about it. Rewritten, along with the
stale claims that the preload exposes a `platform` string, that nothing asserts the bridge's
shape, and that responses are not validated on the way out.

### The three major test findings

All three came from the same question: if the production function returned a constant, would
the tagged test notice?

**T1/T2.** `LinkRepository.findReferences` and `findByType` were each replaced with `return []`
and the suite re-run. `[L03]`, `[L04]` and the unit `[L08]` stayed fully green; only `[L10]`
and `[M13]` caught it. Both tests supplied a value and asserted the same value arrived at a
fake host one call later — no link existed in either test, and `FakeHost.resolveLinks` returned
an array the test never populated. Both criteria are classified `integration` in
`docs/MILESTONE.md`, so they now run over the real router into the real store: a three-document
citation graph in which the edge touching neither end of the queried entity must not come back,
direction narrowing checked in both directions, type narrowing checked against a second type
over the same pair of endpoints, and `otherTitle` asserted because that is what the panel
renders. Re-running the same mutation now fails four of them. The workbench unit tests keep
the command wiring but assert what reached the panel, and `[L03]` resolves `shift+f12` through
`DEFAULT_KEYBINDINGS` rather than calling a command the criterion does not name.

**T3.** Thirteen tests carried `[T05]`; every one fed a plain string or a PDF.js text-item
array to `normalizeText` or `joinPdfTextItems`. No HTML fragment passed through anything,
because there was no HTML-to-text function in the codebase to test. Narrowing the tag's
description to match would have moved the goalposts — T05 is a milestone-1 criterion — so the
function was written: `extractHtmlText` in `@wr/document-model`. It is a scanner rather than a
regex sweep because archived HTML is hostile input and `/<[^>]*>/g` emits `b">text` as prose
given `<a title="a > b">text</a>`. Script and style content is skipped in its own tokenizer
state so `if (a<b)` is not read as markup, character references are decoded after tag removal
so escaped markup in prose survives, inline element boundaries add no whitespace (a space there
puts every anchor spanning a styled word out by one), and source line-wrapping folds while
`<pre>` keeps its structure. Twelve tests, including one asserting that the same sentence
extracted from HTML and from a PDF text layer normalizes identically — the invariant that makes
an anchor portable across representations.

### Minor findings left open, with reasons

- **T4, T5, T6** are weak assertions inside tags whose other tests are load-bearing.
  `NORMALIZATION_VERSION > 0` cannot fail except by editing the constant; the `[T07]`
  chunk-index comparison is vacuous if the chunker returns `[]`, but a sibling test at
  `packages/search/test/chunking.test.ts:75` supplies the length floor; the `[T04]` assertion
  uses `normalizeText` on both sides, which is separately pinned by literal expectations. Each
  is a test that adds nothing rather than one that gives false credit.
- **T7** — no `[M04]` test reaches the default `hashFileOnDisk` probe; every importer test
  injects a stub. It *is* exercised over real files by `tests/e2e/support/workspace.ts`, which
  asserts `filesMissing === 0`, but that seeding runs under `[M05]`.
- **T8** — `[M14]` round-trips a layout through the store and `[T10]` round-trips the
  serializer, but nothing covers the renderer code that joins them, and no E2E spec restarts
  the app. `docs/MILESTONE.md` classifies M14 as integration, so this is a coverage gap rather
  than a rule violation.
- **S5** and the `rrfile://` TOCTOU are recorded in the gaps list of `docs/SECURITY.md` so they
  are visible where the invariants are documented rather than only here.

---

## What was checked and found sound

Recorded because a report of only defects says nothing about coverage. Full evidence with
file:line citations is in the two lens reports.

- **Window flags.** One `BrowserWindow` construction site in the tree, with
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`. No
  `BrowserView`, `WebContentsView`, `openDevTools` or `<webview>` anywhere. No `webSecurity`,
  `allowRunningInsecureContent`, `nodeIntegrationInSubFrames` or `experimentalFeatures` in any
  source file. The built artefact in `out/main/index.js` matches the source, which matters
  because the verifier only greps `src/`. Proved at runtime, not by grep: `shell.spec.ts`
  asserts `require`, `module`, `process` and `electron` are `undefined` in the main world.
- **Preload.** 35 lines, one `exposeInMainWorld`, exactly two methods, neither of which lets
  the renderer name a channel. The built `out/preload/index.cjs` is equivalent. `subscribe`
  returns a real unsubscribe closure.
- **IPC.** Exactly three `ipcMain` references in the repository, all in `router.ts`. Validation
  order is structural check → own-property channel lookup (so `constructor` and `__proto__` are
  not channels) → zod `safeParse` → dispatch. No `passthrough`, `catchall` or `z.any()` in
  `shared-types` or the app. `toIpcError` collapses anything unrecognised to
  `{ code: 'INTERNAL' }` and maps `SQLITE_` to a generic database error. Outbound events are
  validated against `IPC_TOPICS`.
- **Path traversal via `rrfile://`.** `parseFileId` requires an empty pathname and matches the
  id against Crockford base32 *after* decoding, so `..`, percent-encoding, double-encoding,
  absolute paths and NUL bytes all fail. The surviving id is only ever a bound SQL parameter.
  `isInsideRoot` was verified by executing it, not by reading it: traversal, prefix collision
  and macOS case variance all return false, the last being a fail-closed false negative.
- **The renderer never receives a filesystem path.** Traced end to end: `DocumentFileRefSchema`
  omits `path` and requires an `rrfile://` url, `toDocumentFileRef` is the only construction
  site and re-parses through the schema, no other response schema carries a path, and no
  renderer source builds a URL.
- **Renderer boundary.** Zero forbidden imports across all six renderer packages and
  `apps/desktop/src/renderer`, checked at the manifest level too, with transitive re-export
  through `@wr/shared-types` and `@wr/document-model` checked rather than assumed.
- **Zotero is read-only.** The client is HTTP-only against `127.0.0.1:23119` with one call
  site, and its injected `fetch` type cannot express a `method` — a non-GET request is a type
  error, not a review question. No write API is imported anywhere in the adapter.
- **Fixtures are recorded, not invented.** The Zotero fixtures are genuine local-API envelopes
  parsed through the same schema the client uses; the fake is a `fetch`, so pagination, headers
  and error mapping all run for real. `tests/fixtures/sample-paper.pdf` is a real 3-page PDF
  genuinely parsed by `pdfjs-dist/legacy`.
- **The restart criteria really restart.** `Workspace.restart()` closes the database and opens
  a fresh connection against the same file; anything held in memory is gone by construction.
- **M08, M09, M10, M12, M14 are load-bearing.** Each was checked against "what if this returned
  a constant": `[M09]`'s premise assertion fails outright, `[M10]` is cross-checked against
  page text extracted independently in `beforeAll` rather than against the index that produced
  the answer, and `[M12]`, `[M08]` and `[M14]` each have a sibling test a constant cannot
  satisfy.
- **No tests that assert nothing.** A scan for `expect(true)`, `toBeTruthy()`, `.skip`,
  `.todo`, empty `catch {}` and snapshot assertions returned no hits; no test file lacks
  `expect`.

## Coverage shape

`apps/desktop/src` contains no `*.test.ts`. The renderer is covered by the Playwright specs;
the main process by `tests/integration/vertical-slice.test.ts`, which imports `services.ts`,
`handlers.ts` and `router.ts` directly and drives the real router with real zod validation.
This is deliberate and defensible, but it means `host.ts`'s `resolveLinks` has no unit coverage
and only incidental E2E coverage.

`packages/html-reader/src/index.ts` is a stub that throws `NotImplementedError` and exports
`IMPLEMENTED = false`. It is milestone-2 work (`docs/MILESTONE2.md`, W03) and is not claimed by
any milestone-1 criterion. It is named here so its absence is not mistaken for coverage: the
sandboxed-iframe treatment for archived HTML does not exist yet, and `docs/SECURITY.md` says so
in its own gaps list.

## Gates at the audited commit

`pnpm typecheck` 0 · `pnpm lint` 0 · `pnpm build` 0 · 361 unit tests in 23 files, 0 failures ·
11 E2E specs against a real Electron launch, 0 failures.
