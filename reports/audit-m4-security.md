# Independent audit — milestone 4, security surface

- **Audited-commit:** `c072375` (branch `main`)
- **Diff under audit:** `fde3e38..c072375`
- **Lens:** falsify "milestone 4 is complete and safe" on the security surface it *added* —
  `G05` (card art), `G04` (node icons over `rrfile://`), `B02`/`N07` (admitting a file from
  disk), the IPC router, the unchanged invariants, the disclosure documents, and type escapes.
- **Method:** read the diff; verify by execution where a claim is about parsing, containment or
  network behaviour. No real request was made to any allow-listed host; no E2E was run; nothing
  in the tree was modified except this file.
- **Not re-audited:** milestone 3's findings (`reports/audit-m3-security.md`). Checked only for
  regression; see "Milestone-3 ground: checked for regression".

---

## Findings

| # | Severity | Finding |
|---|---|---|
| M4-1 | **major** | The "one allow-listed host" bound on card art is enforced on the *first hop only*. `redirect: 'follow'` is pinned into the request init and nothing afterwards inspects `response.url` or `response.redirected`, so whatever host the first hop names in `Location` serves the bytes that get cached and then served over `rrfile://`. |
| M4-2 | minor | `MAX_ART_BYTES` is checked *after* `response.arrayBuffer()`, and the reply is transparently decompressed, so 65 KB on the wire becomes 64 MB in the main-process heap before any bound applies. The cap bounds the disk, not the process. |
| M4-3 | minor | `SwappableRoots.withdraw` has no caller anywhere in the tree. The admitted-file allow-list only ever grows; removing a locally added document leaves its exact path readable for the life of the installation. |
| M4-4 | minor | `question:update.coverFileId` checks the file exists but not that it is an image, while `graph:setNodeIcon` — the same "put an `rrfile://` id behind an image element" shape — checks both. |
| M4-5 | minor | Four new channels take `entityId: z.string().min(1)` with no `.max()` and, for `graph:setNodeName`, no existence check. This widens the gap `docs/SECURITY.md` already records for `link:create` rather than closing it. |
| M4-6 | minor | `README.md` still says "**Status: milestone 3**" at a HEAD where milestone 4 is claimed complete, and its "nothing in the application makes a network request" omits the `127.0.0.1` Zotero local API that `docs/SECURITY.md` is careful to name. |

Nothing critical. One major.

---

## M4-1 — the one-host bound holds for one hop (major)

**Claim under test.** `docs/MILESTONE4.md:25-27` — "one allow-listed host".
`docs/SECURITY.md:28-34` — "One host, `api.scryfall.com`, named in the disclosure and built in
the main process from a constant — `cardArt:fetch` takes a card's *name*, never a URL, so the
channel cannot be aimed at a server of the caller's choosing."
`README.md` — "fetched from one host — `api.scryfall.com` — and nowhere else."

**What the code does.** `apps/desktop/src/main/card-art.ts:328-349`:

```ts
async #request(url: string): Promise<Response> {
  const host = new URL(url).host;                       // the *input* url
  if (host !== CARD_ART_HOST) throw new CardArtRefusedError(...);
  return await this.#fetch(url, {
    headers: { accept: ... },
    redirect: 'follow',                                 // pinned, and typed as required
    ...
  });
}
```

`redirect: 'follow'` is not incidental — it is a required field of `CardArtRequestInit`
(`card-art.ts:209`). And:

```
$ grep -c "response.url\|redirected" apps/desktop/src/main/card-art.ts
0
```

So the final URL is never consulted. `#fetchAndKeep` (`card-art.ts:289-326`) takes
`response.headers.get('content-type')` and `response.arrayBuffer()` from whatever answered
last, writes the bytes into the card-art cache root, and mints a `document_files` row that
`rrfile://` will serve.

**Executed proof** (`/tmp/wr-audit/check-redirect.mjs`, two loopback servers standing in for
"the allow-listed host" and "anywhere else", using verbatim the init `card-art.ts` passes):

