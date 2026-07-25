# Independent security & architecture audit — wiki-reader

Audited-commit: b0dffcd (working tree at time of audit: abded95; `git diff b0dffcd..abded95 -- apps/desktop/src`
is empty, so every code observation below applies to both)
Lens: the security and architecture invariants in `CLAUDE.md` and `docs/SECURITY.md`.
Method: read the real source under `apps/`, `packages/`, `workers/`, plus the built artefacts in
`apps/desktop/out/`. Every claim below cites file:line. Two claims were checked by executing the
predicate rather than reading it.

---

## Summary table

| # | Sev | Claim | Location |
|---|-----|-------|----------|
| 1 | major | Remote-request block is bypassable by any host prefixed `localhost`; `ws://`/`wss://` never filtered | `apps/desktop/src/main/protocol.ts:284-288` |
| 2 | major | `rrfile://` does not resolve symlinks, so an in-root path can still read out-of-root bytes | `apps/desktop/src/main/protocol.ts:205-212`, `apps/desktop/src/main/paths.ts:22-37` |
| 3 | major | `docs/SECURITY.md` threat model states hostile PDFs are parsed in the main process; they are parsed in the renderer | `docs/SECURITY.md:12` vs `packages/pdf-reader/src/pdfjs.ts:32-41` |
| 4 | minor | `docs/SECURITY.md` §2 and "Gaps" describe a preload and a router that no longer exist | `docs/SECURITY.md:37,155-165` |
| 5 | minor | Five IPC request fields are `z.unknown()`/`z.record(z.unknown())`; link ids and types unconstrained | `packages/shared-types/src/ipc.ts:221,236,258-267,378-380` |
| 6 | minor | `zotero:import` returns raw `Error.message` strings to the renderer, routing around `toIpcError` | `packages/zotero-adapter/src/importer.ts:163` |
| 7 | minor | The renderer-boundary gate never scans `apps/desktop/src/renderer` | `scripts/verify_completion.py:78-93` |
| 8 | minor | No `setPermissionCheckHandler`; synchronous permission checks fall back to Chromium defaults | `apps/desktop/src/main/protocol.ts:280-283` |
| 9 | minor | Navigation hardening is per-window, not `app.on('web-contents-created')`; dev allow-check is a prefix match | `apps/desktop/src/main/index.ts:94-107` |

No critical finding. Nothing in findings 1-9 is reachable by a remote attacker; the app has no
network listener and blocks non-loopback egress by CSP.

---

## Invariant-by-invariant verdict

### 1. Window security flags — **HOLDS**

There is exactly one `BrowserWindow` construction site in the entire tree. `grep -rn "new BrowserWindow"`
over everything except `node_modules`/`.git` returns a single hit:

- `apps/desktop/src/main/index.ts:62` — `new BrowserWindow({ ... })`
- `apps/desktop/src/main/index.ts:73-76` — `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webviewTag: false`
- `createWindow()` is called twice — `index.ts:150` (startup) and `index.ts:153` (`app.on('activate')`)
  — and both go through the same literal, so a second window cannot diverge.

Negative checks, all zero hits across `apps/`, `packages/`, `workers/`:

