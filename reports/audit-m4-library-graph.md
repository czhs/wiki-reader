# Milestone 4 audit — B01–B05, G01/G02/G03/G06

Auditor: independent, adversarial. Goal: falsify "milestone 4 is complete" for the library-curation
and graph criteria in scope. Branch `main`, HEAD `c072375`, diff under audit `fde3e38..HEAD`.
G04 and G05 are another auditor's; N*, K*, C01, W*, M* are out of scope except where milestone-4
code touched them.

Method: read the milestone doc's "ones that hide a bug" as hypotheses, then trace each claim from
the tagged test through the router, the repositories and the importer to the shipped renderer.
Read-only throughout — no `pnpm dev`, no E2E, no file in the tree modified except this report.

---

## Findings

### F1 (major) — "a routine import leaves a removal alone" is false whenever an import scope is remembered; the tagged test is fitted to the one configuration where it holds

`[B01] a routine import leaves a removal alone`
(`tests/integration/library-curation.test.ts:235-253`) asserts that a whole-library import —
`zotero:import {}`, `force: true` included — passes a removed document over. The importer's own
prose states the rule twice:

- `packages/zotero-adapter/src/importer.ts:246-250` — "an unscoped run — the routine sync — leaves
  removals alone, and asking for a *particular* collection is the researcher saying they want what
  is in it. That asymmetry is the whole of the rule: … no sync that quietly undoes a morning's
  curation."
- commit `41bf1d5` — "The routine sync can no longer undo a morning's curation."

The whole rule rests on one bit, computed in `importer.ts:303`:

```ts
await this.importItem(item, collectionIdByKey, { force, scoped: scopeKeys !== null }, summary);
```

and consumed in `importer.ts:450-455`:

```ts
if (reference !== null && reference.removedAt !== null) {
  if (!scoped) return { documentId: reference.entityId, outcome: 'removed' };
  this.db.library.restore(reference.entityId);
  restoring = true;
}
```

`scoped` is true iff the importer was handed a non-empty `collections` array. It cannot see whether
that array was *named in this request* or *read from a stored preference*. And the handler feeds it
the stored preference — `apps/desktop/src/main/handlers.ts:363-368`:

```ts
'zotero:import': async ({ force, collection, collections }) => {
  const explicit = collections ?? (collection === undefined ? undefined : [collection]);
  const scope = explicit ?? readImportScope(db);
  const summary = await services.importer.import({ force, collections: scope });
```

The routine sync in the shipped app sends no collection at all —
`apps/desktop/src/renderer/panels.tsx:1081-1084`, the "Import from Zotero" button's handler:

```ts
const summary = await call('zotero:import', {
  force: false,
  ...(collection === undefined ? {} : { collection }),
});
```

So for any researcher who has ticked collections in the scope picker — which is the *documented
intended setup* for a large Zotero (`apps/desktop/src/main/import-scope.ts:5-8`: "a researcher whose
Zotero holds fifteen years of everything got fifteen years of everything"; the picks are explicitly
"a standing decision", `panels.tsx:1223-1225`) — pressing "Import from Zotero" is a scoped import,
and every document they removed from a ticked collection is silently restored. That is exactly the
failure the model was re-specified to avoid.

This is provable without running anything new, from two already-green tests plus the one handler
line above:

1. `tests/integration/zotero-import.test.ts:123-138`, `[C01] scopes an import that names no
   collection of its own`: after `zotero:setImportScope {collections:['m26-sprint-wiki']}`, a plain
   `zotero:import {}` comes back with `collectionScope === 'm26-sprint-wiki'`. `collectionScope`
   is non-null exactly when `scopeKeys !== null`, i.e. when `scoped === true`.
2. `tests/integration/library-curation.test.ts:201-233`, `[B01] a removed document comes back when
   its collection is imported again`: an import whose scope covers a removed item's collection
   returns `documentsRestored === 1` and puts the document back.

The importer's input is identical in the two cases. `[B01] a routine import leaves a removal alone`
passes only because its `beforeEach` builds a fresh database in which `zotero.importScope` was never
written, so `readImportScope` returns `[]`.

