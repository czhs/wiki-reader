# Milestone 8 — security audit of the vendored Typst compiler

Audited-range: `1c690e2..HEAD` (`8c6d570`)
Lens: the compiler as a **new parser of researcher-authored and excerpt-carried input** — WASM
vs. native sandboxing, file access from Typst source, compile-time network, header paths, the
live-highlight transport, IPC/zod on every new channel, and regressions against `CLAUDE.md`.
Method: read the code, then drove the *actual vendored binary*
(`@myriaddreamin/typst-ts-node-compiler@0.7.0`, `darwin-arm64`) out of tree with the app's own
workspace root and the app's own guard, under Node 20.19.3. Probe scripts are in the session
scratchpad (`audit-probe*.mjs`); every claim below is a measured result, not a reading.

Supersessions were checked before calling anything a regression: `H11`'s removal of the chip
strip beside the saved page (`apps/desktop/src/renderer/panels.tsx:1003`) is the criterion's own
text ("not a side collection"), and `U15`'s retirement of the sidebars is `docs/MILESTONE8.md`
Rules. Neither is reported.

---

## Findings

### 1. MAJOR — the compile-time network guard is defeated by Typst's own string escapes

`packages/document-model/src/typst.ts:289` — `NETWORK_IMPORT_RE`
`packages/document-model/src/typst.ts:297` — `refuseNetworkImports`
`apps/desktop/src/main/typst.ts:185` and `:174` — the two call sites

The guard is a regex over raw source: `/(?:^|[^\p{L}\p{N}_])@(preview|local)\//mu`. A Typst
package spec is an ordinary string literal, and Typst string literals support `\u{…}`, so the
same import written `"\u{40}preview/…"` never matches. String concatenation defeats it too.
Both reach the registry:

```
--- literal @preview import       app guard: "Typst packages are fetched over the network…"
--- escaped @preview import       app guard: null   hasError=true (778ms)
    "package not found (searched for @preview/wr-audit-not-real:0.1.0)"
--- concatenated "@pre" + "view/…" app guard: null  hasError=true (711ms)
    "package not found (searched for @preview/wr-audit-not-real3:0.1.0)"
--- third namespace @wraudit/…    app guard: null   hasError=true (1ms)
```

The ~700 ms on the `preview` namespace against 1 ms on a local one is the HTTP round trip, and
the binary carries the URL template that makes it: `strings` on the addon yields
`https://packages.typst.org/preview/-.tar.gz` and the compiled-in
`crates/tinymist-package/src/registry/http.rs`. So the source that gets past the guard makes the
app **download and then execute third-party Typst code, in the main process, at compile time** —
against `docs/MILESTONE8.md` Rule 1 ("the compiler runs local … no network at compile time") and
against the frozen decision at `state/DECISIONS.md` which states `@preview/` and `@local/`
"never reach it".

Not reachable from a hostile document: `escapeTypstText` escapes `#` and `\`, so an excerpt
carried out of a PDF cannot spell an import (verified — `#read("/etc/hosts")` in selected text
compiles to the literal characters). This is the researcher's own source, and a Typst snippet
pasted from elsewhere. That bounds the harm; it does not make the guard hold.

**Shape of the fix.** A deny-list over unparsed source cannot be made correct — the module's own
philosophy elsewhere (`ALLOWED_TAGS`, `ALLOWED_ATTRS`, `isSafeSrc`) is an allow-list, and the
same answer applies here: refuse every `#import`/`#include` whose argument is not a string
literal naming one of the two header paths, rather than trying to enumerate the spellings of
`@preview`. Whatever the rule becomes, it must run over the *decoded* string, not the source
text.

### 2. MAJOR — the test that guards "nothing is fetched" cannot observe the compiler's network

`tests/e2e/notebook-typst.spec.ts:119-126` (the resource-timing assertion)
`tests/e2e/notebook-typst.spec.ts:128-131` (the refusal assertion)

`S04`'s local-first evidence is

```ts
const requested = await window.evaluate(() =>
  performance.getEntriesByType('resource').map((entry) => entry.name) …
```

