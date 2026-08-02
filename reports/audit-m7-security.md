# Milestone 7 — security & data-handling lens

Range audited: `be7508a..a912606` (31 commits, 118 files).
Lens: the IPC surface and zod on every new/changed channel; the MH3 fetch path (`B06`) — set
listing, art crops, allow-list on every hop, caching, and whether the renderer ever fetches;
the in-app drag payloads (`H08`/`H09`); the demo seed (`B07`) — no network, no real data, and
whether it is genuinely development-only; trash and delete data handling (`U11`); and a
regression pass over `CLAUDE.md`'s security and architecture sections.

`docs/MILESTONE7.md`'s **Supersessions** list was read first. Nothing below is called a
regression against `K01`, `N06`, `N07`, `E01`, `N09`, `I01` or `V01`: those criteria are
re-promised here and their behaviour is *meant* to have changed.

Method: read the whole diff; ran `tests/integration/demo.test.ts`,
`tests/integration/card-art.test.ts`, `packages/workbench`, `packages/shared-types`,
`packages/document-model` and `tests/integration/guide-controls.test.ts` (327 tests, all green);
ran one throwaway probe against the integration harness to falsify a hypothesis about
overlapping `demo:fill` calls (the hypothesis was wrong — see *Falsified*), and removed it.
No E2E run. The working tree is unchanged apart from this file.

**No critical or major finding.** Eight minor findings follow, each with a file and a line.

---

## Findings

### m1 — The demo library writes its journal days on the UTC date, not the researcher's day

`apps/desktop/src/main/demo.ts:678-680` (used at `:635` and `:639`)

```ts
function isoDay(when: Date): string {
  return when.toISOString().slice(0, 10);
}
```

This is the exact mistake `localDay` exists to prevent. `packages/document-model/src/calendar.ts:1-13`
says so in as many words — *"Slicing an ISO instant at ten characters is the mistake this exists
to prevent: it says tomorrow for anything written after 5pm in California"* — and
`state/NEXT_ACTION.md` repeats it as a trap. `JournalRepository.start`
(`packages/database/src/repositories/journal.ts:142`) and the journal page
(`apps/desktop/src/renderer/journal-panel.tsx:79-80`) both use `localDay`. `demo.ts` is now the
only module in the tree that does not.

Confirmed live on this machine (`America/New_York`, 2026-08-01 20:29 local):
`toISOString().slice(0,10)` → `2026-08-02`, `localDay()` → `2026-08-01`.

Consequence, right now: `JOURNAL_DAYS`' `daysAgo: 0` entry is written under **tomorrow's**
date. The journal page builds its calendar as `calendarMonths({ from, to: today, today, logged })`
with `today = localDay()` (`journal-panel.tsx:287-294`), so that entry falls outside the calendar
entirely — it is unreachable from the page — and today's cell, the one the demo meant to fill, is
empty. For roughly seven hours of every day in this timezone, `B07`'s "fills every surface" is
false for the journal.

No test can see it: `tests/e2e/demo.spec.ts:93-101` asserts only that *some* day is marked
`data-logged="true"`, and `tests/integration/demo.test.ts:98` counts days without checking which.

Fix is one line: `import { localDay }` and delete `isoDay`.

### m2 — Migration 014 destroys the desk's arrangement before the pass that would have used it

`packages/database/src/migrations/014_desk_retired.ts:16-18` and
`apps/desktop/src/main/services.ts:180-197`

`openDatabase` runs the migrations (including `DROP TABLE IF EXISTS card_positions`) at
`services.ts:180`; `retireTheDesk` runs at `services.ts:190`. So by the time the pass that turns
cards into blocks looks at anything, the only data the desk ever held that was uniquely the
researcher's hand — where each card was *dragged to* — is already gone. `retireTheDesk`
(`apps/desktop/src/main/desk-retirement.ts:83-89`) therefore emits blocks in
`findReferences` order, i.e. edge-creation order, and could not have done otherwise.

