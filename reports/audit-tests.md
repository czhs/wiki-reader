# Adversarial audit — test honesty

Audited-commit: b0dffcd
Lens: does each tagged test genuinely exercise the criterion its tag claims?
Method: read every tagged test and the production code it calls; ran three mutation
experiments against the real toolchain (`pnpm exec vitest run`, Node pinned). No Electron
window was launched.

Scope: 309 tagged assertions across 24 test files; all 32 tags in
`scripts/verify_completion.py` (`UNIT_TAGS` + `E2E_TAGS`) accounted for.

---

## Findings

### F1 — MAJOR — [L03] is satisfied by a test that never lists a reference

`packages/workbench/test/workbench.test.ts:422`

```ts
it('[L03] shows incoming and outgoing references in the references panel', async () => {
  host.activeEntity = { entityId: DOC, entityType: 'document', documentId: DOC };
  await workbench.commands.execute(COMMAND_IDS.findIncomingLinks, {});
  await workbench.commands.execute(COMMAND_IDS.findOutgoingLinks, {});
  expect(host.shownReferences.map((query) => query.direction)).toEqual(['incoming', 'outgoing']);
});
```

This is the **only** test in the repository whose title contains `[L03]`.

Three separate problems:

1. **It does not invoke the command the criterion names.** The criterion is "Shift+F12 lists
   all references to the current entity". Shift+F12 binds `COMMAND_IDS.findAllReferences`
   (confirmed by `workbench.test.ts:159`, tagged `[L09]`, not `[L03]`). This test executes
   `findIncomingLinks` and `findOutgoingLinks` instead.
2. **It asserts only that its own argument came back.** `showReferences` is called by
   `Workbench.#showReferences` (`packages/workbench/src/workbench.ts:303`) with the query
   object the command constructed. The assertion checks that the string `'incoming'` the
   command hard-codes at `workbench.ts:446` arrived at the fake. No reference data is
   involved.
3. **The host is a fake with no data.** `FakeHost.resolveLinks()` returns `this.resolved`,
   which the test never populates — it is `[]` for the whole test. The production
   implementation (`apps/desktop/src/renderer/host.ts:267`, which calls
   `link:findReferences` over IPC) is never reached.

**Mutation proof.** `LinkRepository.findReferences` and `LinkRepository.findByType`
(`packages/database/src/repositories/links.ts:167,195`) were each replaced with a constant
`return []`, and the whole unit suite re-run:

```
L03 {'passed': 1, 'failed': 0}      <- still green
L04 {'passed': 2, 'failed': 0}      <- still green
L08 {'passed': 1, 'failed': 0}      <- still green (unit)
L10 {'passed': 1, 'failed': 1}      <- caught it
M13 {'passed': 2, 'failed': 1}      <- caught it
(every other tag: 0 failed)
```

