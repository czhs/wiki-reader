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