`docs/MILESTONE7.md:75` says of `P06`: *"nothing the researcher placed is lost"*. The edges are
kept and that is the substance of the criterion; the *placement* is not, and ordering the landing
blocks by stored position where one existed would have been cheap. Running the drop after the
pass — or reading the positions in `retireTheDesk` and dropping the table in migration 016 next
milestone — keeps the option open. As written the option is foreclosed rather than declined,
which is worth recording because it is irreversible on the researcher's first launch of the new
bundle.

Not a regression against `N06`/`N07`/`E01` — those are superseded by `P06`.

### m3 — A page open on a notebook you just deleted keeps working, and says nothing

`apps/desktop/src/renderer/notebook-panel.tsx:268-277`, `apps/desktop/src/main/handlers.ts:1019-1021`

`question:delete` now *bins* and still publishes `notebook:changed { reason: 'deleted' }`. The
page's handler for that reason is:

```ts
if (payload.reason === 'deleted') {
  // Re-read rather than guess at the message: `load()` asks for a notebook that is not
  // there and shows what the main process says about it …
  void load();
  return;
}
```

The comment was true under `I01` and is false under `U11`: the row *is* still there, so
`question:notebook` (`handlers.ts:1090`) succeeds — it never looks at `trashedAt` — and the page
re-renders as an ordinary, editable notebook. `isInTrash` has exactly two readers,
`queue-panel.tsx:301` and `notebook-directory.tsx:183`; neither the notebook page nor the journal
page knows the bin exists.

So a tab left open on a discarded notebook that is then deleted goes on accepting writing, with
nothing on screen saying where the notebook now is, and that writing is destroyed by
`question:emptyTrash` along with everything else in the bin. The bin is otherwise well built —
the confirmation is on the emptying (`queue-panel.tsx:539-566`), it names what goes and what
stays, and `emptyTrash` is not registered as a command so it is not palette-reachable.

Smallest honest fix: have the page read `question.trashedAt` and say so, the way the discarded
shelf says why something was dropped.

### m4 — `demo:status.available` has no consumer, so a packaged build still offers both demo commands

`packages/workbench/src/workbench.ts:952-975`, `apps/desktop/src/renderer/host.ts:700`,
`packages/shared-types/src/ipc.ts:986-989`

The contract says: *"In a packaged build both refuse and `demo:status` says so, which is how a
surface knows not to offer them."* Nothing in the renderer calls `demo:status` — its only callers
are `handlers.ts:1403` and `tests/integration/demo.test.ts`. `COMMAND_IDS.fillDemoLibrary` and
`COMMAND_IDS.clearDemoLibrary` are registered unconditionally, so in a shipped bundle the palette
and the help page both offer *Fill the Library with Demo Content*, and pressing it returns a
`CONFLICT`.

The security-relevant half is correct and is where it belongs: `DemoLibrary.fill`/`clear` check
`#available` themselves (`demo.ts:313`, `:355`), `available` defaults to `false` when nobody says
(`services.ts:318`), and `app.isPackaged` is read once at `main/index.ts:24`. This is the
*offering* half being unimplemented, not the gate.

### m5 — The demo root is created and joined to the served allow-list even where the demo can never exist

`apps/desktop/src/main/services.ts:207`, `:217`, `:224`

```ts
const demoRoot = options.demoRoot ?? defaultDemoRoot(options.databasePath);
mkdirSync(demoRoot, { recursive: true });
const allowed = new SwappableRoots(
  [zoteroDataDir, workspaceRoot, cardArtRoot, demoRoot, ...(options.extraRoots ?? [])],
  corpusRoot,
);
```

None of this is conditional on `options.development`. A packaged build creates
`<userData>/demo` and adds it to the fixed roots `rrfile://` will serve from, while `demo:fill`
refuses and nothing else ever writes there. Not reachable today — `rrfile://` takes file ids and
resolves them through `document_files`, and the only code that mints a row under this root is the
demo importer, which cannot run — but it is the same shape as the gap `docs/SECURITY.md:99-102`
already records about the agent workspace: a served root wider than the capability behind it.
Gating both the `mkdirSync` and the array entry on `development` costs one conditional.