Link lookup could return nothing at all and criterion L03 would still be reported satisfied.
The real behaviour *is* implemented and *is* tested — at
`packages/database/test/repositories.test.ts:293` ("separates incoming from outgoing
references") — but that test carries no tag, so it is not what the gate reads.

### F2 — MAJOR — [L04] asserts a pass-through, not a listing

`packages/workbench/test/workbench.test.ts:431` and `:441`

```ts
await workbench.commands.execute(COMMAND_IDS.findAllLinksOfType, {
  linkType: 'document-cites-document',
});
expect(host.shownReferences[0]?.linkType).toBe('document-cites-document');
```

The criterion is "A command lists all links of the selected link's type". The test supplies a
link type as an argument and asserts the same string arrives at the fake host one call later.
No link of that type — or of any type — exists in the test. The second `[L04]` test asserts
only that omitting `linkType` throws.

Covered by the same mutation run as F1: with `findByType` returning a constant `[]`, both
`[L04]` tests stay green. The real narrowing logic (by `documentId`, `origin`, `generator`,
`createdAfter`, `collectionId`, `tag`) is genuinely tested at
`packages/database/test/repositories.test.ts:348` and `:391` — again, untagged.

### F3 — MAJOR — [T05] "HTML text normalization" contains no HTML

13 tests carry `[T05]`: 12 in `packages/document-model/src/normalize.test.ts` and one at
`packages/pdf-reader/test/selection.test.ts:45`.

Every one of them feeds a plain JavaScript string or a PDF.js text-item array
(`{ str, hasEOL }`) to `normalizeText`, `normalizeTextPreservingParagraphs`, or
`joinPdfTextItems`. Not one passes an HTML fragment, a DOM node, or markdown through
anything. There is no HTML-to-text function in the codebase to test:
`packages/html-reader/src/index.ts` is 19 lines that export `IMPLEMENTED = false` and a
`NotImplementedError` class.

`scripts/verify_completion.py:56` labels T05 "HTML text normalization"; `docs/SPEC.md:262`
lists "HTML and markdown normalization" among the required tests. The gate passes on
PDF/plain-text normalization alone.

This is arguably the intended state of milestone 1 (the HTML reader is deferred to milestone
2), but then the T05 gate is misdescribed and gives credit for coverage that does not exist.
Either the tag's description should be narrowed to what is actually tested, or T05 should not
be reported as satisfied.

### F4 — MINOR — a [T05] test asserts on a hard-coded literal

`packages/document-model/src/normalize.test.ts:47`

```ts
it('[T05] declares a normalization version so anchors can detect algorithm drift', () => {
  expect(NORMALIZATION_VERSION).toBeGreaterThan(0);
});
```

`packages/document-model/src/normalize.ts:15` is `export const NORMALIZATION_VERSION = 1;`.
The assertion is on a compile-time constant and cannot fail except by editing that line. It
tests nothing about drift detection — no anchor is compared against a version anywhere in
this test.

(`packages/database/test/migrations.test.ts:85`, `expect(LATEST_SCHEMA_VERSION)
.toBeGreaterThan(0)`, is the same shape but is preceded on line 84 by a meaningful assertion
that `db.version()` equals it. Not a finding.)

### F5 — MINOR — a [T07] test builds its expectation from the value under test

`packages/search/test/chunking.test.ts:91`

```ts
const chunks = chunkPdfPages(pages);
expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_unused, index) => index));
expect(chunks.every((chunk) => chunk.kind === 'pdf-page')).toBe(true);
```

Both assertions are vacuously true if `chunkPdfPages` returns `[]` (`[] === []`, and
`[].every(...)` is `true`). This test has no length floor of its own; the floor lives in a
sibling test at `:75`. In isolation it would not detect a chunker that produced nothing.

The same self-referential index comparison appears at `tests/integration/vertical-slice.test.ts:244`,
but there it is guarded two lines earlier by `expect(coveredPages).toEqual([0, 1, 2])`, so it
is not a finding in that file.

### F6 — MINOR — a [T04] test computes its expectation with the function under test

`packages/pdf-reader/test/selection.test.ts:130`

```ts
const start = estimateNormalizedStart({ itemTexts: ['The   Transformer  ', 'uses attention'], ... });
expect(start).toBe(normalizeText('The   Transformer   uses ').length);
```

`estimateNormalizedStart` uses `normalizeText` internally, so both sides of the assertion move
together under any change to normalization. `normalizeText` is separately pinned by literal
expectations in `normalize.test.ts`, so the risk is bounded — but this particular assertion is
not independent.

### F7 — MINOR — no [M04] test exercises the real attachment probe

Every test in `packages/zotero-adapter/test/importer.test.ts` injects a stub file probe
(`importer.test.ts:14`):

```ts
const allFilesPresent: FileProbe = (path) =>
  Promise.resolve({ byteSize: path.length * 1000, contentHash: `sha256:${path.length}` });
```

The production default is `hashFileOnDisk` (`packages/zotero-adapter/src/importer.ts:121`),
which reads and SHA-256s the real bytes. No `[M04]`-tagged test reaches it. It *is* exercised
— by `tests/e2e/support/workspace.ts:188`, which constructs `new ZoteroImporter(client, db,
{ dataDir })` with no probe override over real files on disk and asserts `summary.filesMissing
=== 0` — but that seeding runs under the `[M05]` tag.

### F8 — MINOR — nothing joins the M14 store round-trip to the renderer's serializer

`[M14]` (`tests/integration/vertical-slice.test.ts:685`) round-trips a hand-written Dockview
blob through `workspace:saveLayout` / `workspace:loadLayout` and a real database reopen.
`[T10]` (`packages/workbench/test/layout.test.ts`) round-trips `serializeWorkspace` /
`deserializeWorkspace` in memory. The renderer joins them at
`apps/desktop/src/renderer/workspace.tsx:148-197` (`fromWorkspaceLayoutRecord` on restore,
`serializeWorkspace` + `toWorkspaceLayoutRecord` on save). No test covers the join, and no E2E
spec restarts the app to check a layout survives — `launchApp` is exported from
`tests/e2e/support/app.ts:32` with a comment saying "the restart criteria need to stop the app
and start a second one over the same database directory", but grep shows its only caller is
the fixture in the same file. `docs/MILESTONE.md` classifies M14 as integration, so this is a
gap rather than a rule violation.

---

## Categories where nothing was found

**Tests that assert nothing at all.** A scan of every test file for `expect(true)`,
`toBeTruthy()`, `.skip`, `.todo`, empty `catch {}` blocks, and snapshot assertions returned no
hits. No test file lacks `expect`. The `expect(x).toBeDefined(); if (x === undefined) return;`
pattern used throughout the E2E specs is sound — the `expect` fails first, so the early return
cannot mask a failure.

**Invented fixtures presented as recorded.** None found.

- `packages/zotero-adapter/test/fixtures/*.json` are genuine Zotero 7 local-API responses:
  full `{ key, version, library, links, meta, data }` envelopes, `Total-Results` and
  `Last-Modified-Version` headers reproduced in `fake-api.ts:41`, `links.enclosure.href`
  entries with real `mtime`/`md5`, user id anonymized to `000000`. `fixtures.ts:23` parses
  them through the same `ZoteroItemListSchema` the client uses, so drift between the recorded
  shape and the parser fails the tests. The fake is a `fetch`, not a fake client:
  pagination, header handling, schema parsing and error mapping all run for real.
- `tests/fixtures/sample-paper.pdf` is a real 3-page PDF (`file(1)`: "PDF document, version
  1.4, 3 pages") synthesized by `scripts/make_pdf_fixture.mjs`. It is generated rather than
  recorded, but it is genuinely parsed by `pdfjs-dist/legacy` — nothing about the extraction
  path is faked.

**Criteria satisfied by mocks where real integration was feasible.** M04, M09 and M10 are all
real:

- M09 runs `extractPdfText` (`workers/text-extraction/src/index.ts:95`), which really imports
  `pdfjs-dist/legacy/build/pdf.mjs` and parses the fixture. `createTestServices` does not pass
  `extractPdf`, so `ExtractionPipeline` uses the real default (`pipeline.ts:67`). FTS5 is a
  real SQLite index.
- M10 asserts page mappings against `fixturePages`, extracted independently in `beforeAll`
  (`vertical-slice.test.ts:53-65`), *not* against the index that produced the answer. The
  `beforeAll` also asserts up front that each probe term is unique to one page, so the
  discriminating premise is checked rather than assumed.
- `Workspace.restart()` (`vertical-slice.test.ts:96`) is a real restart within the constraints
  of a vitest process: `services.close()` calls `db.close()`, then `createTestServices` opens
  a fresh connection against the same file. Anything held in memory is gone.
- `packages/search/test/search-service.test.ts` runs against a real SQLite FTS5 index via
  `createTempDatabase`, not a stub.

---

## Load-bearing analysis: what happens if the implementation returns a constant

| # | Test | Production function | If it returned a constant/empty |
|---|------|--------------------|--------------------------------|
| 1 | `[M09] extracts real PDF text and makes every page searchable in FTS5` (vertical-slice.test.ts:225) | `extractPdfText` | **Caught.** Verified by mutation: body replaced with a constant 3-page result → `beforeAll` fails at line 63 (`"sinusoidal" is not unique to one page: expected [] to deeply equal [ +0 ]`), all 20 tests in the file report non-passing. The verifier's `check_tags` treats "exists but none passed" as a failure, so this cannot slip through. |
| 2 | `[M10] returns the page location a term actually appears on` (:360) | `SearchService.search` + result location mapping | **Caught.** Empty results fail `expect(results.length).toBeGreaterThan(0)`. A constant `{ kind: 'pdf', pageIndex: 0 }` passes for `sinusoidal` and fails for `warmup` (page 1) and `reproducible` (page 2). The cross-check `expect(pageText.get(location.pageIndex)).toContain(term)` reads from the chunk store, independent of the search path. |
| 3 | `[M12] the highlight survives application restart and still resolves to its text` (:495) | `AnnotationRepository.listByDocument` + `resolvePdfAnchor` | **Caught.** `[]` fails `toHaveLength(1)`. A stored-but-unresolvable anchor fails `expect(resolved).not.toBeNull()`. A constant `'exact-position'` strategy fails the sibling test at `:529`, which requires `not.toBe('exact-position')` after the page text shifts and then slices the shifted text to confirm the range really addresses the quote. |
| 4 | `[M08] restores the saved reading position after restart` (:176) | `ReadingPositionRepository.get/set` | **Caught.** `null` fails `expect(restored.position).not.toBeNull()`. A constant position fails the sibling at `:213`, which requires `null` for a never-opened document, and `:191`, which requires the second write to win. |
| 5 | `[M14] restores the saved workspace layout after restart` (:685) | `LayoutRepository.save/load` | **Caught.** `null` fails `not.toBeNull()`. A constant layout fails `:730` (two named layouts must stay independent and `listNames()` must equal `['default','reading']`) and `:760` (a fresh profile must report `null`, not an invented layout). |
| 6 | `[L03]` (workbench.test.ts:422) and `[L04]` (:431) | `LinkRepository.findReferences` / `findByType` | **NOT caught.** Verified by mutation — both returned a constant `[]` and both tags stayed fully green. See F1 and F2. |

Same mutation run, full tag table (link repository gutted to `return []`):

```
L01 16/0  L03 1/0  L04 2/0  L05 14/0  L06 14/0  L07 18/0  L08 1/0  L09 57/0
L10 1/1   M03 6/0  M04 10/0 M08 3/0   M09 5/0   M10 3/0   M11 7/0  M12 3/0
M13 2/1   M14 3/0  T01 8/0  T02 28/0  T03 8/0   T04 21/0  T05 13/0 T06 12/0
T07 22/0  T08 16/0 T09 14/0 T10 11/0
```

Only `[L10]` and `[M13]` detected the sabotage. `[L03]`, `[L04]` and the unit `[L08]` did not.

---

## Note on coverage shape (context, not a finding)

`apps/desktop/src` contains no `*.test.ts` files. The 2,217-line renderer
(`apps/desktop/src/renderer/`) is covered exclusively by the 8 Playwright specs; the main
process is covered by `tests/integration/vertical-slice.test.ts`, which imports `services.ts`,
`handlers.ts` and `router.ts` directly. This is a deliberate and defensible design — the
integration test drives the real router with real zod validation — but it means
`host.ts:267 resolveLinks`, the production code behind L03 and L04, has no unit coverage at
all and only incidental E2E coverage through the `[L02]` and `[L08]` specs.