```
host checked before the request : 127.0.0.1:54738
response.ok                     : true
content-type seen by the code   : image/png
bytes served by                 : 127.0.0.1:54737 (the host that was never checked)
response.url (never read by code): http://127.0.0.1:54737/elsewhere.png
response.redirected             : true
bytes accepted and cached?      : yes — 70 bytes
```

The host check passes, the bytes come from somewhere else, the content-type check passes on the
*second* host's header, and the code has no way to tell.

**Two ways this bites, and they are not alternatives.**

1. *The feature appears to depend on it.* `artUrl` builds
   `https://api.scryfall.com/cards/named?exact=…&format=image&version=art_crop`. That is
   Scryfall's redirect-to-the-image endpoint; the image itself lives on Scryfall's CDN, a
   different host. If that is so, then in production the picture is fetched from a host that is
   named in neither the disclosure, nor `docs/SECURITY.md`, nor `README.md`, and the sentence
   the researcher reads before consenting is false. If it is *not* so, then `redirect: 'follow'`
   is unnecessary attack surface that no test covers. I could not resolve which without making
   the network request the brief forbids, so I state the disjunction: **either branch is a
   defect**, and neither is asserted anywhere.
2. *The https guarantee does not carry.* `artUrl` fixes the scheme to `https:`, which is what
   defeats DNS rebinding on the first hop — a rebound `api.scryfall.com` cannot present a valid
   certificate. That protection ends at the redirect: the second hop's scheme and host come from
   a response header, and `fetch` applies no downgrade or loopback restriction to a
   redirect target. A `Location: http://127.0.0.1:<port>/…` is followed. The main process's
   `fetch` is Node's, so `lockDownNavigation`'s `session.webRequest.onBeforeRequest` — which
   cancels every non-loopback request the *renderer* session makes — does not see it either.
   (Loopback-following is executed above; the https→http case is reasoned, not executed.)

**What is *not* wrong here**, and was checked:

- The URL is airtight against a hostile `name`. Executed (`/tmp/wr-audit/check-arturl.mjs`)
  against `@evil.example/x`, `x#@evil.example`, a CRLF header-injection attempt,
  `../../../../etc/passwd`, `x&format=json`, unicode and a 200-char name — every case produced
  `host=api.scryfall.com path=/cards/named user="" format=image`. `URLSearchParams` percent-
  encodes CR/LF, `#` and `&`; no userinfo, no path segment, no parameter override escapes.
- The request carries nothing about the researcher. Executed
  (`/tmp/wr-audit/check-headers.mjs`) — the wire carries `host`, `connection`, `accept`,
  `accept-language: *`, `sec-fetch-mode`, `user-agent: node`, `accept-encoding`. No cookie, no
  referer, no authorization, no application or version string, no document or library id
  anywhere in the path or query. `credentials: 'omit'` and `referrerPolicy: 'no-referrer'` are
  both set. The disclosure's "no cookie, no referrer, no account" is accurate.
- Off by default and gated. `readCardArtSettings` defaults `enabled: false`;
  `illustrate` (`card-art.ts:260-263`) checks the switch *before* building a URL, so "off"
  means no request rather than a discarded one. `setCardArtEnabled` refuses `enabled: true`
  without an acknowledgement, now or previously. Asserted by `[G05]` at
  `tests/integration/card-art.test.ts:137-176`, including `attempts == []`.
- The second request does not leave the machine, and I believe the test. `#cached` requires
  *both* a file on disk under `sha256(url)` *and* a `document_files` row naming it, so an
  emptied cache directory re-fetches rather than pointing at a file `rrfile://` refuses. The
  test counts requests across a real `close()`/re-open of the services
  (`card-art.test.ts:216-250`): one attempt for two nodes and one restart, and
  `status.cached === 1`. A memory-only cache would fail the third leg.
- Content-type is an allow-list of four, not an `image/` prefix test, and `image/svg+xml` is
  deliberately absent. The check runs *before* `writeFile`, so a refused reply never sits in the
  directory `rrfile://` serves (asserted, `card-art.test.ts:252-276`, including
  `readdirSync(cache) === []`).
- Where the bytes land: `join(root, sha256hex) + extension`, extension drawn from the fixed
  table. Hex only — no traversal is expressible in the filename. The root is
  `<userData>/card-art`, created before `SwappableRoots` resolves it (`services.ts:180-195`),
  which is the right order on macOS where `/var` → `/private/var`.
