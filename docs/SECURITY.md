# Security model

wiki-reader opens files the user did not write: PDFs from arbitrary publishers and archived
web pages captured from arbitrary sites. Those bytes are the threat. Everything below exists
so that a malicious document cannot become code execution, and cannot become an
arbitrary-file-read either.

## Threat model

| Adversary | Capability assumed | Mitigation |
|---|---|---|
| A malicious PDF | Arbitrary parser input to PDF.js; embedded JS and font programs | Parsed **in the renderer**, which is `sandbox: true` + `contextIsolation: true` with `script-src 'self'` and no `unsafe-eval`, and `isEvalSupported: false` is passed to PDF.js. The renderer holds no path, no handle and no Node API, so a parser compromise there reaches nothing but `rrfile://` bytes it could already read. A *second*, independent parse runs in the main process for search indexing; a page that throws there is recorded as empty rather than aborting the document. |
| An archived HTML snapshot | Arbitrary HTML/CSS/JS captured from a hostile site | Never rendered in the app origin. Scripts disabled, sandboxed frame, restrictive CSP, navigation blocked. Landed with W03/W04 and is the least-tested surface here — see [Gaps](#gaps). |
| A compromised or buggy renderer | Full control of the JS context, can call anything on `window` | Two-function preload; every payload re-validated in main; no path, handle, or shell reaches the renderer at all |
| A tampered database row | A hand-edited row, a restored backup, a relocated Zotero base directory, a symlink planted under the library | `rrfile://` resolves the path through symlinks and refuses anything outside the allowed roots even when the row resolves, then opens the resolved path rather than the stored one |
| The user's own Zotero library | Concurrent writer holding a SQLite lock | Read-only HTTP only; `~/Zotero/zotero.sqlite` is never opened |

Out of scope: a hostile local process on the same machine (it already has the
user's privileges), and network attackers (nothing reaches the network except `127.0.0.1`).

## Enforced invariants

The code and `scripts/verify_completion.py` are authoritative. This table says where each
invariant lives and, where it matters, what broke before.

| Invariant | Enforced by |
|---|---|
| `contextIsolation`/`nodeIntegration`/`sandbox`, no `webSecurity: false` | `main/index.ts`; verifier greps the BrowserWindow |
| Preload exposes exactly one `invoke` and one `subscribe` | `preload/index.ts`; asserted at runtime by `tests/e2e/shell.spec.ts` |
| Every IPC payload zod-validated before dispatch, in one router | `main/router.ts`; verifier fails on `ipcMain.handle` anywhere else |
| Responses validated on the way out | `dispatch()` parses against `contract.response` outside production |
| Renderer never receives or builds a filesystem path | `rrfile://` resolves an internal file ID through the database |
| Containment decided against `realpath`, not lexically | `main/protocol.ts` — a symlink inside an allowed root escaped a lexical check (audit S2) |
| Navigation compared by **origin**, never string prefix | `isAllowedNavigation` — `localhost:5173.evil.com` prefix-matched before (audit S1) |
| Locks bound to every `webContents` | `app.on('web-contents-created')` — binding inside `createWindow` made it conditional on a call site |
| Renderer cannot import `electron`, `better-sqlite3`, `@wr/database`, `@wr/zotero-adapter` | eslint `no-restricted-imports` **and** the verifier, independently |

The last row duplicates deliberately: a disabled lint rule must not be able to hide it.

## Gaps

These are stated because the code does not yet do what the design requires:

- **Archived HTML rendering is new and least proven.** It landed with W03/W04; its CSP,
  script-disabling and navigation blocking have had far less adversarial testing than anything
  above. Treat it as the weakest link.
- **Five request fields accept arbitrary values.** `note:create.contentJson`,
  `note:update.contentJson` and `workspace:saveLayout.layout` are `z.unknown()`;
  `link:create.metadata` and `workspace:saveLayout.panelState` are `z.record(z.unknown())`.
  They are renderer-authored blobs the renderer gets back verbatim, and no injection sink was
  found downstream, but `CLAUDE.md`'s "every IPC payload is zod-validated" holds only at the
  envelope level for these five.
- **There is a TOCTOU window in `rrfile://`.** Containment is decided against the `realpath`,
  and the stream then opens that resolved path, but a symlink swapped between the resolve and
  the open would be followed. Closing it needs an `open()` handle carried from check to read.
- `link:create` ids and types are unconstrained strings despite typed id schemas existing.
  Worth closing now that the graph mints edges.

## Reporting

No network service and no account, so no remote reporting path. File security-relevant defects
as ordinary repository issues.
