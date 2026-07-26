# Milestone 2 — independent test-honesty audit

**Commit audited:** `4420cea8ee5998fddae26db66c0c795c9c8852ba` (`main`)
**Scope:** criteria `W01`–`W12` of `docs/MILESTONE2.md`, lens = *test honesty*. Milestone 1
(`M*`/`L*`/`T*`) was out of scope except where milestone-2 work touched it.
**Method:** read every `[W..]`-tagged test against the production code it claims to exercise;
for the weakest, mutated the production code, re-ran only the narrow test, and reverted with
`git checkout --`. No test file was ever modified. Working tree verified clean at the end.

Toolchain: Node v20.19.3 (`nvm use`), `npx vitest run <path> -t '<tag>'`. E2E criteria
(`W01`, `W03`, `W09`) were not re-run; they are assessed statically against the last verifier
run (`logs/verify/playwright.json`, 2026-07-25 17:13), in which all seven `W01`/`W03`/`W09`
specs are `expected`.

## Where the tagged tests live

| Tag | Test file | Kind |
|-----|-----------|------|
| W01 | `tests/e2e/markdown.spec.ts:76,118` | e2e |
| W02 | `tests/integration/markdown-highlight.test.ts:153,185,217` | integration |
| W03 | `tests/e2e/webpage.spec.ts:42,85` | e2e |
| W04 | `tests/integration/snapshot-protocol.test.ts:132–276` | integration |
| W05 | `tests/integration/html-highlight.test.ts:278–343` | integration |
| W06 | `packages/document-model/src/markdown.test.ts:49–103` | unit |
| W07 | `tests/integration/corpus.test.ts:130,156,202` | integration |
| W08 | `packages/document-model/src/markdown.test.ts:112–156`, `tests/integration/corpus.test.ts:112` | unit + integration |
| W09 | `tests/e2e/graph.spec.ts:96,136` | e2e |
| W10 | `tests/integration/graph.test.ts:111–284` | integration |
| W11 | `tests/integration/highlight-color.test.ts:224–342` | integration |
| W12 | `packages/zotero-adapter/test/importer.test.ts:279–361` | integration |

No `[W..]` test is skipped, `.todo`, or conditionally excluded (`grep` for
`skipIf|it.skip|describe.skip|.todo|fixme` across `tests/` and `packages/*/{src,test}` is empty),
and all tagged files match `vitest.config.ts`'s `include` globs.