- The renderer cannot fetch. `cardArt:fetch` takes `{entityType, entityId, name}` and no URL
  (`ipc.ts:835-846`); `graph-panel.tsx` contains no `https://` and no host string, asserted by
  `card-art.test.ts:314-330`. Independently, the renderer's own session is denied: CSP
  `connect-src 'self' rrfile:` and `img-src 'self' data: blob: rrfile:`
  (`src/renderer/index.html:18`), plus `blocksRemoteRequest` cancelling every non-loopback
  http/https/ws/wss request on `session.defaultSession`. Two layers, independently sufficient.

**Suggested fix (not applied — this audit is read-only):** either set `redirect: 'manual'` and
re-check the host of each `Location` against a small explicit list, or keep `follow` and refuse
after the fact on `new URL(response.url).host !== CARD_ART_HOST`. If the CDN host is genuinely
required, it belongs in the constant, in the disclosure prose, and in `README.md` — the
researcher is being asked to consent to a specific sentence.

## M4-2 — the 8 MB cap bounds the disk, not the process (minor)

`card-art.ts:303-307`:

```ts
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.byteLength === 0) throw ...
if (bytes.byteLength > MAX_ART_BYTES) throw ...
```

The whole body is materialised before the cap is consulted, there is no `content-length`
pre-check, and the body is not streamed. `undici` advertises `accept-encoding: gzip, deflate`
by itself and decompresses transparently.

Executed (`/tmp/wr-audit/check-cap.mjs`):

```
request accept-encoding         : gzip, deflate
content-type (allow-listed?)    : image/png
bytes on the wire               : 65250
bytes materialised in memory    : 67108864
over the 8 MB cap?              : true
amplification                   : 1028x
```

`docs/SECURITY.md:32` says the reply "is capped at 8 MB". True of what reaches the cache
directory; not true of what reaches the heap. `AbortSignal.timeout(15_000)` bounds how long the
body may take, which is a real limit but a generous one. On its own this is a denial of service
sourced from a host the researcher opted into, which is why it is minor — but it is the natural
second half of M4-1: a redirect to an unchecked host turns a 65 KB response into a main-process
out-of-memory.

## M4-3 — the admitted-file list only grows (minor)

```
$ grep -rn "withdraw" apps/desktop/src packages tests
apps/desktop/src/main/paths.ts:217:  withdraw(path: string): boolean {
```

One definition, no callers. `library:removeDocument` does not withdraw the path of a document
that was added from disk, and `LocalFileLibrary` never prunes `library.admittedFiles`, so the
allow-list is monotonic up to `MAX_ADMITTED_FILES = 2000`.

`docs/SECURITY.md:47` — "A file added from disk widens the allow-list by exactly one **file**"
— is accurate about the *width* of each admission and is properly asserted
(`local-files.test.ts:136-164`, sibling refused, and again after a restart at `:153-164`). What
it does not say is that the widening is permanent. This is arguably consistent with milestone
4's own rule that "a removal means not now" and with `B03` keeping annotations recoverable, so
I am not calling it a contradiction — but the presence of dead `withdraw` says the intent
existed and was not carried through, and the list is a security surface the researcher cannot
see or prune.

## M4-4 — one of the two "id behind an image element" channels is unguarded (minor)

`handlers.ts:1009-1019` (`graph:setNodeIcon`) checks the file exists **and** that
`/^image\//i.test(file.mimeType)`, with a comment explaining exactly why. `handlers.ts:703-708`
(`question:update`) checks only that `coverFileId` names a row, and
`notebook-panel.tsx:244` renders `<img src={`rrfile://${question.coverFileId}`}>`. The
consequence today is a broken image rather than a leak — an `<img>` will not execute a PDF, and
`snapshotSecurityHeaders` is not what protects here — but the two channels have the same shape
and only one has the guard.