- No `BrowserView`, no `WebContentsView`, no `openDevTools`, no `<webview>`.
- No `webSecurity`, `allowRunningInsecureContent`, `nodeIntegrationInSubFrames`, or
  `experimentalFeatures` appear in any source file (only in `README.md`, `CLAUDE.md`,
  `docs/*`, and the verifier's own regex table).
- No `iframe`, `srcdoc`, `dangerouslySetInnerHTML`, `innerHTML`, `eval(`, or `new Function`
  anywhere under `apps/desktop/src` or `packages/*/src`. `packages/html-reader/src/index.ts`
  is a placeholder that throws (`IMPLEMENTED = false`), so the "sandboxed iframe for archived
  HTML" surface does not exist yet and cannot be misconfigured.

The built artefact matches the source: `apps/desktop/out/main/index.js:8249-8251` contains
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. This matters because the
verifier only greps `src/`.

Proved at runtime, not merely by grep: `tests/e2e/shell.spec.ts:28-46` evaluates in the renderer
and asserts `require`, `module`, `process` and `electron` are all `undefined` in the main world.

Renderer CSP is present in both source and build:
`apps/desktop/src/renderer/index.html:13` and `apps/desktop/out/renderer/index.html`
(identical string) — `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: rrfile:; font-src 'self' data:; connect-src 'self' rrfile:;
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. `script-src` has no
`unsafe-inline`/`unsafe-eval` escape hatch.

The renderer is served from `app://bundle/` rather than `file://`
(`apps/desktop/src/main/index.ts:113`, `apps/desktop/src/main/protocol.ts:25-27`), so the CSP is
enforced against a real origin instead of the opaque `null` origin a `file://` page would get.

### 2. Preload exposes exactly one `invoke` and one `subscribe` — **HOLDS**

`apps/desktop/src/preload/index.ts` is 35 lines. It imports `contextBridge` and `ipcRenderer`
(preload/index.ts:9), builds one object literal with exactly two methods
(preload/index.ts:14-28), and calls `contextBridge.exposeInMainWorld('rr', bridge)` once
(preload/index.ts:35). There is no third property, no event emitter, no `process` slice, no
`platform` string.

`grep -rn "exposeInMainWorld\|contextBridge"` over the whole tree returns only
`apps/desktop/src/preload/index.ts` and prose in `docs/SECURITY.md`.

The built preload is byte-for-byte equivalent — `apps/desktop/out/preload/index.cjs` is 19 lines
and exposes the same two functions. This is the artefact the sandboxed renderer actually loads
(`apps/desktop/src/main/index.ts:71`, `electron.vite.config.ts` preload output `format: 'cjs'`).

`subscribe` returns a closure that calls `ipcRenderer.removeListener` (preload/index.ts:24-26),
so a panel unmounting cannot leak a handler. Neither function lets the renderer name a channel:
both forward to the fixed constants `wr:invoke` / `wr:event` (preload/index.ts:11-12).

Runtime proof: `tests/e2e/shell.spec.ts:44-45` asserts
`Object.keys(window.rr).sort() === ['invoke','subscribe']` and that both values are
`typeof 'function'`. This is a real shape assertion, which `docs/SECURITY.md:69-70` incorrectly
says does not exist (see finding 4).

### 3. One `ipcMain.handle`, zod-validated before dispatch — **HOLDS (with finding 5)**

`grep -rn "ipcMain"` over every non-`node_modules`, non-`.git` file in the repo returns exactly
three code hits, all in one file:

- `apps/desktop/src/main/router.ts:10` (import)
- `apps/desktop/src/main/router.ts:163` (`ipcMain.handle(INVOKE_CHANNEL, ...)`)
- `apps/desktop/src/main/router.ts:173` (`ipcMain.removeHandler`)

Everything else is prose in `README.md`, `CLAUDE.md`, `docs/*`, and the verifier's regex.
There is no `ipcMain.on`, no `ipcMain.handleOnce`, no `ipcMain.handle` in `workers/` or in the
built `out/main/index.js` beyond the one bundled from `router.ts`.

Validation order in `dispatch()` (`router.ts:94-143`) is correct and is genuinely *before*
dispatch:

1. `isEnvelope(payload)` (router.ts:40-47, called at 164) — structural check before the channel
   string is trusted.
2. `isIpcChannel(channel)` (router.ts:100) → `Object.prototype.hasOwnProperty.call(IPC_CHANNELS, value)`
   (`packages/shared-types/src/ipc.ts:392-393`). Using `hasOwnProperty` rather than `in` means
   `constructor`, `__proto__` and `toString` are not channels.
3. `IPC_CHANNELS[channel].request.safeParse(request ?? {})` at `router.ts:106`, and the handler
   is only reached at `router.ts:119` if `parsed.success`.

No loosening constructs exist: `grep -rn "passthrough\|catchall\|z.any()"` over
`packages/shared-types/src/` and `apps/desktop/src/` returns zero hits. Plain `z.object()` strips
unknown keys, so extra renderer-supplied properties are dropped rather than forwarded.
`scripts/verify_completion.py:300-333` additionally rejects `as any` casts in first-party source
and reports every `eslint-disable` (currently 1).

Error mapping does not leak: `toIpcError` (router.ts:56-88) passes through only `HandlerError`,
`ZoteroError` and `ZodError`, maps anything containing `SQLITE_` to a generic `DATABASE_ERROR`,
and collapses everything else to `{ code: 'INTERNAL', message: 'The operation failed.' }`.
Every `HandlerError` raised in `handlers.ts` is `notFound(what, id)` (handlers.ts:37-38), whose
`details` is `{ id }` — never a path. See finding 6 for the one channel that routes around this.

Outbound events are validated too (`router.ts:178-186`) against `IPC_TOPICS`.

Caveat: five request fields accept arbitrary values — finding 5.

### 4. `rrfile://` — **HOLDS against path traversal; FAILS against symlinks** (finding 2)

Path traversal is closed, and closed tightly. `parseFileId` (`protocol.ts:168-184`):

- rejects anything whose `pathname` is non-empty after stripping leading slashes
  (protocol.ts:180-181), so `rrfile://<id>/../../etc/passwd` is refused rather than interpreted;
- takes the id from the *host*, `decodeURIComponent`s it, then requires
  `/^dfl_[0-9a-hjkmnp-tv-z]{26}$/` (protocol.ts:182). That charset is Crockford base32 with no
  `/`, no `.`, no `%`, no NUL, no uppercase. Percent-encoding, double-encoding, `..`, absolute
  paths and NUL bytes all fail this regex *after* decoding, so the decode-then-check ordering is
  the safe one.

The surviving id is used only as a bound SQL parameter — `documents.ts:118-123`,
`prepare('... WHERE id = ?').get(id)` — never concatenated.

`isAllowedPath` / `isInsideRoot` (`paths.ts:22-37`) I verified by executing the predicate rather
than reading it:

```
isInsideRoot('/Users/x/Zotero/../../../etc/passwd', '/Users/x/Zotero') -> false   (traversal)
isInsideRoot('/Users/x/Zotero-secrets/a',           '/Users/x/Zotero') -> false   (prefix collision)
isInsideRoot('/users/x/zotero/a',                   '/Users/x/Zotero') -> false   (macOS case)
```

The macOS case-insensitivity result is a *false negative*, i.e. fail-closed: a case-variant path
is refused, never wrongly admitted. NUL bytes are rejected explicitly (`paths.ts:34`) and relative
paths at `paths.ts:32`. Roots are built once in `createServices` (`services.ts:60`) from the Zotero
data dir plus test-only `extraRoots`, dropping empty and relative entries (`paths.ts:40-46`).

**The renderer never receives or constructs a filesystem path.** Verified end to end:

- `DocumentFileSchema.path` is annotated "Never sent to the renderer"
  (`packages/shared-types/src/domain.ts:64-65`);
- `DocumentFileRefSchema = DocumentFileSchema.omit({ path: true })` and requires
  `url: z.string().startsWith('rrfile://')` (`domain.ts:76-79`);
- `toDocumentFileRef` (`packages/database/src/repositories/documents.ts:57-60`) is the only
  construction site — it destructures `path` away and re-`parse`s through the schema. Its two
  callers are `handlers.ts:128` (`document:openFile`) and `library.ts:68` (`library:list*`);
- no other response schema in `IPC_CHANNELS` carries a `path` field. I read
  `LibraryItemSchema` (domain.ts:282-289) and `SearchResultSchema` (domain.ts:292-304); neither
  does;
- the renderer's own code never builds a URL: `packages/pdf-reader/src/PdfReaderView.tsx:97`
  passes the server-supplied `fileUrl` straight to `loadPdf`, and
  `apps/desktop/src/renderer/document-data.ts:41` only *selects* among
  `item.files` refs. `grep -rn "rrfile"` over renderer sources finds only comments and the type
  annotation.

**Finding 2 (major) — symlinks are never resolved.**
`resolveFileRequest` (`protocol.ts:205-212`) applies `isAllowedPath(file.path, ...)`, a purely
*lexical* check, and then calls `stat(file.path)` (protocol.ts:211) and
`createReadStream(resolved.path)` (protocol.ts:237, 262). Both follow symlinks.
`grep -rn "realpath\|lstat\|symlink"` across `apps/`, `packages/` and `workers/` returns **zero
hits** — there is no `realpath` call anywhere in the codebase.

Consequence: a row whose `path` is `<zoteroDataDir>/storage/ABCD1234/paper.pdf`, where that
directory entry is a symlink to `~/.ssh/id_rsa` or `~/Zotero/zotero.sqlite`, passes
`isAllowedPath` and is streamed to the renderer with `200 OK`. This directly contradicts
`docs/SECURITY.md:99` ("A compromised row must not become an arbitrary-file-read") and the module
header at `paths.ts:5-8`. The same gap sits in the extraction path
(`apps/desktop/src/main/pipeline.ts:135-140`), which lexically checks then `readFile`s.

Threat model is admittedly narrow — an adversary must already be able to place a symlink under
`~/Zotero/storage` — but that is precisely the "tampered data" adversary the module claims to
defend against, and the fix is one `realpath` before the containment check. There is also a
TOCTOU window between `stat` (protocol.ts:211) and `createReadStream` (protocol.ts:237/262).

Range handling (`protocol.ts:249-259`) is sound: the regex anchors, `NaN`/inverted/out-of-range
values return 416, and `clampedEnd` bounds the read to the stat'd size.

The sibling `app://` handler (`resolveBundleRequest`, protocol.ts:100-137) is also containment
checked — it rejects malformed percent-encoding (119-122), NUL bytes (123), and anything failing
`isInsideRoot(candidate, root)` (128-130), and strips leading slashes before `join` so a decoded
absolute path cannot escape.

### 5. Renderer packages import no main-process code — **HOLDS in fact** (enforcement gap: finding 7)

Grepped `packages/{workbench,pdf-reader,html-reader,annotations,note-editor,shared-ui}/src` **and**
`apps/desktop/src/renderer` for `from 'electron'`, `require('electron')`, `better-sqlite3`,
`@wr/database`, `@wr/zotero-adapter`, `node:fs`, `node:child_process`, `node:path`, bare `'fs'`,
bare `'path'`, and `child_process`. **Zero hits.**

Confirmed at the manifest level too — none of the six `package.json` dependency sets names
`electron`, `better-sqlite3`, `@wr/database`, `@wr/zotero-adapter`, `@wr/search` or
`@wr/text-extraction-worker`. `html-reader` carries `jsdom` but only as a `devDependency`.

Transitive re-export was checked, not assumed:

- `@wr/shared-types` imports only `zod` and its own sibling modules
  (`grep -rhn "^import" packages/shared-types/src/*.ts` → `zod` plus relative `./` paths);
- `@wr/document-model` imports only `@wr/shared-types`, `vitest` (in `*.test.ts`) and its own
  relative modules — no Node builtins.

So no type-only import can emit a runtime require of a main-process module, because no such
module is reachable from the renderer graph at all.

`electron.vite.config.ts` keeps the graphs separate: `main` externalises `better-sqlite3`, the
renderer build roots at `src/renderer` and has no main-process input.

### 6. Navigation / new-window blocking — **HOLDS** (hardening gap: finding 9)

- `apps/desktop/src/main/index.ts:94` — `window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`,
  unconditional deny, no URL inspection to get wrong.
- `apps/desktop/src/main/index.ts:98-107` — `will-navigate` calls `event.preventDefault()` unless
  the URL starts with `app://bundle/` (trailing slash included, so `app://bundleevil/` fails) or,
  in dev only, with `ELECTRON_RENDERER_URL`.
- Proved against a real process: `tests/e2e/shell.spec.ts:48-69` calls
  `window.open('https://example.com')` *and* sets `location.href`, waits 2s, then asserts from the
  main process that exactly one window exists and its URL still matches `^app://bundle/`.
- `session.setPermissionRequestHandler(cb => cb(false))` — `protocol.ts:281-283`, deny-all.

### 7. `~/Zotero/zotero.sqlite` never opened for write — **HOLDS**

`packages/zotero-adapter/src/client.ts` is HTTP-only against `http://127.0.0.1:23119`
(`DEFAULT_ZOTERO_ENDPOINT`, client.ts:25). There is exactly one outbound call site,
`client.ts:195`: `await this.doFetch(url, { signal: controller.signal })`. The injectable type
`FetchLike` (`client.ts:59`) is declared as
`(url: string, init?: { signal?: AbortSignal }) => Promise<Response>` — the signature cannot even
*express* a `method`, so a non-GET request is a type error, not a review question.
`grep -n "method"` in `client.ts` returns nothing.

`grep -rn "sqlite\|better-sqlite\|zotero.sqlite\|openDatabase\|writeFile\|createWriteStream\|copyFile\|unlink\|rm("`
over `packages/zotero-adapter/src/` returns **only three comment lines** (client.ts:4,
index.ts:7, importer.ts:9) — no code.

The adapter's only filesystem use is read-only: `node:fs` `createReadStream` and `node:fs/promises`
`stat` in `hashFileOnDisk` (`importer.ts:12-13, 80-92`). No write API is imported.

Zotero keys are not used as internal ids: `resolveAttachmentPath` (`mapping.ts:150-184`) only
derives paths, and item keys land in `external_references`
(`ExternalReferenceSchema`, `domain.ts:242-244`).

---

## Findings in detail

### Finding 1 — major — remote-request block bypassable by `localhost`-prefixed hosts

`apps/desktop/src/main/protocol.ts:284-288`:

```ts
session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
  callback({ cancel: !details.url.startsWith('http://localhost') });
});
```

`docs/SECURITY.md:135` documents this as "`http://` and `https://` requests cancelled unless the
URL starts with `http://localhost`... remote loads are blocked outright rather than merely
discouraged by CSP."

I executed the predicate:

```
http://localhost:5173/x                     -> cancel = false   (intended)
http://localhost.attacker.example/steal?d=1 -> cancel = false   (NOT intended)
http://localhostage.evil.io/                -> cancel = false   (NOT intended)
https://evil.com/                           -> cancel = true
```

`localhost.attacker.example` is a public, DNS-resolvable name pointing anywhere the attacker
likes. The check is a raw string prefix on the full URL rather than a parsed-host comparison, so
the same class of bug as the one `isInsideRoot` was deliberately written to avoid
(`paths.ts:16-21` explains exactly this hazard for paths) is present for URLs 260 lines away.

Two secondary defects in the same three lines:
- the filter lists only `http://*/*` and `https://*/*`, so `ws://` and `wss://` requests are never
  handed to the handler at all;
- the function is named `lockDownNavigation` but blocks subresource requests, not navigation —
  the actual navigation lock is `will-navigate` in `index.ts:98`. The name invites the wrong
  mental model when someone edits it.

Confirmed present in the shipped bundle: `apps/desktop/out/main/index.js:8216`.

Mitigating: in a packaged build the renderer origin is `app://bundle` and the CSP is
`connect-src 'self' rrfile:` / `img-src 'self' data: blob: rrfile:`, so a renderer cannot
actually reach `http://localhost.attacker.example` — CSP stops it first. The finding is that
the layer documented as the outright block is not one. Fix: parse with `new URL` and compare
`hostname` against `'localhost'`/`'127.0.0.1'`/`'::1'` exactly, and add `ws://*/*`, `wss://*/*`
to the filter.

### Finding 2 — major — symlink escape from the allowed roots

Detailed under invariant 4 above. Key evidence: `protocol.ts:205` (lexical check) → `protocol.ts:211`
`stat` → `protocol.ts:237/262` `createReadStream`, with zero `realpath`/`lstat` calls anywhere in
the repository. Same shape at `pipeline.ts:135-140`.

### Finding 3 — major (documentation) — the threat model misstates where hostile PDFs are parsed

`docs/SECURITY.md:12`, the row for the primary adversary:

> | A malicious PDF | Arbitrary parser input to PDF.js; embedded JS and font programs | Parsed in the
> main process with `isEvalSupported: false`; **the renderer only receives extracted text and page
> images.** |

That is not what the code does. The reading view parses raw PDF bytes **in the renderer**:

- `packages/pdf-reader/src/pdfjs.ts:32-41` — `getDocument({ url, isEvalSupported: false, ... })`
  where `url` is the `rrfile://` URL;
- `packages/pdf-reader/src/PdfReaderView.tsx:97` — `await loadPdf(fileUrl, controller.signal)`;
- `packages/pdf-reader/src/pdfjs.ts:16-18` — a PDF.js *web worker* is started in the renderer.

The main-process `ExtractionPipeline` (`apps/desktop/src/main/pipeline.ts:141`) is a *separate*
search-indexing path, not the reading path.

The implementation itself is defensible — the renderer is `sandbox: true` + `contextIsolation: true`,
`isEvalSupported: false` is set, the worker is same-origin, and `script-src 'self'` has no
`unsafe-eval`. The finding is that `docs/SECURITY.md` — which `CLAUDE.md` names as the authority for
these invariants — cannot be used as evidence about the code, because on the single most important
row of its threat model it describes a different architecture. A reviewer trusting it would
conclude the renderer never touches hostile parser input, which is false.

Two smaller misstatements in the same document:
- `docs/SECURITY.md:133` says `will-navigate` is "cancelled unless the URL starts with
  `ELECTRON_RENDERER_URL` (and always in a packaged build, where that variable is unset)".
  `index.ts:101` also allows `app://bundle/`, which is what makes a packaged build work at all.
- `docs/SECURITY.md:12` claims the renderer receives "page images"; it receives bytes.

### Finding 4 — minor — `docs/SECURITY.md` §2 and "Gaps" are stale in the app's favour

- `docs/SECURITY.md:37` — "`bridge` has `invoke(channel, request)`, `subscribe(topic, handler)`
  **and a `platform` string**". It does not; `preload/index.ts:14-28` has two properties, and the
  built `out/preload/index.cjs` confirms it.
- `docs/SECURITY.md:159-161` (Gaps) — "The preload's exposed shape is not verified... no check
  would catch a fourth property being added." `tests/e2e/shell.spec.ts:44-45` asserts
  `Object.keys(window.rr).sort()` equals `['invoke','subscribe']`, which would catch exactly that.
- `docs/SECURITY.md:162-165` (Gaps) — "Responses are not validated on the way out... `dispatch()`
  in `router.ts` does not." `router.ts:125-135` parses every response against
  `contract.response` outside production.

Stale docs understating the code are less dangerous than docs overstating it, but combined with
finding 3 they mean `docs/SECURITY.md` has not been re-read against the source in some time and
should not be treated as audit evidence.

### Finding 5 — minor — accept-anything fields inside otherwise-validated payloads

`packages/shared-types/src/ipc.ts`:

- `:221` `note:create.contentJson: z.unknown()`
- `:236` `note:update.contentJson: z.unknown().optional()`
- `:267` `link:create.metadata: z.record(z.unknown()).nullish()`
- `:378` `workspace:saveLayout.layout: z.unknown()`
- `:379` `workspace:saveLayout.panelState: z.record(z.unknown()).default({})`

`z.unknown()` accepts any value including `undefined`, so those fields are stored on the
renderer's word. The stored layout is later returned through `WorkspaceLayoutSchema`
(`domain.ts:232-239`), whose `layout` is also `z.unknown()`, and fed to Dockview's `fromJSON`.
No injection sink was found downstream (`grep` for `innerHTML`/`eval` in renderer sources is
empty), and the values are renderer-authored in the first place, so impact is low — but
`CLAUDE.md`'s "every IPC payload is zod-validated" is only true at the envelope level for these
five fields.

Related looseness, same file: `link:create.sourceId`/`targetId` are `z.string().min(1)`
(`ipc.ts:258, 260`) with no ID-prefix validation even though typed id schemas exist
(`packages/shared-types/src/ids.ts`), and `type` is `LinkTypeSchema = z.string().min(1)`
(`domain.ts:164`) despite `KNOWN_LINK_TYPES` existing at `domain.ts:151-163`. The renderer can
therefore mint edges of arbitrary type pointing at arbitrary id strings. That is a data-integrity
concern against "all relationships are typed directed edges", not a memory-safety one.
Also unbounded: `annotation:create.selectedText` is `z.string().min(1)` with no `.max()`
(`ipc.ts:189`) and `color` is a free `z.string()` (`ipc.ts:188`).

### Finding 6 — minor — `zotero:import` returns raw error text to the renderer

`packages/zotero-adapter/src/importer.ts:163`:

```ts
summary.warnings.push(`item ${item.data.key}: ${message}`);
```

where `message` is `error instanceof Error ? error.message : String(error)` for anything thrown by
`importItem`. `warnings` is typed `z.array(z.string())` in the `zotero:import` response
(`ipc.ts:116`) and is returned to the renderer verbatim.

`router.ts:83-87` exists specifically so that "the real message may name a path or a SQL fragment,
and the renderer is not entitled to either" — this path bypasses it, because the message becomes
ordinary response *data* rather than an error. The two other `warnings.push` sites
(importer.ts:328, 338) are safely constructed from the key only, and `importer.ts:339` correctly
sends the path to the logger instead. Low likelihood of a real path appearing (the thrown values
are mostly zod and SQLite errors), but the sanitisation boundary is inconsistent.

### Finding 7 — minor — the renderer-boundary gate does not cover the renderer app

`scripts/verify_completion.py:78-85`:

```python
RENDERER_PACKAGES = [
    "packages/workbench", "packages/pdf-reader", "packages/html-reader",
    "packages/annotations", "packages/note-editor", "packages/shared-ui",
]
```

`check_renderer_boundary()` (verify_completion.py:336-362) iterates only that list.
`apps/desktop/src/renderer/` — 11 files, ~2,900 lines, including `App.tsx`, `panels.tsx`,
`store.ts` and `host.ts` — is never scanned. A `import { ipcRenderer } from 'electron'` there
would pass the gate. I grepped it manually and it is currently clean, so the invariant holds in
fact; it is simply unenforced.

Secondary gaps in the same check: `FORBIDDEN_RENDERER_IMPORTS` (verify_completion.py:86-93) omits
`@wr/search` and `@wr/text-extraction-worker` (both main-only per `CLAUDE.md`) and does not catch
bare `'fs'`, `'path'` or `'child_process'` specifiers — only the `node:`-prefixed forms.
(`node:fs/promises` *is* caught, via the `startswith(forbidden + "/")` branch at
verify_completion.py:355-356.)

### Finding 8 — minor — no `setPermissionCheckHandler`

`apps/desktop/src/main/protocol.ts:280-283` installs `setPermissionRequestHandler` (deny-all) but
not `setPermissionCheckHandler`. Chromium routes some capability queries through the synchronous
check path, which without a handler falls back to the default policy rather than the deny-all the
app intends. One extra line closes it.

### Finding 9 — minor — per-window hardening, and a prefix match in the dev allow-check

`setWindowOpenHandler` and `will-navigate` are attached inside `createWindow()`
(`index.ts:94-107`). There is no `app.on('web-contents-created', ...)`, so any `webContents`
created outside that function inherits nothing. Today none can be — `webviewTag: false`,
`setWindowOpenHandler` denies, and there is no `BrowserView`/`WebContentsView`/`openDevTools`
anywhere — so this is hardening depth, not a live hole.

Separately, `index.ts:102`:

```ts
(rendererUrl !== undefined && url.startsWith(rendererUrl))
```

is the same prefix-versus-host bug as finding 1: with `ELECTRON_RENDERER_URL=http://localhost:5173`,
a navigation to `http://localhost:5173.evil.com/` passes. Dev-only (`isDev &&` gates the load at
`index.ts:109`), so severity is minor.

---

## Out-of-lens observations

Recorded because they bear on the "milestone 1 is complete" claim, not on the security lens:

- `python3 scripts/verify_completion.py` exits non-zero at the time of this audit: 65/80 checks
  pass. `pnpm typecheck` fails with 29 `TS2339` errors, all in
  `packages/database/src/repositories/links.ts` (an uncommitted working-tree modification), and
  seven criterion tags (M01, M02, M05, M06, M07, M11, L02, L08) report "no test tagged" because
  the e2e report was not produced during that run.
- All ten `security:` checks and the `ipc:` check pass. The renderer-boundary check passes, with
  the coverage caveat in finding 7.
