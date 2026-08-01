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
| A hostile document read *by the librarian* | Prompt injection: a saved page or PDF that instructs the agent | The agent proposes; nothing it writes becomes a document without an explicit accept. Its wiki is `chmod`-sealed read-only before the spawn, so an instruction to rewrite the sources fails in the kernel. Its citations are resolved against the database, and the id prefix — not the agent — decides which table each resolves in. |
| The spawned `claude` itself | A child process running as the user, writing with its own tools | Three layers, only two of which are ours: `cwd` is the run staging directory; `--add-dir` names one tree and that tree is sealed read-only (asserted by having the child attempt the write, `librarian-accept.test.ts`); everything else rests on the `claude` CLI's own permission model under `--permission-mode acceptEdits`. That third layer is third-party and **not asserted by any test here** — see [Gaps](#gaps). |

Out of scope: a hostile local process on the same machine (it already has the
user's privileges), and network attackers.

**With agents and card art off, nothing reaches the network except `127.0.0.1`** (the Zotero
local API). There are exactly two deliberate exceptions to local-first, both off by default and
both gated on a disclosure of what would be sent:

- **The librarian agent.** Switching it off stops the schedule, cancels any run, and removes the
  materialised wiki from disk.
- **Card art** (`G05`). Two hosts and no others: `api.scryfall.com`, and `cards.scryfall.io`,
  which is where the API's `format=image` redirect sends the bytes. Both are named in the
  disclosure and built in the main process from constants — `cardArt:fetch` takes a card's
  *name*, never a URL, so the channel cannot be aimed at a server of the caller's choosing.
  **Redirects are followed by hand, and the allow-list is applied to every hop**, scheme and
  port included, up to three. `redirect: 'follow'` would check only the URL this code built and
  then let a `Location` header pick the host the bytes actually come from — which, since the
  live path *is* a redirect, would have been the normal case rather than an edge one. The reply
  must be one of four image content types (`image/svg+xml` is deliberately not among them: it
  carries script), is capped at 8 MB, and is refused before its bytes reach the cache directory
  `rrfile://` serves from. No cookie, no referrer, no credential goes with the request. Each
  picture is cached on disk keyed by its URL, so it is fetched once in the life of the
  installation.

## Enforced invariants

The code and `scripts/verify_completion.py` are authoritative. This table says where each
invariant lives and, where it matters, what broke before.

| Invariant | Enforced by |
|---|---|
| `contextIsolation`/`nodeIntegration`/`sandbox`, no `webSecurity: false` | `main/index.ts`; verifier greps the BrowserWindow |
| Preload exposes exactly one `invoke` and one `subscribe` | `preload/index.ts`; asserted at runtime by `tests/e2e/shell.spec.ts` and `board.spec.ts` — it also *handles* file drops, which exposes nothing |
| A filesystem path never arrives on a channel the renderer can address | The drop is read in the preload (`webUtils.getPathForFile`) and sent on `wr:drop`, which the bridge does not expose. A path in a `wr:invoke` channel would be an arbitrary-file-read: name it, have it added to the library, read it back over `rrfile://` (`[N07]` asserts the renderer's attempt is refused) |
| A file added from disk widens the allow-list by exactly one **file** | `SwappableRoots.admit` stores single paths and `isAdmittedFile` compares them exactly; admitting the containing folder would hand over everything beside the paper (`[N07]` asserts the sibling stays refused, across a restart) |
| Every IPC payload zod-validated before dispatch, in one router | `main/router.ts`; verifier fails on `ipcMain.handle` anywhere else |
| Responses validated on the way out | `dispatch()` parses against `contract.response` outside production |
| Renderer never receives or builds a filesystem path | `rrfile://` resolves an internal file ID through the database |
| Containment decided against `realpath`, not lexically | `main/protocol.ts` — a symlink inside an allowed root escaped a lexical check (audit S2) |
| Navigation compared by **origin**, never string prefix | `isAllowedNavigation` — `localhost:5173.evil.com` prefix-matched before (audit S1) |
| Locks bound to every `webContents` | `app.on('web-contents-created')` — binding inside `createWindow` made it conditional on a call site |
| A saved page can be highlighted without the archive gaining any capability | `reportSnapshotSelection` in `main/index.ts` reads the selection from Chromium's context-menu params (`H01`). The `sandbox` attribute stays empty, the served CSP is unchanged, and what crosses to the renderer is a document id and the selected words — never the frame URL, never a path |
| Renderer cannot import `electron`, `better-sqlite3`, `@wr/database`, `@wr/zotero-adapter` | eslint `no-restricted-imports` **and** the verifier, independently |
| A progress line carries no filesystem path | `withoutFilesystemPaths` in `main/paths.ts`, applied in `agentProgress` to both free-text fields — the transcript is full of absolute paths, and `agent:progress` published them verbatim until audit finding 1 |
| The agent's own wiki is read-only to it | `WikiView` seals the tree `0444`/`0555` before the spawn; the kernel refuses, not the prompt |
| One pass at a time | `LibrarianService.busy`, true from the moment a pass is entered — `runner.busy` only went true at the spawn, leaving the whole `materialise()` unguarded (audit finding 4) |
| A proposal is decided once | `agent_proposals` updates `WHERE status = 'pending'`, and `LibrarianService.accept` shares its in-flight promise per proposal — the document mint sits two awaits before that guard (audit finding 3) |

The `no-restricted-imports` row duplicates deliberately: a disabled lint rule must not be able
to hide it.

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
- **The spawned agent's outer boundary is a third party's.** `cwd` and the sealed `--add-dir`
  tree are ours and are asserted. Everything beyond them — the home directory, the wiki-reader
  database, `~/.ssh` — is held only by the `claude` CLI's own permission model. There is
  evidence it holds (the recorded transcript shows a `/tmp` read being refused for want of a
  grant) but no test here asserts it, and it is one CLI version's behaviour.
- **The child inherits the whole main-process environment.** `spawn` passes `process.env`, so
  every secret the app was launched with is handed to it. The disclosure says the app never
  sees or stores the user's credentials, which is true, and does not say this.
- **The `rrfile://` allow-list contains the whole agent workspace**, not just the `notes/`
  directory accepted proposals land in — so `.runs/` staging is inside the served root. Not
  reachable today: `rrfile://` takes file ids, not paths, and the only code that mints a row
  under this root does so for `notes/*.md`. A widened seam rather than a hole.
- **The materialised wiki persists between passes.** It is removed when agents are switched
  off, but with them on, a copy of every document's text sits at `<userData>/agent/wiki`
  between runs rather than only during one.

## Reporting

No network service and no account, so no remote reporting path. File security-relevant defects
as ordinary repository issues.