### m6 — The 8 MB card-art cap is applied after the whole reply has been buffered in the main process

`apps/desktop/src/main/card-art.ts:454` (listing) and `:504` (crop)

```ts
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.byteLength > MAX_ART_BYTES) throw new CardArtRefusedError(…);
```

`MAX_ART_BYTES` bounds what reaches the disk, which is what its docstring claims
(`card-art.ts:96-103`), but not what reaches memory. A compromised or hostile
`api.scryfall.com`/`cards.scryfall.io` can answer with an arbitrarily large body and the main
process — the one that owns the synchronous better-sqlite3 handle — buffers all of it before
refusing. The image path is pre-existing (milestone 4's security lens covered card art in detail
and did not raise it, `reports/audit-m4-security.md:20`); the **listing** path is new in this
range, and `gallery()` (`card-art.ts:395-408`) issues up to 60 of these per call with no overall
budget, so one `cardArt:gallery` can be 60 × 15 s of hung handler in the worst case.

Off by default and behind a disclosure, and the host is fixed by construction, so this is a
resilience bound rather than a hole. Closing it means reading the body as a stream and aborting
past the cap, or trusting `content-length` as a first cheap refusal.

### m7 — The set listing is the one remote-controlled payload in the app with no bounds on it

`apps/desktop/src/main/card-art.ts:141-150`, `packages/shared-types/src/domain.ts:1005-1013`,
`packages/shared-types/src/ipc.ts:1088`

`ListingSchema`'s `data` array has no `.max()`, and `name`/`artist` have no length bound;
`CardArtGalleryEntrySchema` is likewise `z.string()`. These are the only strings in the
application that a remote server chooses and that then cross into the renderer (as tile labels,
React keys and `data-card-name` at `graph-panel.tsx:1043`). The stripping is right — `passthrough`
is deliberately absent, so prices and rulings URIs are dropped — but the shape is unbounded where
every other externally-sourced payload here is bounded.

There is also a live inconsistency: `cardArt:fetch.name` is `.max(200)` (`ipc.ts:1088`) while the
gallery's names are not, so a name longer than 200 characters renders a tile that is refused when
pressed. No real Magic card name is close to that, so this is defence in depth, not a bug anyone
will hit; it is worth one `.max()` on each of the three because the reply is untrusted input by
the module's own argument.

### m8 — `appendNotebookBlocks` takes its dedupe key from the block's text, which a document controls

`apps/desktop/src/main/notebook-body.ts:16`, `:49-55`

```ts
const INTERNAL_LINK_RE = /\((?:document|annotation|note):\/\/[^\s)]+\)/u;
…
const reference = INTERNAL_LINK_RE.exec(block)?.[0] ?? null;
```

