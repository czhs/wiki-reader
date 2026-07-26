# Milestone 2 audit — security and architecture lens

Commit: `4420cea8ee5998fddae26db66c0c795c9c8852ba`

Scope: W01..W12 surfaces only (markdown corpus rendering, archived-HTML snapshots over
`rrfile://`, wikilinks/derived links, graph neighbourhood IPC, six-colour highlights, scoped
Zotero import). Milestone-1 findings in `reports/audit-security.md` are not re-reported.
Excluded by request: `apps/desktop/src/renderer/panels.tsx`,
`apps/desktop/src/renderer/annotation-actions.ts` (in-flight refactor).

Attempted falsification of "milestone 2 is complete" on security/architecture. The claim
largely survives: no critical or major finding. Two minor gaps below.

## Findings

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 1 | minor | `packages/graph/src` is renderer-consumed but is not listed in `RENDERER_SOURCE_ROOTS`, so the forbidden-import rule (`electron`, `better-sqlite3`, `@wr/database`, `@wr/zotero-adapter`, `node:fs`…) is **not enforced** against it. No violation exists today — its only deps are `@wr/shared-types` and `cytoscape` — but the new milestone-2 package sits outside the check that exists to catch exactly this. `packages/markdown-reader/src` and `packages/html-reader/src` *were* added; `graph` was missed. | `scripts/verify_completion.py:94-103` (roots list, no `packages/graph/src`); `apps/desktop/src/renderer/graph-panel.tsx:16` imports `@wr/graph`; `packages/graph/package.json` deps |
| 2 | minor | The snapshot-containment guarantee is narrower than the code comment claims. `resolveFileRequest` bounds a resource to its own snapshot only when `resourcePath !== ''`; a bare `rrfile://<any-file-id>/` is served to any `rrfile:` requester, including a sandboxed snapshot frame, whose served CSP allows `img-src rrfile:` / `media-src rrfile:`. Hostile archived HTML can therefore cause an unrelated library document's bytes to be fetched and rendered. Impact is bounded to nil today — scripts are off, the frame origin is opaque, and remote requests are cancelled, so nothing can be read back or exfiltrated — but the comment asserting `rrfile:` cannot mean "any document in the library" overstates what the code does. | `apps/desktop/src/main/protocol.ts:258-279` (containment check gated on `resourcePath !== ''`); comment at `protocol.ts:342-343`; CSP at `protocol.ts:353-364` |

No critical or major findings.

## Verified

Each invariant below was checked against source, not docs.

1. **Window security flags.** `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true`, `webviewTag: false`, `spellcheck: false`; no `webSecurity: false`,
   `allowRunningInsecureContent`, or `nodeIntegrationInSubFrames` anywhere.
   Enforcement: `apps/desktop/src/main/index.ts:120-123`, asserted by
   `scripts/verify_completion.py:405-422` (positive and negative patterns).
2. **Preload surface.** Exactly two functions (`invoke`, `subscribe`) on one
   `contextBridge.exposeInMainWorld('rr', …)`. No raw `ipcRenderer`, no `process` slice, no
   filesystem, no shell. Enforcement: `apps/desktop/src/preload/index.ts` (whole file, 37 lines).
3. **IPC validation and single router.** The only `ipcMain.handle` in the tree is
   `apps/desktop/src/main/router.ts:163`; every request is zod-parsed against its channel
   contract before dispatch (`router.ts:100-113`), unknown channels are rejected, and published
   events are validated on the way out (`router.ts:178-183`).
   `scripts/verify_completion.py:448-451` asserts no `ipcMain.handle|on` outside the router.
   Milestone-2 channels specifically: `graph:neighbourhood` caps `depth ≤ 3` and
   `nodeLimit ≤ 300` **in the contract** (`packages/shared-types/src/ipc.ts:399-407`), so the
   renderer cannot widen them (W10); `zotero:import` takes an optional collection *name*, not a
   path or URL (`ipc.ts:102-127`); `corpus:import` deliberately takes no folder argument, the
   root being main-process config (`ipc.ts:129-151`, `apps/desktop/src/main/services.ts:68-69`);
   `annotation:create`/`update` take `HighlightColorSchema`, a six-value `z.enum`
   (`packages/shared-types/src/highlight-colors.ts:15-22`) — the free-form `z.string()` is gone (W11).