## Findings

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 1 | major | **W12 is never exercised through the shipping path, and the shipping path has no caller.** All six `[W12]` tests construct `ZoteroImporter` directly (`packages/zotero-adapter/test/importer.test.ts:279–361` via `createHarness`, `importer.test.ts:31–57`), bypassing zod validation, the router and the handler. Meanwhile `'zotero:import'` appears exactly once in all of `apps/desktop/src` and `tests/` — its own handler at `apps/desktop/src/main/handlers.ts:89`. Nothing in `apps/desktop/src/renderer/` or `packages/workbench/src/` references Zotero at all, and the only import the running app performs is the corpus scan (`apps/desktop/src/main/index.ts:189`, `started.corpus.import()`). So a user of the built app cannot name a collection, and the `collection` field of the contract (`packages/shared-types/src/ipc.ts:102–108`) plus the handler's spread at `handlers.ts:90–93` are dead and untested. | `grep -rn "'zotero:import'" apps/desktop/src tests` → one hit, `handlers.ts:89`. `grep -rn "zotero" apps/desktop/src/renderer packages/workbench/src` → empty. |
| 2 | major | **W11's "changed from its popover" seam is supplied by the test, not by the app.** `renderCard` in `tests/integration/highlight-color.test.ts:167–193` passes its *own* `onChangeColor` / `onChangeComment` / `onDelete` handlers (lines 177–185), each calling `workspace.call('annotation:update' \| 'annotation:delete', …)`. The real wiring lives in `apps/desktop/src/renderer/panels.tsx:622–648` and nothing in the suite imports that file (`grep -rln "renderer/panels" tests packages apps` → empty); there is no `[W11]` e2e, and no e2e spec references `highlight-color-*`, `annotation-edit-*`, `highlight-popover` or `annotation-swatch-*`. | **Mutation:** replaced the body of `onChangeColor` at `panels.tsx:622–630` with a no-op (`void annotationId; void color;`). `npx vitest run tests/integration/highlight-color.test.ts -t 'W11'` → **7 passed, 0 failed** — the mutation survived. Reverted with `git checkout -- apps/desktop/src/renderer/panels.tsx`. |
| 3 | minor | **`[W10] sends no edge whose other end was withheld` cannot fail.** The test (`tests/integration/graph.test.ts:148–165`) says "`c` is on the boundary: its edge to `d` exists in the database and must not be drawn". It never can be: the frontier loop at `packages/database/src/repositories/graph.ts:81–116` only *queries* nodes at distance < depth, and adds both endpoints of every edge it reads to `nodeKeys`, so every collected edge is structurally inside the returned node set. The `c→d` edge is never read. The only real source of half-edges is `nodeLimit` truncation, which a *different* test covers. | **Mutation:** `graph.ts:149–152` → `const keptEdges = [...edges.values()];` (drop the `bounded.edgeIds` filter entirely). `npx vitest run tests/integration/graph.test.ts -t 'W10'` → only `[W10] caps the node count…` failed; **`[W10] sends no edge whose other end was withheld` passed**. Reverted. |
| 4 | minor | **`[W10] resolves titles in main and lets no filesystem path reach the renderer` asserts something the type system already guarantees.** `tests/integration/graph.test.ts:252–254` serializes the response and asserts it contains neither `workspace.dir` nor `tmpdir()`. `GraphNeighbourhoodSchema` (`packages/shared-types/src/domain.ts:252–265`) is a plain `z.object` with no path-bearing field, and the repository parses through it before returning (`graph.ts:154`), so zod strips anything else. No production change can make this assertion fail. | `domain.ts:252–265` (schema); `graph.ts:154` (`GraphNeighbourhoodSchema.parse`). |
| 5 | minor | **`[W10] keeps the graph panel on the neighbourhood channel and off the link tables` is a source-text grep wearing a criterion tag.** `tests/integration/graph.test.ts:271–284` reads `graph-panel.tsx` as a string and asserts `toContain("call('graph:neighbourhood'")` / `not.toContain("call('link:findByType'")`. Any indirection — a channel held in a variable, a helper wrapper, a `useCallback` — defeats it while changing the behaviour it claims to protect. It exercises no code. | `tests/integration/graph.test.ts:275–283`. |
| 6 | minor | **Every "archived page" in the suite is markup invented by the harness; no recorded saved page exists in the repo.** `tests/e2e/support/workspace.ts:146–184` (`writeSnapshot`) hand-writes the HTML/CSS/PNG that `[W03]` asserts on, and `tests/integration/html-highlight.test.ts:52–87` does the same for `[W05]`. `docs/ZOTERO.md:18` states the Zotero fixtures are recorded from real responses — the snapshots are the one input that is not. The failure modes a real Zotero/SingleFile snapshot brings (`<base href>`, absolutised or rewritten resource URLs, `data:` URIs, nested frames, `<meta charset>` disagreeing with the served type) are therefore untested by `W03`/`W05`, and the `rrfile://` relative-path resolution `W04` guards is only ever fed paths the harness chose. | `tests/e2e/support/workspace.ts:146–184`; `tests/integration/html-highlight.test.ts:52–87`; `docs/ZOTERO.md:18`. |
| 7 | minor | **`[W01] renders markdown from bytes fetched over rrfile:// without exposing a path` asserts nothing about the fetch.** `tests/e2e/markdown.spec.ts:118–149` asserts only (a) the shape of the `library:getDocument` response (`url` matches `^rrfile://`, no `path` key) and (b) that the workspace/corpus paths do not appear in `window.content()`. It would pass unchanged if the reader rendered a string delivered over IPC instead of fetching. The fetch *is* real (`packages/markdown-reader/src/MarkdownReaderView.tsx:59`), and the sibling test's structural assertions (`markdown-heading-*`, `markdown-code`) do carry W01 — but the second test proves only the "without exposing a path" half of its own title. | `tests/e2e/markdown.spec.ts:127–148` vs. `MarkdownReaderView.tsx:54–80`. |
| 8 | minor | **`[W06] resolves a wikilink to the document that owns its slug` never touches a document.** `packages/document-model/src/markdown.test.ts:89–103` resolves against a `Map` built by the test's own `index()` helper (`markdown.test.ts:11–12`) whose entry carries the literal `documentId: 'doc_a'`; the assertion `resolved[0].target.documentId === 'doc_a'` returns the value the test put in. The criterion's "resolves to a document" is only genuinely shown by an **untagged** test, `tests/integration/corpus.test.ts:96–110`, which runs the real importer against real documents. Tagging that one would make W06 honest. | `markdown.test.ts:89–103`; untagged real coverage at `corpus.test.ts:96–110`. |
| 9 | minor | **`[W12] importing a second collection adds to the first rather than replacing it` guards a property no code path can violate.** `ZoteroImporter` contains no deletion of documents at all — `grep -n "delete\|prune\|remove" packages/zotero-adapter/src/importer.ts` matches only the doc-comment at line 186 ("nothing here deletes"). The additive assertion at `importer.test.ts:317–328` is a regression guard against a future replace-style import, not evidence that additive behaviour was implemented. (This is the assertion `docs/MILESTONE2.md:56` explicitly asked for, so it should stay — it just isn't proof of work.) | `packages/zotero-adapter/src/importer.ts` (no delete path); `importer.test.ts:317–328`. |
| 10 | minor | **No test asserts a non-default highlight colour is painted in any reading view.** `packages/annotations/src/HighlightPopover.tsx:25–26` claims "the swatches paint themselves from the same CSS variables the reader paints the document with, so what you pick here is what you see there". The `[W11]` tests only check the *card's* swatch and the *popover's* swatches (`highlight-color.test.ts:239–253`). The only reader-side highlight assertion in the whole suite is `tests/e2e/reader.spec.ts:159`, which checks a `pdf-highlight-*` element exists and says nothing about its colour. The painting is in fact correct (`PdfPageView.tsx:148`, `packages/markdown-reader/src/render.tsx:238` both set `background: highlightColorVariable(color)` inline), but nothing would catch a regression to the CSS-class default at `packages/markdown-reader/src/styles.css:100`. | `grep -rn "markdown-highlight-\|data-color" tests/` → one hit, `reader.spec.ts:159`. |

## Mutations that the suite *did* catch

Recorded so the negative findings above are read in proportion. All reverted immediately.

| Criterion | Mutation | Result |
|-----------|----------|--------|
| W07 | `packages/database/src/repositories/links.ts:174` — widened `replaceDerived`'s `DELETE` to ignore `origin` and `generator` (`AND (origin='derived' OR 1=1) AND (generator=? OR 1=1)`), i.e. exactly the "delete by `source_id`" bug `docs/MILESTONE2.md:58` warns about | **caught** — `[W07] preserves a manually created link across a re-index` and `[W07] leaves another generator's derived links alone` both failed (2 failed / 1 passed) |
| W10 | `packages/database/src/repositories/graph.ts:129–130` — passed `depth: 10, nodeLimit: 10_000` to `boundedNeighbourhood` instead of the caller's bounds | **caught** — `[W10] caps the node count and reports what it elided` failed (1 failed / 8 passed) |
| W12 | `packages/zotero-adapter/src/importer.ts:222` — replaced the collection-membership filter with `scopeKeys.size >= 0` (always true) | **caught** — 4 of 6 `[W12]` tests failed |

`W04` (`tests/integration/snapshot-protocol.test.ts`) is the strongest suite in the milestone:
every permission is tested next to the refusal that bounds it, including encoded-separator
traversal, symlink escape both inside and outside the allowed roots, NUL truncation, and
non-`rrfile:` origins. `W02` was mutation-tested earlier in the same session (the
`markdown-anchor` null-return) and caught. `W05` and `W08` read as genuine; the Zotero
fixtures in `packages/zotero-adapter/test/fixtures/` are real recorded responses (real Zotero
collection keys `A7L7XITJ` / `FSZ4VXT5`, real papers), and the W12 scope shape — five items in
one collection, two under subcollections of another, one unfiled — is a property of the
recording rather than something added for the test.

## Working tree

`git status --porcelain` is empty and `git diff --stat` is empty at the end of this audit.
Every mutation above was reverted with `git checkout -- <file>` immediately after its narrow
test run. Nothing was committed.