The distinction the milestone doc asked me to interrogate — "work out exactly what distinguishes
`a routine import leaves a removal alone` from `a removed document comes back when its collection is
imported again`" — is therefore **not** "the researcher asked for this collection by name". It is
"the `collections` array happened to be empty", and the app routinely makes it non-empty without the
researcher asking for anything. The two tagged behaviours coexist coherently only in a library with
no remembered scope.

Note what is *not* wrong: the B01 round trip itself works, end to end, and the per-row Import button
(`panels.tsx:1226-1237`) is an honest explicit request — it even discloses the consequence in its
tooltip ("Anything removed from it comes back"), which the plain Import button does not. The defect
is that the standing scope is routed through the same parameter as the one-off request.

Smallest honest fix shape: carry the request's intent separately from the collection list (e.g.
`importer.import({ collections, restoreRemoved: explicit !== undefined })`), and add a `[B01]` case
that sets an import scope covering the victim before the routine import.

### F2 (major) — the mechanism the restore path names as "the document becomes searchable again" has no consumer; the `[B01]` assertion that proves it is vacuous, and annotation search entries never come back

`library.remove()` deletes the document's search entries
(`packages/database/src/repositories/library.ts:75`), and `removeForDocument`
(`packages/database/src/repositories/search-index.ts:74-81`) deletes **every** row with that
`document_id` — chunk entries, the document record, and the annotation entries, which carry
`documentId = annotation.documentId` (`packages/search/src/indexer.ts:177-192`).

The restore path says it rebuilds them (`packages/zotero-adapter/src/importer.ts:411-415`):

```ts
else if (write.outcome === 'restored') {
  summary.documentsRestored += 1;
  // The chunks survived the removal, so the text is still there to index; the search
  // entries that pointed at it did not, and are rebuilt rather than resurrected.
  this.db.jobs.enqueue(write.documentId, 'index-fts');
}
```