4. **File bytes only via `rrfile://`, no paths to the renderer.** `DocumentFileSchema.path` is
   `.omit()`ed from the renderer projection and replaced with `url: z.string().startsWith('rrfile://')`
   (`packages/shared-types/src/domain.ts:81-85`); the repository parses through that schema, so the
   path is stripped at the source (`packages/database/src/repositories/documents.ts:61`). No handler
   in `apps/desktop/src/main/handlers.ts` returns a path. `resolveFileRequest` requires the ID to
   match `dfl_<26 crockford>` and resolve to a DB row, refuses NUL bytes, and re-checks containment
   against the allowed roots **after** `realpath` — twice for snapshot resources, so a symlink inside
   a snapshot cannot escape it (`protocol.ts:187-293`, `paths.ts:24-85`). Snapshot resources are
   additionally refused unless the entry row is `text/html` (`protocol.ts:315-317`), so a PDF row
   cannot become a directory handle. This satisfies W04.
   Caveat, not a finding: the router skips response re-validation in production
   (`router.ts:125`), so that layer is not a second path-stripping guard there — but the
   repository's own `.parse` always strips, so no leak exists.
5. **Archived HTML treated as hostile.** Framed by URL, never injected into the app document;
   `sandbox=""` with zero tokens (no `allow-scripts`, no `allow-same-origin`) and
   `referrerPolicy="no-referrer"` (`packages/html-reader/src/HtmlReaderView.tsx:121-132`);
   CSP served **with the bytes** so page-supplied `<meta http-equiv>` can only intersect, not
   widen — `default-src 'none'`, no `script-src`, `form-action 'none'`, `base-uri 'none'`, plus a
   redundant `sandbox` directive (`protocol.ts:350-368`) with `nosniff` and `no-referrer`.
   Navigation: `setWindowOpenHandler` denies all, `will-navigate` is refused for disallowed URLs
   (`index.ts:94-105`), all `http/https/ws/wss` are cancelled at the session level via
   `onBeforeRequest` (`protocol.ts:435-464`), and permission request *and* check handlers both
   deny (`protocol.ts:436-442`). `isLoopbackUrl` compares parsed hostnames rather than string
   prefixes. No `contentDocument`/`contentWindow`/`postMessage` use anywhere — the sandbox is
   not quietly worked around.
6. **Renderer never imports main-only modules.** Grep across all `packages/*/src` and
   `apps/desktop/src/renderer` for `from 'electron'`, `better-sqlite3`, `@wr/database`,
   `@wr/zotero-adapter` returns only one prose comment (`packages/graph/src/index.ts:11`), no
   import. Enforcement: `scripts/verify_completion.py:94-122` — see finding 1 for the coverage gap.
7. **No `any`, no suppressions hiding errors.** Zero `: any` / `as any` / `<any>` in
   `packages/*/src`, `apps/desktop/src`, `workers/*/src` (only a prose "as any editor does" in
   `packages/document-model/src/navigation-history.ts:7`). Zero `@ts-ignore`,
   `@ts-expect-error`, `@ts-nocheck`. One `eslint-disable`, and it is a genuine
   `react-hooks/exhaustive-deps` suppression, not a hidden type or security error
   (`packages/note-editor/src/NoteEditorView.tsx:77`).
8. **Markdown corpus rendering (W01/W06) is not an injection surface.** Rendered from the mdast
   AST into React elements — no `dangerouslySetInnerHTML`, no HTML string, anywhere in the
   package. Raw `html` nodes are displayed as literal text in a `<code>` element rather than
   parsed (`packages/markdown-reader/src/render.tsx:145-152`), and every `<a href>`/`<img src>`
   goes through `safeHref`, a scheme **allowlist** (`https?:`, `mailto:`, `rrfile:`, fragment,
   relative), so `javascript:` and `data:` are inert (`render.tsx:255-259`). Being an allowlist,
   it is not defeated by embedded whitespace or case tricks.
9. **Scoped Zotero import (W12) has no injection vector.** The collection is resolved by name
   against the already-fetched collection list, with explicit errors for "no collection named"
   and ambiguous names — the renderer-supplied string is never interpolated into a URL, a path,
   or SQL (`packages/zotero-adapter/src/importer.ts:31-59, 183-211`).