which is the **renderer's** resource timeline. The compiler runs in the main process by design
(`apps/desktop/src/main/typst.ts:10-16`), so no compile-time fetch can ever appear in that list —
the assertion is structurally incapable of failing for the thing it is named after. The refusal
assertion beside it exercises only the literal `@preview/` spelling, which is the one spelling
finding 1 does not break. Between them, the criterion is green over an untested claim.

An honest guard is available in-process: assert on `TypstService`'s refusal in an integration
test over the escaped spellings, and/or fail the compile when a diagnostic mentions package
resolution. This is worth fixing together with finding 1 — it is why finding 1 shipped green.

### 3. MINOR — the guard runs on the request, not on the bytes that are compiled

`apps/desktop/src/main/typst.ts:185` vs `:196-197`

`render()` checks `request.source`, then hands the compiler three more strings it does not
check: the prelude, the stored global header and the stored local header
(`compiler.addSource(this.#virtual(TYPST_GLOBAL_HEADER_PATH), …)`). Headers are validated at
*write* time only (`saveSettings` → `checkHeader`, `handlers.ts:'notebook:writeHeader'`), so a
header that got stored by any path that is not those two — a future writer, a restored settings
row, or finding 1 — is trusted forever, and is then compiled into *every block of every
notebook*. Guard the exact strings handed to the compiler, at the point they are handed over.

### 4. MINOR — file confinement holds, but it rests on a real path happening not to exist

`apps/desktop/src/main/typst.ts:137` — `this.#root = join('/', 'wiki-reader', 'typst')`

Verified good: Typst itself refuses to leave the root, so nothing a document can write escapes.

```
#read("/etc/hosts")                → file not found (searched at /wiki-reader/typst/etc/hosts)
#read("../../../../etc/hosts")     → failed to load file (access denied),
                                     cannot read file outside of project root
#include "../../../../etc/hosts"   → access denied
#image("../../../../etc/hosts")    → access denied
```

The comment calls the root "virtual … the directory need not exist", but it is an ordinary
absolute path: were `/wiki-reader/typst` ever to exist, its contents become readable by any
notebook. On macOS an unprivileged process cannot create it, which is why this is minor rather
than more. Nothing asserts the property, and there is no test anywhere in the tree for the
confinement — the four refusals above are the audit's, not the suite's.

### 5. MINOR — only two package namespaces are refused; the rest resolve off local disk

`packages/document-model/src/typst.ts:289`

`@preview` and `@local` are named; a third namespace is not, and Typst resolves it out of the
user's Typst data directory (`@wraudit/thing:0.1.0` → "package not found (searched for …)" in
1 ms, i.e. a local lookup, not a refusal). So the module docs' claim that "every file the
compiler can see is one this process handed it in memory"
(`apps/desktop/src/main/typst.ts:29-32`) is not exact: a `.typ` file the researcher has under
`~/…/typst/packages/<ns>/` is reachable and its code runs inside the compiler. Same fix as
finding 1 — an allow-list of import targets makes namespaces a non-question.

### 6. MINOR — `escapeTypstText` does not neutralise Typst's bare-URL autolinking

`packages/document-model/src/typst.ts:71-75`

The escape set is documented as "exact rather than generous". It misses that Typst turns a bare
`http://…` in content into a real link. A quoted sentence out of a PDF that contains a URL
compiles to an anchor pointing wherever the document said:

```
input : "] #link(\"http://evil.example/x\")[click] ["
html  : <blockquote …>] #link(“<a href="http://evil.example/x">http://evil.example/x</a>”)[click] [</blockquote>
```