`index-fts` has exactly one producer — that line — and **zero consumers** anywhere in the repo. The
only drain is `apps/desktop/src/main/pipeline.ts:102`, `this.db.jobs.claimNext('extract-text')`; the
package that was to run this queue is a declared stub (`workers/indexing/src/index.ts`, "not yet
implemented … criterion M09"). So the enqueued job sits `queued` forever. Because
`IndexingJobsRepository.enqueue` short-circuits on a pending job of the same type
(`packages/database/src/repositories/indexing-jobs.ts:25-26`), the row also permanently absorbs
every later `index-fts` enqueue for that document.

The `[B01]` test cites that row as the proof of searchability
(`tests/integration/library-curation.test.ts:230-232`):

```ts
// And its text is queued to be searchable again. … a document you cannot find is only half back.
expect(services.db.jobs.findPending(victim.id, 'index-fts')).not.toBeNull();
```

It asserts that a no-op happened. It would pass unchanged if the queue were write-only, which it is.

What actually restores search is incidental: a restored Zotero item falls through to
`importAttachments`, which enqueues a fresh `extract-text` job, which `kickPipeline`
(`handlers.ts:378`) drains, and `runExtraction` → `indexExtractedPdf` rewrites chunk entries and the
document record (`packages/search/src/indexer.ts:81-88`). That rescue covers only documents with a
readable PDF attachment, and it rebuilds **chunk and document entries only** — annotation entries are
never re-indexed on any path (`indexer.indexAnnotation` is called only from `annotation:create` /
`annotation:update`, `handlers.ts:559,584`). So after remove → restore:

- a restored non-PDF document, or one whose bytes are missing, stays entirely unfindable;
- in every case the researcher's own highlights stop answering searches permanently, while
  remaining visible in the annotation panel.

B03 says a removal must leave annotations "recoverable, not silently destroyed", and the suite's own
`[B03] a removed document stops answering searches`
(`tests/integration/library-curation.test.ts:388-404`) establishes searchability as part of the
model. The removal half is asserted; the restore half is asserted against a dead queue.

### F3 (minor) — the removal message names a way back that does not exist for two of the three document classes it is shown for, and the `[B03]` E2E asserts it as a constant

`RemoveFromLibrary` (`apps/desktop/src/renderer/panels.tsx:1362-1398`) is rendered as the row action
for both the Zotero list (`panels.tsx:1442`) and the "From disk" list (`panels.tsx:1473`). Its status
message is unconditional (`panels.tsx:1373-1377`): "… import its collection again to bring it back."

- For a **local** document there is no collection and no import; the real way back is adding or
  dropping the file again (`apps/desktop/src/main/local-files.ts:169-179`, proven by
  `[B03] adding a removed file again puts it back rather than doing nothing`,
  `tests/integration/library-curation.test.ts:470-488`). The message sends the researcher to a
  control that cannot help them.
- For a **Zotero item filed in no collection** — the fixtures contain one deliberately, and
  `importAndPickVictim` (`library-curation.test.ts:167-198`) skips past it for exactly this reason —
  no scoped import can ever cover it, so the message is false and there is no in-app route back at
  all. The test's own comment concedes the gap ("a paper in no collection at all can be removed but
  has no shelf to be asked for from") without testing it.

The E2E `[B03] a removal is reachable, and says what it kept and how to undo it`
(`tests/e2e/library.spec.ts:202-205`) asserts that literal string, and passes for any row it picks
because the implementation emits it unconditionally. It is a test of a constant.

Not raised higher because recoverability of the *work* holds in all three cases — this is a truthful-
UI defect, not a data-loss one.

### F4 (minor) — three tests tagged `[B05]` do not exercise B05

`apps/desktop/src/main/zotero-endpoint.test.ts:13,21,26` carry `[B05]` on unit tests of
`resolveZoteroEndpoint` — env-var parsing for the E2E harness's loopback fixture port. B05 is
"A Zotero collection is imported from the library in one action"; nothing in that file imports
anything. The genuine B05 evidence is `tests/e2e/library.spec.ts:223-265`, and B05 is registered in
`E2E_TAGS` (`scripts/verify_completion.py:140`), so the mis-tagged unit tests cannot satisfy the
verifier — the harm is only that a grep for `[B05]` returns three tests that prove something else.
The endpoint validation those tests cover is itself sound (see V6).

---

## Traces that held

Recording these because a verified invariant is worth as much as a finding.

**V1 — the B01 blacklist is genuinely gone.** `library:listRemoved`, `library:restoreDocument`, the
sidebar "Removed" section and its "Put back" button are absent from `apps/`, `packages/`, `tests/`
and `scripts/`; the only surviving mentions are a `state/DECISIONS.md` entry recording their removal
and a comment at `apps/desktop/src/renderer/panels.tsx:1510` explaining the absence. There is no
tombstone *table*: migration `009_library_curation.ts` adds one nullable `removed_at` column plus a
partial index to the existing `external_references` provenance row. Something has to record "not
now" while the highlights stay on the document, and this is the minimum that does. No stale test
asserts the old "a re-import does not bring it back" spec — the file that did (commit `9441870`) was
rewritten wholesale by `41bf1d5`.

**V2 — the B01 round trip is real, and crosses the seam.** `library-curation.test.ts` drives the real
router (`dispatch(createHandlers(services), …)`), a real SQLite database, the real importer over the
recorded Zotero fixtures. `[B01]` asserts the document returns *under the same id* — `rowCount()`
before and after, plus `externalReferences.resolveEntityId(…) === victim.id` — which is the check
that catches a "restore" implemented as a fresh document wearing the old title. `[B01] importing a
different collection does not bring it back` picks the other collection from outside the victim's
whole ancestor closure (`library-curation.test.ts:180-187`), so it cannot pass by accident. The
removal survives a real service teardown/rebuild. None of these would pass against a constant.

**V3 — B03 recoverability is proven by round trip, not by absence of an error.**
`[B03] importing the collection again gives the work back with the document`
(`library-curation.test.ts:363-386`) re-reads the annotation through the `annotation:listByDocument`
channel after the restore and finds it by id, and re-reads the question's notebook page and finds the
document still carded on it. `[B03] a removal keeps the annotations and links made on the document`
checks the comment text and `deletedAt === null`, not merely row existence. Confirmed in the
implementation: `library.remove` soft-deletes (`documents.softDelete`) and touches neither
`annotations` nor `links` (`packages/database/src/repositories/library.ts:61-84`). The one thing it
does destroy is the search entries — see F2.

**V4 — B04's hash covers a file the code under test could genuinely have reached.**
`writeZoteroDatabase` creates a real openable SQLite database at
`join(zoteroDataDir, 'zotero.sqlite')`, and that same `zoteroDataDir` is what the services are
constructed with (`library-curation.test.ts:91-96` → `apps/desktop/src/main/services.ts:162,219`),
so it is the importer's attachment-resolution root *and* a member of the `rrfile://` allow-list
(`services.ts:193`) — i.e. the exact path the app would use if it ever looked. The assertion is
sha256 **and** size **and** mtime, plus the absence of `-wal` and `-journal` sidecars, so "not even
opened" is checked rather than "not modified". The window spans import, remove, forced re-import,
scoped restoring import, and a local file add. Grep confirms no code path anywhere opens
`zotero.sqlite`; the Zotero client is GET-only over the local HTTP API. Holds.

**V5 — B02 adds the file where it lies.** `LocalFileLibrary.add` resolves through symlinks first,
admits **that one path** (never its directory) to the allow-list, persists the admission in settings
and re-applies it at startup (`local-files.ts:126-140, 268-284`). The E2E checks the inode is
unchanged and that no second copy of the file exists anywhere under the workspace
(`tests/e2e/library.spec.ts:136-138`), reads `document_files.path` and `documents.source` straight
out of the database, and re-opens the PDF in a *second process* — which can only work if the
admission was remembered. The integration half additionally exercises the dialog through the injected
`chooseFiles`, and the production chooser refuses to open a modal under `WR_BACKGROUND`
(`apps/desktop/src/main/index.ts:150-154`). No mock stands in for anything that could have been real.

**V6 — B05 drives a real socket.** `tests/e2e/support/zotero-api.ts` serves the recorded fixtures over
an actual HTTP server on an ephemeral 127.0.0.1 port (never 23119, so a Zotero someone starts cannot
be read), handed to the app via `WR_ZOTERO_ENDPOINT`. That variable is production configuration
gated by `resolveZoteroEndpoint`, which parses the URL and checks `url.hostname` — so
`http://127.0.0.1@evil.invalid/` and `http://localhost.evil.invalid/` are refused rather than
string-matched, non-http(s) schemes are refused, and credentials are refused; a refusal falls back to
the default and is logged. The `[B05]` E2E removes a filed document, presses Import on that
collection's row, sees it return under the same id, and then asserts the remembered scope is
untouched — i.e. it distinguishes the one-off gesture from the standing decision.

**V7 — G03 asserts the trap.** `[G03]` (`tests/integration/graph.test.ts:562-609`) imports from the
real fixtures so the title under test is the provider's, sets a display name, then runs a
`force: true` re-import — the run that rewrites every field Zotero owns — and re-reads
`documents.getById(documentId)?.title` from the database, unchanged, with the display name still on
the node afterwards. It also asserts `JSON.stringify(document)` does not contain the new name, which
closes off a write-through hidden in another column. Confirmed in the implementation:
`graph_node_names` is a separate table keyed by `(entity_type, entity_id)`
(`packages/database/src/repositories/graph.ts:106-136`), the IPC channel takes an entity and not a
document (`packages/shared-types/src/ipc.ts:745-752`), `GraphNode` carries `displayName` beside
`title` rather than replacing it, and a source-level test asserts the graph panel never calls
`document:update`. Holds.

**V8 — G06's parentage comes from the query.** `GraphNode.parent` is computed in
`packages/database/src/repositories/graph.ts:278-294`, off the same `EntityResolver.describe` that
supplies the title: only `annotation` descriptions carry a `documentId`
(`packages/database/src/entity-resolver.ts:189-196`); notes, questions and hypotheses return null,
and a document is excluded from being its own parent. Critically, a container the node cap or depth
bound dropped is *not* claimed — `drawn.has(key('document', containerId))` — and
`[G06] claims no container the view was not sent` (`tests/integration/graph.test.ts:431-454`) proves
it by seeding on the note at depth 1 (parent null) and depth 2 (parent present). That test fails if
parentage is fabricated anywhere, and the renderer's `data-parent-id` is read straight off the IPC
response (`apps/desktop/src/renderer/graph-panel.tsx:316-321, 806`). Containment does not replace the
edge — the `annotation-belongs-to-document` link is still sent and the E2E asserts it stays inside
the group while the wikilink crosses (`tests/e2e/graph.spec.ts:544-560`). The layout half is
Cytoscape compound nodes, not hand-drawn rectangles: `createGraph` sets real `parent` data,
`layoutPositions` skips `node.isChild()` when building rings and orbits children round their
container instead, and `groupBoxes` derives each rectangle from where the contents *actually ended
up* after spacing (`packages/graph/src/index.ts:50-58, 187-235, 250-273`). The E2E checks geometric
enclosure both ways ("neither box has swallowed the other paper"), so a box that had drifted off its
contents would fail.

**V9 — G01/G02 persist through the database, not through renderer state.** Viewports and settings go
over zod-validated channels (`ipc.ts:723-792`) into the `settings` table via `GraphViewRepository`,
which re-parses on read and falls back to schema defaults for a value it cannot read
(`packages/database/src/repositories/graph-view.ts`). Viewports are keyed per `(seedType, seedId)`
and bounded at 64 with LRU eviction, tested directly. The `[G01]` E2E uses real wheel and drag
gestures on empty canvas, *closes the graph tab* (asserting the panel is gone) and reopens it, then
guards against the trap of a "restored" resting viewport by asserting the recorded zoom > 1 and
pan > 0. `[G02]` compares across two processes and checks the drawn `transform` of a named node —
not just the control values — plus the header reporting the depth the *answer* came back with, so a
setting recorded without re-querying fails.

**V10 — no escape hatches in the milestone-4 diff for this scope.** Searching `fde3e38..HEAD` over
`apps/desktop/src`, `packages` and `tests` for added `as unknown as`, `as any`, `: any`,
`@ts-expect-error` or `eslint-disable` returns only three hits, all in an E2E spec inspecting the
preload bridge surface off `globalThis`. Nothing in the library or graph paths.

**V11 — CLAUDE.md invariants not regressed by this code.** Renderer packages import no `electron`,
`better-sqlite3`, `@wr/database` or `@wr/zotero-adapter`; `library:addFiles` returns document ids and
counts and never a path (`handlers.ts:477-498`), and the drop path resolves the path in the preload
onto a channel the page cannot address; icons travel as file ids resolved through `rrfile://`;
removal is soft and all relationships stay typed edges in `links` — no new untyped table; Zotero item
keys stay in `external_references`; `~/Zotero/zotero.sqlite` is never opened. The verifier was
strengthened, not weakened: `scripts/verify_completion.py` gained N09/N10/N11 and B05 and re-worded
B01's description to match the re-specified criterion; no tag or check was removed.

---

## Bottom line

Two findings of blocking weight, both in B01/B03 and both provable from the shipped code plus tests
that are already green:

- **F1 (major)** — the routine sync restores removals whenever an import scope is remembered,
  because the standing scope and the one-off request reach the importer through the same parameter.
  The tagged test holds only for an unscoped library.
- **F2 (major)** — `index-fts`, the queue the restore path uses to say "searchable again", has no
  consumer; the `[B01]` assertion about it is vacuous, and a removed document's annotation search
  entries are deleted and never rebuilt on any path.

G01, G02, G03 and G06 hold under everything I could throw at them, including each trap the milestone
doc named for them. B02, B04 and B05 hold. B03's data-recoverability holds; its search half does not
(F2), and its interface tells two of three document classes a way back that does not exist (F3).