Related, and worth stating because `image/svg+xml` is excluded from card art on exactly this
reasoning: `graph:setNodeIcon`'s `/^image\//i` **does** admit `image/svg+xml`. A library SVG can
become a node icon. It is drawn as an SVG `<image href="rrfile://…">` (`graph-panel.tsx:835`),
which Chromium loads in secure static mode with scripting disabled, so this is not exploitable
as written — but it is inconsistent with the reasoning applied one file away.

## M4-5 — unconstrained entity ids on four new channels (minor)

`graph:setNodeName`, `graph:setNodeIcon`, `graph:setViewport` and `cardArt:fetch` all declare
`entityId: z.string().min(1)` (`ipc.ts:714-846`) with no upper bound, and `graph:setNodeName`
(`handlers.ts:989-991`) writes straight through to `db.graph.setDisplayName` without checking
the entity exists. Prepared statements mean there is no injection here; what there is, is a
compromised renderer able to write unbounded orphan rows. `docs/SECURITY.md` already lists
"`link:create` ids and types are unconstrained strings despite typed id schemas existing" as an
open gap and says it is "worth closing now that the graph mints edges" — milestone 4 minted the
edges and added four more channels of the same shape.

## M4-6 — README status line (minor, documentation)

`README.md:29` — "**Status: milestone 3.**" — at a HEAD whose `state/NEXT_ACTION.md` says every
milestone-4 criterion is green. Separately, `README.md`'s "With both switched off, nothing in
the application makes a network request" is stronger than `docs/SECURITY.md`'s more careful
"nothing reaches the network except `127.0.0.1` (the Zotero local API)". The Zotero local API is
a network request in the ordinary sense of the phrase.

---

## Traced and found sound

Each of these is a claim I tried to break and could not. They are recorded because a verified
invariant is worth as much as a finding.

### The `rrfile://` allow-list, against traversal, encoding and case

`apps/desktop/src/main/protocol.ts` is **unchanged** by milestone 4 (`git diff --stat` lists no
entry for it), so the resolution rules are milestone-3 ground. What milestone 4 changed is
`paths.ts`, which grew `AllowedRoots.files`, `isAdmittedFile`, and `SwappableRoots.admit` /
`withdraw` / `files`. The only deletions in that diff are the two containment predicates being
widened to also consult `isAdmittedFile`, and the constructor signature — `withoutFilesystemPaths`
(the fix for milestone-3 finding 1) is untouched.

Executed against the real module, transpiled with the repo's own esbuild
(`/tmp/wr-audit/check-paths.mjs`), with one root, one admitted file, and a planted symlink:

```
ALLOW   lexical=true   inside the root
REFUSE  lexical=false  prefix-collision sibling root        (/…/Library-secrets)
REFUSE  lexical=false  traversal out of the root
REFUSE  lexical=true   symlink inside the root pointing out ← lexical check would have allowed it
ALLOW   lexical=true   admitted file, exactly
ALLOW   lexical=true   admitted file, dot-segment form
REFUSE  lexical=false  sibling of the admitted file
ALLOW   lexical=false  UPPERCASE variant of admitted file   ← see below
REFUSE  lexical=false  containing dir of admitted file
REFUSE  lexical=false  relative path
REFUSE  lexical=false  NUL-truncated
REFUSE  lexical=true   percent-encoded traversal (%2e%2e)
---
isInsideRoot('/a/Zotero-secrets', '/a/Zotero') = false
isAdmittedFile(case-variant)                   = false
admit('relative.pdf') = false   admit('/a/b\0c') = false
```

Two rows deserve comment. The **symlink** row is the one that matters: the lexical predicate
says `true` and `resolveAllowedPath` — which is what `rrfile://` actually calls — says
`REFUSE`, because containment is decided on the `realpath`. That is milestone-3 audit finding
S2 still holding under the new admitted-files code path. The **uppercase** row is not a hole:
macOS canonicalises case in `realpath()`, so `ADMITTED.pdf` resolves to the same inode as the
admitted `admitted.pdf` and is allowed as the same file; the raw-string predicate
`isAdmittedFile` correctly says `false` for the unresolved form, and the resolved one is
authoritative. Admission is stored as the realpath (`local-files.ts:161`, `realFile`), so an
admitted symlink cannot be re-aimed at another file afterwards.