The `#link(` and the brackets were neutralised correctly; the URL inside them was not. The
consequence is contained one layer out — `drawLink` renders any scheme it does not recognise as
an inert `<span>` (`apps/desktop/src/renderer/typst-view.tsx:125-129`), so nothing navigates —
but the containment is the renderer's, and the escape function claims to be the boundary. This
is exactly the failure its own docblock describes ("would otherwise render a second attribution
chip pointing wherever the document said"), one construct over.

Two smaller fidelity notes on the same function, both verified: `~` in quoted text becomes a
non-breaking space, and a line of a quotation beginning `1.` becomes an enumeration — a
quotation is meant to be verbatim, and `-`, `+`, `/`, `=` are escaped at line start for exactly
this reason while the numbered case is not.

### 7. MINOR — headers can be crossed between two open notebooks by a concurrent compile

`apps/desktop/src/main/typst.ts:196-204`

The sequence is: `addSource(global)`, `addSource(local for this notebook)`,
`await this.#mountPictures(…)`, then compile. The `await` is not a formality when a picture has
to be mounted — `resolveFileRequest` does real filesystem I/O (`realpath`, `stat`, `readFile`),
which yields to the event loop, and the renderer fires one `typst:render` per block plus the
live render, so other handlers run inside that window. A second notebook's render that lands
there calls `addSource` on the same virtual local-header path, and the first request then
compiles against the **other notebook's header**. The compiler is one shared instance
(`typstService`, `:352-361`) and the two virtual header files are its only per-notebook state.

Two notebook pages open at once is a supported state that the code names in several places, so
this is reachable, though it needs a first-time picture mount to open the window. The fix is to
serialise a compile with its own `addSource` calls (a promise chain on the service, or mount
pictures before touching the header sources).

### 8. MINOR — mounted picture bytes are never released, and never refreshed

`apps/desktop/src/main/typst.ts:129` (`#shadowed`), `:261-283`

`#shadowed` is a `Set` that only grows: a file id mounted once is skipped forever after, so the
compiler keeps every picture any notebook has ever referenced resident in main-process memory
for the life of the process (`evictCache` at `:225` evicts memoized compiles, not shadows), and
a picture whose bytes change on disk goes on rendering the old ones until the app restarts.
`unmapShadow`/`resetShadow` exist on the addon for this.

### 9. MINOR — a compile blocks the main process; `source` has no bound

`apps/desktop/src/main/typst.ts:207-219`, `packages/shared-types/src/ipc.ts:961`

The NAPI calls are synchronous. Measured: a 274 ms compile prevented a 50 ms timer from firing
in the same process. The module's claim (`:13-16`) — that a different *process* makes "a slow
compile must never hold a keystroke" structural — is true for the renderer's keystrokes, which
is what `S07` asks, and false for everything else the main process serves while it compiles:
`rrfile://` bytes for a PDF being scrolled beside the notebook, and every other IPC channel.
Measured cost is small in normal use (10 blocks 3 ms, 200 blocks 26 ms, 600 blocks 76 ms for the
full-document paged render), so this is minor on its own — but it is the multiplier on finding
1, where a single import turns every compile into a ~700 ms main-process stall, and `source`
carries no `.max()` to bound the worst case.

Two adjacent notes, same area: the live render's data URI is rebuilt on every React render of
`LiveRender` rather than memoised (`apps/desktop/src/renderer/notebook-typst.tsx:183-188`) —
`btoa(unescape(encodeURIComponent(svg)))` measured 24 ms for a 200-block page and 75 ms for a
600-block one, on the renderer's UI thread this time.

### 10. MINOR — the security-critical half of `@wr/document-model` has no unit tests

`packages/document-model/src/typst.ts` (no `test/typst.test.ts` anywhere in the tree)

`escapeTypstText` and `refuseNetworkImports` are the two controls standing between
document-controlled text and a compiler, and between the researcher and the network. Neither has
a unit test; the only coverage is the E2E in finding 2. The module is pure and string-shaped by
design ("testable without a compiler"), which makes the omission cheap to fix — and findings 1
and 6 are both one table-driven test away from being caught.

### 11. MINOR — two different defaults for "a body format that cannot be read"

`packages/database/src/repositories/questions.ts:129-135` returns
`DEFAULT_NOTEBOOK_BODY_FORMAT` (`'typst'`) for an unrecognised or missing value, while
`NotebookBodyFormatSchema` (`packages/shared-types/src/domain.ts`) defaults to `'markdown'` and
says why: "a body whose format cannot be read is a body that was written before there was
anything to read". The column is `NOT NULL DEFAULT 'markdown'` so the two cannot disagree today,
but the repository's answer is the one that would compile a markdown paper as Typst.

---

## Verified, and worth stating because the lens asked

- **WASM was not adopted, and that is the right call for the CSP.** No `wasm-unsafe-eval`; the
  renderer CSP at `apps/desktop/src/renderer/index.html:18` is byte-identical to milestone 7's.
  The trade is that the compiler is *native and unsandboxed in the main process*, so the whole
  containment story rests on Typst's own root confinement (finding 4, verified) plus the app's
  network guard (finding 1, not verified). The verifier now names the addon in
  `FORBIDDEN_RENDERER_IMPORTS` (`scripts/verify_completion.py:263`), which is a
  strengthening, not a weakening.
- **The compiler answers a tree, never an HTML string.** `sanitize`
  (`apps/desktop/src/main/typst.ts:302-350`) allow-lists tags and attributes; the renderer maps
  it to React elements. There is no `dangerouslySetInnerHTML` or `innerHTML` anywhere in
  `apps/desktop/src` or `packages/*/src`.
- **`javascript:` cannot navigate.** `#link("javascript:alert(1)")` does compile to
  `<a href="javascript:alert(1)">` and the sanitizer does keep `href` — but `drawLink` renders
  every scheme outside `annotation://`/`document://`/`note://`/`wiki://` as an inert `<span>`
  (`typst-view.tsx:125-129`). Verified against the real compiler.
- **`#html.elem("script", …)` cannot inject.** `script` is not on the tag allow-list, so the
  element is unwrapped and its body survives as a React text node, not as markup.
- **Mathematics is not silently dropped, and the SVG cannot script.** The HAST target renders
  `html.frame` as `<img src="data:image/svg+xml;base64,…">` (verified — the serialized HTML
  string is an inline `<svg>`, the tree is not), `isSafeSrc` admits only `data:image/`, and an
  SVG inside `<img>` is in secure static mode. The live render takes the same route
  (`notebook-typst.tsx:183-188`) rather than inlining markup.
- **Picture bytes go through the one allow-list.** `#mountPictures` extracts only
  `dfl_[0-9a-hjkmnp-tv-z]{26}` ids from the source and resolves them through
  `resolveFileRequest` (`apps/desktop/src/main/protocol.ts:239`), which re-resolves symlinks and
  refuses anything outside the allowed roots. Header paths are module constants, and `#virtual`
  strips leading slashes before joining — there is no attacker-controlled path component.
- **Every new channel is zod-validated in the single router.** `typst:render`,
  `typst:getSettings`, `typst:setSettings` and `notebook:writeHeader` are declared in
  `packages/shared-types/src/ipc.ts` and dispatched through `dispatch`
  (`apps/desktop/src/main/router.ts:148`), which `safeParse`s every request. No new
  `ipcMain.handle` was added; the preload was not touched in this range; no channel accepts a
  filesystem path.
- **The live-highlight transport is unchanged.** `H11` removed the chip strip and added a count
  (`panels.tsx:902-919`, `:1003-1015`); the mark still reaches the frame the way `H10` built it
  — repainted into the archive's bytes at serve time, with the `?marks=` revision on the
  `rrfile://` URL forcing the refetch (`packages/html-reader/src/HtmlReaderView.tsx:262-263`,
  last touched by `c331185`, outside this range). No new transport, no new injection surface.
- **Migration 016 keeps the promise it claims.** `body_format` defaults to `'markdown'` and
  nothing rewrites a row, so a page written before the switch is untouched by construction
  rather than by a converter's accuracy.

## Recommendation

Findings 1 and 2 should be closed before the milestone is called done: one is a stated rule
enforced by a guard that two one-line spellings walk past, the other is the reason nobody
noticed. Both fixes are small and belong together — an allow-list of import targets, plus an
in-process test that exercises the spellings the current regex misses. Findings 3, 5 and 10 fall
out of the same fix. The rest can be scheduled.
