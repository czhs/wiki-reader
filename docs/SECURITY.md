# Security model

wiki-reader opens files the user did not write: PDFs from arbitrary publishers and archived
web pages captured from arbitrary sites. Those bytes are the threat. Everything below exists
so that a malicious document cannot become code execution, and cannot become an
arbitrary-file-read either.

## Threat model

| Adversary | Capability assumed | Mitigation |
|---|---|---|
| A malicious PDF | Arbitrary parser input to PDF.js; embedded JS and font programs | Parsed **in the renderer**, which is `sandbox: true` + `contextIsolation: true` with `script-src 'self'` and no `unsafe-eval`, and `isEvalSupported: false` is passed to PDF.js. The renderer holds no path, no handle and no Node API, so a parser compromise there reaches nothing but `rrfile://` bytes it could already read. A *second*, independent parse runs in the main process for search indexing; a page that throws there is recorded as empty rather than aborting the document. |
| An archived HTML snapshot | Arbitrary HTML/CSS/JS captured from a hostile site | Never rendered in the app origin. Scripts disabled, sandboxed frame, restrictive CSP, navigation blocked. **Not yet implemented** — see [Gaps](#gaps). |
| A compromised or buggy renderer | Full control of the JS context, can call anything on `window` | Two-function preload; every payload re-validated in main; no path, handle, or shell reaches the renderer at all |
| A tampered database row | A hand-edited row, a restored backup, a relocated Zotero base directory, a symlink planted under the library | `rrfile://` resolves the path through symlinks and refuses anything outside the allowed roots even when the row resolves, then opens the resolved path rather than the stored one |
| The user's own Zotero library | Concurrent writer holding a SQLite lock | Read-only HTTP only; `~/Zotero/zotero.sqlite` is never opened |

Out of scope for milestone 1: a hostile local process on the same machine (it already has the
user's privileges), and network attackers (nothing reaches the network except `127.0.0.1`).

## Enforced invariants

### 1. Renderer privileges

`createWindow()` in `apps/desktop/src/main/index.ts` sets `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, plus `webviewTag: false` and `spellcheck: false`.

**Guarded by:** `check_security_flags()` in `scripts/verify_completion.py`, which greps
`apps/desktop/src/main/**/*.ts` for `contextIsolation\s*:\s*true`, `nodeIntegration\s*:\s*false`
and `sandbox\s*:\s*true`, and separately scans all of `apps/` and `packages/` for
`webSecurity: false`, `allowRunningInsecureContent: true`, `nodeIntegrationInSubFrames: true`
and `enableRemoteModule: true`, failing if any appears.

### 2. The two-function preload bridge

`apps/desktop/src/preload/index.ts` calls `contextBridge.exposeInMainWorld('rr', bridge)` once.
`bridge` has exactly two properties: `invoke(channel, request)` and `subscribe(topic, handler)`.
Both forward to fixed transport channels — `wr:invoke` and `wr:event` — so the
renderer cannot name an arbitrary ipc channel. No `ipcRenderer`, no `fs`, no database handle,
no `shell` is exposed. The contract is declared as `RendererBridge` in
`packages/shared-types/src/ipc.ts`.

`subscribe` filters by topic inside the preload and returns an unsubscribe closure that removes
the listener, so a panel that unmounts cannot leak a handler onto later events.

**Guarded by:** `check_renderer_boundary()` in `scripts/verify_completion.py`, which fails if
any file under a renderer package's `src/` imports `electron`, `better-sqlite3`,
`@wr/database`, `@wr/zotero-adapter`, `node:fs` or `node:child_process` — including
`apps/desktop/src/renderer/`, which is a renderer surface without being a package.

The exposed *shape* is asserted at runtime rather than by grep: `tests/e2e/shell.spec.ts`
evaluates in the real renderer and requires `Object.keys(window.rr).sort()` to equal
`['invoke', 'subscribe']`, so a third property fails the suite. The same spec asserts
`require`, `module`, `process` and `electron` are all `undefined` in the main world.

### 3. One validated IPC entry point

`registerRouter()` in `apps/desktop/src/main/router.ts` installs the only `ipcMain.handle` in
the application, on `wr:invoke`. Handling proceeds in fixed order:

1. `isEnvelope(payload)` — structural check before the channel string is trusted.
2. `isIpcChannel(channel)` — an own-property lookup in `IPC_CHANNELS`, so a prototype key such
   as `constructor` is not a channel.
3. `IPC_CHANNELS[channel].request.safeParse(request ?? {})` — zod validation **before** any
   handler runs, which is also what applies the schema defaults the handlers rely on.
4. Dispatch, then `ipcOk(value)` or `ipcErr(...)`.

The router never rejects its promise. `toIpcError()` maps `HandlerError` and `ZoteroError` to
their own codes, `ZodError` to `INVALID_REQUEST` with the failing paths, anything whose message
contains `SQLITE_` to `DATABASE_ERROR`, and everything else to a bare
`{ code: 'INTERNAL', message: 'The operation failed.' }`. The real message may name a
filesystem path or a SQL fragment; the renderer is not entitled to either, so the detail goes
to the log instead.

Outbound events are validated too: `publish` parses the payload against `IPC_TOPICS[topic]` and
refuses to send a malformed one, because a bad event otherwise surfaces as an unexplained
renderer crash far from the code that produced it.

**Guarded by:** `check_ipc_validation()` in `scripts/verify_completion.py`, which fails if any
file under `apps/desktop/src/main/` other than `router.ts` matches `ipcMain\.(handle|on)`.

### 4. `rrfile://` — the only path for file bytes

Registered in `apps/desktop/src/main/protocol.ts`.

`registerProtocolScheme()` must run before `app.whenReady()` (it is called at module load in
`index.ts`). Privileges: `standard: true` so the URLs have a real origin and PDF.js range
requests behave, `secure: true`, `supportFetchAPI: true`, `stream: true` so a 300 MB PDF is not
buffered whole — and explicitly `corsEnabled: false`, `bypassCSP: false`, because these bytes
are untrusted user documents, not application code.

`parseFileId(url)` accepts only `rrfile://<id>` where `<id>` matches
`^dfl_[0-9a-hjkmnp-tv-z]{26}$` and the pathname is empty. A URL with any path segment is
refused rather than interpreted, so the renderer cannot address something *within* a file.

`resolveFileRequest(services, url)` then applies two independent checks, because either alone
is insufficient:

| Failure | Status |
|---|---|
| `parseFileId` returned null | 400 `malformed rrfile url` |
| `db.files.getById(id)` found nothing | 404 `unknown file id` |
| `resolveAllowedPath(file.path, services.allowed)` says outside the roots | 403 `path outside allowed roots` (logged) |
| `resolveAllowedPath` could not resolve the path at all | 404 `file missing on disk` |
| `stat()` says not a regular file | 404 `not a regular file` |
| `stat()` threw | 404 `file missing on disk` |
| `Range` header not `bytes=n-m` | 416 `malformed range` |
| range start > end, or start ≥ size | 416 `unsatisfiable range` |

The ID must resolve to a row, *and* that row's path must be inside an allowed root *after*
symlink resolution, *and* the bytes served must come from the resolved path. A compromised row
must not become an arbitrary-file-read.

The renderer never receives a filesystem path in the first place:
`DocumentFileRefSchema` in `packages/shared-types/src/domain.ts` omits `path` and requires a
`url` starting with `rrfile://`, and `toDocumentFileRef()` in
`packages/database/src/repositories/documents.ts` is the only construction site.

### 5. Allowed roots

`apps/desktop/src/main/paths.ts`.

- `allowedRoots(...)` drops empty and relative entries rather than trusting them, resolves each
  to an absolute path, follows symlinks, and de-duplicates. It is built in `createServices()`
  from the Zotero data directory plus any `extraRoots` (tests only). Resolving the roots
  matters on macOS, where `os.tmpdir()` reports `/var/folders/…` — itself a symlink into
  `/private/var/folders/…` — so an unresolved root would reject every real path beneath it.
  A root that does not exist yet stays in the list lexically; candidates under it are still
  resolved before use.
- `resolveAllowedPath(candidate, allowed)` is the check every caller must use. It rejects a
  relative path and any path containing a NUL byte — a NUL truncates the path inside libc, so
  what the OS opens is not what was checked — then `realpath()`s the candidate and requires the
  *real* path to be contained in some root. It returns that real path, and callers open it
  rather than the stored one: checking one path and opening another is the hole itself, because
  `open()` follows symlinks.
- The two failure modes stay distinct. `outside-roots` is a permission failure worth logging as
  one; `unresolvable` is an ordinary missing file. Collapsing them made a deleted PDF report as
  an attempted escape.
- `isAllowedPath(candidate, allowed)` remains as the lexical predicate, but it is *not*
  sufficient on its own: a symlink placed inside an allowed root names a path that passes it
  while pointing anywhere on disk.
- `isInsideRoot(candidate, root)` compares resolved paths and requires either equality or a
  `root + sep` prefix. The separator check is what stops `/Users/x/Zotero-secrets` from passing
  as inside `/Users/x/Zotero`.

The same function gates extraction: `ExtractionPipeline.runExtraction` in
`apps/desktop/src/main/pipeline.ts` resolves before reading bytes and reads the resolved path,
so a link inside a root cannot feed the extractor a file from outside one.

**Guarded by:** `tests/integration/security.test.ts`, which builds real directories, real files
and real symlinks under a temp root and asserts the escape cases are refused — a file symlink
out of the root, a directory symlink used to traverse out of it, `..` traversal, a relative
path, a NUL-truncated path, a prefix-colliding sibling root — while a symlink that stays inside
the root still resolves.

### 6. Navigation, window opening, permissions, and the network

| Control | Where |
|---|---|
| `setWindowOpenHandler(() => ({ action: 'deny' }))` | `apps/desktop/src/main/index.ts`, applied from `app.on('web-contents-created')` so it binds to every `webContents`, not only the one `createWindow()` builds |
| `will-navigate` cancelled unless the URL is under `app://bundle/` — the packaged renderer origin — or, in development only, under the dev server's own origin | same file — a renderer that navigated away would be running unknown code with the preload bridge attached. The dev check compares the parsed origin, not a string prefix: `http://localhost:5173.evil.com/` is a different host that merely starts with the same characters. |
| All permission requests *and* synchronous permission checks denied | `lockDownNavigation()` → `setPermissionRequestHandler` and `setPermissionCheckHandler`, `apps/desktop/src/main/protocol.ts`. Chromium routes some capability queries through the synchronous path, which without a handler falls back to the default policy rather than the deny-all the app intends. |
| `http://`, `https://`, `ws://` and `wss://` requests cancelled unless the URL's **host** is `localhost`, `127.0.0.1` or `[::1]` | `lockDownNavigation()` → `session.webRequest.onBeforeRequest`. Milestone 1 reads local documents only, so remote loads are blocked outright rather than merely discouraged by CSP. The loopback exception exists for the dev server and its HMR socket. The comparison parses the URL: `startsWith('http://localhost')` admitted `http://localhost.attacker.example/`, a public host that merely shares the prefix — the same collision `isInsideRoot` exists to prevent for paths. |

### 7. Content Security Policy

Declared as a `<meta http-equiv="Content-Security-Policy">` in
`apps/desktop/src/renderer/index.html`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: rrfile:; font-src 'self' data:; connect-src 'self' rrfile:;
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

`'unsafe-inline'` is present for styles only, and only because Dockview and Tiptap inject style
tags at runtime. `script-src` has no such escape hatch. `rrfile:` is permitted for `img-src` and
`connect-src` so readers can fetch document bytes, and for nothing else.

### 8. Zotero is never written to

`packages/zotero-adapter/src/client.ts` issues GET only — there is no code path that builds any
other method — and `~/Zotero/zotero.sqlite` is never opened. Zotero holds a lock on that file
and writing there would corrupt a live library. Zotero item keys are stored in
`external_references` and are never used as internal primary keys.

### 9. Repository hygiene

`check_no_user_data_committed()` in `scripts/verify_completion.py` fails if any tracked file
ends in `.sqlite` or `.db`, sits under a `/zotero/storage/` path, or exceeds 10 MB.
`check_no_any()` rejects explicit `any` type annotations in first-party source and reports every
`eslint-disable` line, so a security lint cannot be silenced quietly.

## Gaps

These are stated because the code does not yet do what the design requires:

- **Archived HTML is not yet rendered at all.** `packages/html-reader/src/index.ts` is a
  placeholder that throws. The sandboxed-iframe treatment described in `docs/SPEC.md` —
  script-disabled, its own stricter CSP, blocked navigation — is designed but unimplemented, so
  none of it is currently enforced by code. The renderer CSP presently sets `frame-src 'none'`,
  which will have to be narrowed to a specific source rather than widened when that reader
  lands.
- **Five request fields accept arbitrary values.** `note:create.contentJson`,
  `note:update.contentJson` and `workspace:saveLayout.layout` are `z.unknown()`;
  `link:create.metadata` and `workspace:saveLayout.panelState` are `z.record(z.unknown())`.
  They are renderer-authored blobs the renderer gets back verbatim, and no injection sink was
  found downstream, but `CLAUDE.md`'s "every IPC payload is zod-validated" holds only at the
  envelope level for these five.
- **There is a TOCTOU window in `rrfile://`.** Containment is decided against the `realpath`,
  and the stream then opens that resolved path, but a symlink swapped between the resolve and
  the open would be followed. Closing it needs an `open()` handle carried from check to read.

Closed since the previous revision of this document, and recorded here because the gaps list
is only useful if it is accurate: the preload shape is now asserted at runtime by
`tests/e2e/shell.spec.ts`, and responses *are* validated on the way out — `dispatch()` parses
every value against `contract.response` outside production.

## Reporting

There is no network service and no account, so there is no remote attack surface to report
against. Security-relevant defects should be filed as ordinary issues on the repository.