The one new root milestone 4 adds is `<userData>/card-art` (`services.ts:180-195`), fixed
rather than swappable, created before the roots are resolved, and holding only
`sha256(url).ext` files the app fetched. It does not contain anything the researcher put there
and cannot be aimed elsewhere.

### `wr:drop` really is off the bridge

- `packages/shared-types/src/ipc.ts` contains the string `'wr:drop'` **zero times**, so
  `isIpcChannel('wr:drop')` is false and `dispatch` rejects it at `router.ts:128-131` before any
  handler exists. `isIpcChannel` uses `Object.prototype.hasOwnProperty.call`, so `__proto__`,
  `constructor` and `toString` are rejected too.
- `preload/index.ts:36-57` exposes one object with exactly `invoke` and `subscribe`. The drop is
  *handled*, not exposed: two `window` listeners in the preload's isolated world, and
  `ipcRenderer.invoke(DROP_CHANNEL, …)` called from there.
- Asserted at runtime by `tests/e2e/board.spec.ts:256-292`: `Object.keys(rr).sort()` equals
  `['invoke','subscribe']`, and `rr.invoke('wr:drop', { paths: ['/etc/hosts'] })` comes back
  `ok: false` with no `document_files` row for `/etc/hosts`.
- I looked for the way round. The E2E helper (`tests/e2e/support/drop.ts`) dispatches a
  *synthetic* `drop` event from the main world and the preload listener receives it — so a
  compromised renderer can certainly reach the handler, and can put
  `data-wr-drop-library` on any element it likes. What it cannot produce is a `File` with a
  path: `webUtils.getPathForFile` answers `''` for a `File` constructed in JavaScript, and
  `preload/index.ts:113-115` drops empty answers before building the list. Every other route to
  a path-bearing `File` — a real drag, a file input, `showOpenFilePicker`, a paste — is a user
  action naming the file the user chose. No escalation found.
- No channel in the contract accepts a path or a URL. I grepped every request schema:
  `library:addFiles` has `request: empty` and the main process owns both the dialog and the
  answer (`index.ts:150-167`, refused outright in `WR_BACKGROUND=1`); `corpus:chooseFolder` is
  the same shape; `graph:setNodeIcon` and `question:update.coverFileId` take file **ids**;
  `cardArt:fetch` takes a **name**. The trap recorded in `state/NEXT_ACTION.md:51-52` is true as
  built.
- The drop's own payload *is* zod-validated before dispatch, in the router
  (`router.ts:49-58`, `199-212`): `QuestionIdSchema.nullable()`, and paths bounded at
  `min(1).max(4096)` each, `min(1).max(50)` in total.

### The IPC router

- `ipcMain` appears in `apps/desktop/src/main/router.ts` and nowhere else in the tree
  (two `handle` calls, two `removeHandler` calls). `scripts/verify_completion.py:504-522` still
  enforces this.
- Every milestone-4 channel is a closed `z.object` of typed fields. Grepping the whole of
  `packages/shared-types` and `apps/desktop/src` for `z.any()`, `.passthrough()`, `.catchall(`
  and `z.record(z.any` returns four hits, all in
  `apps/desktop/src/main/agents/stream.ts` — parsing the `claude` CLI's own stdout, not an IPC
  payload, and milestone-3 ground. Milestone 4 added **no** new loose request field; the five
  `z.unknown()` / `z.record(z.unknown())` fields `docs/SECURITY.md` records as a gap are the
  same five as before.
- `dispatch` re-validates every response against `contract.response` outside production
  (`router.ts:153-163`), and `publish` validates every event payload before sending
  (`router.ts:219-231`).
- New handlers check their endpoints before writing: `hypothesis:attachEvidence` resolves both
  the hypothesis and the document/annotation (`handlers.ts:814-823`), `journal:advancesQuestion`
  resolves both ends (`:850-854`), `question:update` resolves the cover file id (`:706-708`).