`exec` returns the **first** internal link in the block, not the block's own identity link.
An excerpt block is `> …quoted text…\n>\n> — [title](annotation://ann_x)`, and `quoteText`
(`packages/document-model/src/excerpt.ts:43-46`) escapes `[`, `]`, `` ` ``, `*`, `<`, `~`, `|`
and the line-leading characters — but not `(` or `)`. So a highlight whose selected text
literally contains `(document://doc_…)` — text a PDF or an archived page controls — supplies the
dedupe key instead of its own `annotation://` link, and the block is then skipped whenever the
page already mentions that id, or suppresses a later genuine reference to it.

Weaponising it needs the attacker to guess a minted id, so the realistic failure is a *send that
silently does nothing* rather than anything sharper; nothing is destroyed either way. The fix is
to pass the identity link down from the caller, which already knows it (`handlers.ts:1079`,
`desk-retirement.ts:44-64`), rather than re-deriving it from prose.

---

## Falsified

**Overlapping `demo:fill` calls do not leave residue.** `fill()` reads the `demo.seed` setting
and creates notebooks in `#openNotebooks` (`demo.ts:549-675`), which looked like a
read-then-write race across the two `await`s above it. Probed with two concurrent `demo:fill`
invocations through the integration harness: 3 notebooks made, 0 left after `demo:clear`, 0 demo
documents left. Everything after the last `await` in `fill()` is synchronous, so the
read-check-write is atomic on a single-threaded runtime. The probe file was deleted; the tree is
clean.

---

## Checked and found sound

**The IPC surface.** Exactly five channels were added and one removed, confirmed by diffing the
channel-key sets at both commits: `+cardArt:gallery`, `+demo:status`, `+demo:fill`,
`+demo:clear`, `+question:emptyTrash`, `+question:restoreFromTrash`, `-question:placeCard`.
Every one has a zod request *and* response in `IPC_CHANNELS`, and every one is dispatched through
`dispatch()` (`main/router.ts:136-185`), which parses the request before the handler runs and
re-parses the response outside production. `question:attach` gained `landsAsBlock` with a
`.default(true)`; `question:delete`'s response changed shape; the `notebook:changed` reason enum
lost `page-drop` and no publisher still sends it (grepped: zero hits tree-wide). `ipcMain.handle`
appears only in the router. `docs/IPC.md` and `docs/SECURITY.md` were both updated for the new
network channel rather than left to drift.

**Nothing on a channel takes a path or a URL.** `demo:fill`/`demo:clear` take `empty`;
`demo:status` takes `empty`; `cardArt:gallery` takes an offset and a count with
`.max(60)`. The three demo responses are counts. `cardArt:gallery`'s response is names, artists
and `DocumentFileId`s — never a URL. `wr:drop` is untouched and remains unreachable from the
bridge; the preload's `DropTarget` lost the desk's attribute and gained nothing
(`preload/index.ts:75-107`), and the bridge still exposes exactly `invoke` and `subscribe`.

**The MH3 fetch path.** Two request shapes, two gates, correctly separated. `LISTING_TYPES`
(`card-art.ts:94`) admits only `application/json` and is checked against the *reply's* header
before a byte is written (`:447-452`); `IMAGE_TYPES` is unchanged and still excludes
`image/svg+xml`. Crops still go through `artUrl(name)` (`:632-638`), built here from a name with
`URLSearchParams`, so no listing reply can turn a crop request into a whole-card request. The
listing URL is likewise built here (`:126-132`) — the renderer supplies neither set nor query.
`#request` applies `#assertAllowed` on **every** hop including the first (`:543-581`), checks
scheme (`https:` only) and `host` (port included, so `api.scryfall.com:8443` is refused), follows
at most three redirects manually with `redirect: 'manual'`, `referrerPolicy: 'no-referrer'`,
`credentials: 'omit'` and no header but `accept`. Both `gallery()` and `illustrate()` open with
the `enabled` check before anything is built, so "off" means no request. The listing is cached on
disk under its own SHA-256-of-URL stem with a `.json` extension, distinct from the crops', and is
re-parsed through the same schema on read. Eight of the eighteen card-art integration tests are
new and cover exactly these properties, including *"asks for the art crop alone, never a whole
card"* and *"refuses a listing that is not JSON, and keeps nothing"*.

**The renderer never fetches.** No `fetch`, `XMLHttpRequest`, `WebSocket` or `new Image()`
anywhere under `apps/desktop/src/renderer`; no `https://` literal in the renderer,
`@wr/workbench` or `@wr/shared-ui`. Gallery tiles draw over `rrfile://<iconFileId>` and nothing
else (`graph-panel.tsx:1053`). The E2E seeds the cache with the app's *own* `setListingUrl()` and
`artUrl()` hashed the way the app hashes them (`tests/e2e/support/card-art.ts:25,57-59`), so the
suite cannot reach the network and cannot pass with a stale URL spelling.

**The drag payloads.** `H08` (`panels.tsx:203-259`) keeps `{ annotationId, documentId,
overDocumentId }` in the renderer store and reads the drop target off `data-document-id` via
`elementFromPoint`; `H09` (`graph-canvas.tsx:404-515`) keeps `{ entityType, entityId }` read off
`data-entity-type`/`data-entity-id`. Neither touches `DataTransfer`, neither goes near `wr:drop`,
and both end by running `COMMAND_IDS.createDocumentLink`, which resolves the type through
`defaultLinkType` and bounds it with `linkTypesFor` (`workbench.ts:1278-1316`) before
`link:create` re-validates both endpoint types against `LinkableEntityTypeSchema`
(`ipc.ts:737-740`). A bogus `entityType` scraped from a DOM attribute is refused at the boundary.
No filesystem path is on either bridge. `tests/integration/local-files.test.ts:196-250` now
asserts positively that the page body contains `(document://…)` and **not** the inbox path.

**The demo seed.** No network import and no network call in `demo.ts`; the six papers are prose
written for the file, the three notebooks and the journal entries likewise, and nothing is copied
from a real library. It runs the *real* `MarkdownCorpusImporter` over its own root with its own
`source` tag (`corpus.ts:102`, `demo.ts:279-284`), so the papers carry real slugs, real wikilink
edges and real index rows; highlights are real `createMarkdownAnchor` anchors. `clear()` is one
predicate — the `source` column plus two id lists in `demo.seed` — with no bookkeeping table to
drift, deletes annotations' polymorphic edges before purging the document in the same order
`purgeOutsideRoot` uses, and runs in a transaction (`demo.ts:354-399`).
`tests/integration/demo.test.ts:110-147` asserts the researcher's own rows survive it. Nothing
demo-related is committed to the repository.

**Trash and delete.** `trashed_at` is a nullable column, not a fourth status (migration 015), so
`question:delete`'s discard-first precondition is unchanged and still enforced in main
(`handlers.ts:1009-1017`) rather than only in the panel. `questions.trash` refuses a
non-discarded notebook at the repository level too (`questions.ts:214-217`). `update()` does not
touch `trashed_at`, so restoring cannot silently clear it. `emptyTrash` runs the same audited
`delete` per notebook, one transaction each. The three surfaces that pick a notebook
(`overlays.tsx:944`, `journal-panel.tsx:153`, `host.ts:583`) filter to `['active','queued']`, so a
binned notebook cannot be picked as a target. `library:removeDocument` is deliberately not in the
bin, as `state/NEXT_ACTION.md` records.

**`CLAUDE.md` regression pass.** `main/index.ts` gained one line (`development: isDev`) and
nothing else; `contextIsolation`/`nodeIntegration`/`sandbox` and the absence of
`webSecurity: false` are untouched. `apps/desktop/src/renderer/index.html`'s CSP is byte-identical
(`default-src 'self'; script-src 'self'; … object-src 'none'; base-uri 'none'; form-action
'none'`). `main/protocol.ts` and `main/paths.ts` are unchanged. No renderer package imports
`electron`, `better-sqlite3`, `@wr/database` or `@wr/zotero-adapter` (grepped independently of the
lint rule). Raw HTML in markdown still renders as `<code>` rather than markup
(`packages/markdown-reader/src/render.tsx:200-207`) and link hrefs still go through `safeHref`, so
a document title carried into a page block by `documentReferenceMarkdown` cannot become markup —
its `[`/`]`/`\` are escaped by `linkText` (`excerpt.ts:61-64`). `scripts/verify_completion.py` is
byte-identical across the range. `~/Zotero/zotero.sqlite` is not touched anywhere in the diff.

**Guide coverage holds.** `packages/workbench/test/guide.test.ts` (13) and
`tests/integration/guide-controls.test.ts` (3) pass, so every new command — including
`fillDemoLibrary`, `clearDemoLibrary`, `openLibrarian` — and every new `data-control`
(`graph.gallery`, `link.dragNodes`, `link.dragHighlight`, `notebook.emptyBin`) is declared and
drawn.