- Errors cannot carry a path to the renderer. `toIpcError` collapses anything unrecognised to
  `{ code: 'INTERNAL', message: 'The operation failed.' }`; `AddFileError`'s three messages
  ("a file is added by absolute path", "that file could not be read", "only a file can be
  added") name nothing; `addMany` swallows per-file failures into the log rather than the reply;
  `receiveDrop` returns `{ added }` and the preload does not read it. This is milestone-3
  finding 1 still holding.

### The unchanged invariants

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`,
  `spellcheck: false` at `index.ts:178-190`. No `webSecurity: false` anywhere; the verifier
  forbids the insecure literals across all of `apps/` and `packages/`
  (`verify_completion.py:483-500`), which is what makes the positive greps binding.
- Preload exposes exactly one `invoke` and one `subscribe` — read, and asserted at runtime by
  two E2E specs.
- Renderer packages import none of `electron`, `better-sqlite3`, `@wr/database`,
  `@wr/zotero-adapter`. The only match outside the main-only packages is a *comment* in
  `packages/graph/src/index.ts:11`.
- `~/Zotero/zotero.sqlite`: every occurrence in the source is a comment saying it is never
  written. `ZoteroLocalClient` sets no `method`, so only GET is ever issued
  (`packages/zotero-adapter/src/client.ts:89`), and the milestone-4 importer diff adds no write
  of any kind. `[B04]` hashes the file before and after
  (`tests/integration/library-curation.test.ts:408`).
- `WR_ZOTERO_ENDPOINT` is new in milestone 4 and is the right shape: parsed as a URL, scheme
  restricted to http/https, hostname compared against a loopback set (not a prefix), userinfo
  refused outright, and a refused value falls back to the default with a log line rather than
  stopping the launch (`zotero-endpoint.ts`). Its own unit test covers
  `https://127.0.0.1.evil.invalid/`, `http://localhost.evil.invalid/` and
  `http://127.0.0.1@evil.invalid/`. The E2E fixture server binds `127.0.0.1` explicitly.
- Card art settings cannot be written except through `setCardArtEnabled`: there is no generic
  settings channel in the contract, and `graph:setViewSettings` writes a constant key
  (`graph-view.ts:10`) with a closed schema.

### Type escapes

`git diff fde3e38..HEAD -- '*.ts' '*.tsx'` contains no added `@ts-expect-error`, no
`@ts-ignore`, no `eslint-disable`, no `: any`, no `as any`. The three added `as unknown as`
occurrences are all in `tests/e2e/board.spec.ts`, reaching `globalThis.rr` from inside a
`page.evaluate` — the one place where the type of the browser global genuinely is unknown, and
in the test that exists to prove what is on it.

### Milestone-3 ground: checked for regression

| m3 finding | Still holds? |
|---|---|
| 1 — paths in `agent:progress` | Yes. `withoutFilesystemPaths` untouched by the m4 diff; no new topic or response schema carries a path field. |
| 2 — wiki removed on disable | Yes. `agent:enable{false}` still awaits `view.remove()` (`handlers.ts:1123-1129`). |
| 3, 4 — accept/pass races | Untouched by m4. |
| S1 — navigation by origin | `isAllowedNavigation` and `isLoopbackUrl` untouched. |
| S2 — containment against `realpath` | Yes, and re-verified by execution above under the new admitted-files path. |

---

## What I did not do

- No network request to `api.scryfall.com` or any other remote host. M4-1's second branch —
  whether Scryfall's `format=image` endpoint actually redirects in production — is therefore
  stated as a disjunction rather than resolved.
- No E2E and no `pnpm dev`; other auditors are in this tree. The E2E assertions cited above are
  read, not re-run. The suite is reported green at this commit.
- The https→http redirect downgrade in M4-1 is reasoned from `fetch` semantics; only the
  cross-host follow was executed.
- The `rrfile://` TOCTOU already recorded in `docs/SECURITY.md` is milestone-3 ground and was
  not re-examined.

## Scripts

Written to `/tmp/wr-audit/`, outside the repository: `check-paths.mjs` (containment),
`check-arturl.mjs` (URL construction), `check-redirect.mjs` (cross-host redirect),
`check-cap.mjs` (size cap and decompression), `check-headers.mjs` (what goes on the wire).
`paths.ts` was transpiled with the repository's own esbuild so the containment results are the
real module's, not a reimplementation.
