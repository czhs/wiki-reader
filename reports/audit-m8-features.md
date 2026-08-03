# Milestone-8 audit — the Typst switch and the shell fixes

Range `1c690e2..HEAD` (`8c6d570`). One lens: `S04`–`S09`, `U13`–`U15`, `H11`, `P13` — does each
test keep the promise its title makes; is the markdown migration lossless; do the superseded
tests prove their new titles; compile-on-keystroke performance; and what the suite now costs.
`docs/MILESTONE8.md`'s **Supersessions** rule was read first: the journal margin's Commands and
Advances sections, the side-panel opens, `U04`'s sidebar-replacement promise and `U09`'s
drag-resize half are re-promises, not regressions, and nothing below calls one of them a bug.

Run for this lens, all green: `packages/workbench` (11 files, 182 tests) and
`tests/integration/guide-controls.test.ts`; `tests/e2e/notebook-typst.spec.ts` (5 passed, 15.9s)
and `tests/e2e/{tabs,activity-bar,shell-chrome}.spec.ts` (11 passed, 15.9s). The full E2E suite
was not run. Four probes were driven against the vendored compiler itself
(`@myriaddreamin/typst-ts-node-compiler` 0.7.0, loaded exactly as `main/typst.ts` loads it) to
measure what the app cannot be asked at the DOM: escaping, disk reach, header semantics, the
shape of the emitted HAST, and compile times.

---

## Findings

### 1. (major) A notebook written before the switch draws a Typst live render beside it, and that render can only fail

`apps/desktop/src/renderer/notebook-panel.tsx:775-782` and `:811-818` mount `LiveRender` purely
on `placement`:

```tsx
{placement === 'above' && (
  <LiveRender questionId={notebook.id} body={page.body} placement="above" widthPt={renderWidth} />
)}
```

There is no `page.bodyFormat === 'typst'` guard — while the two header boxes thirty lines above
*are* guarded (`:677`), which is what makes this look like an oversight rather than a decision.
`LiveRender` calls `useTypstRender(body, { target: 'svg' })` (`notebook-typst.tsx:161`), so a
**markdown** body is sent to the Typst compiler.

Measured, compiling through the same prelude the main process uses:

| body | result |
|---|---|
| `'## Prior work\n\nSpacing **beats** massing.\n'` (the `S04` legacy fixture) | `ERROR: the character '#' is not valid in code` |
| `blankNotebook()` (what an unwritten legacy page is shown as) | `ERROR: the character '#' is not valid in code` |

So a legacy notebook opened at any ordinary window size draws
`[data-testid="notebook-live-render-error"]` reading *"Typst: the character `#` is not valid in
code"* against a page that is not Typst and was never meant to be compiled. `placement` at
1440×900 is `right` — `S07`'s own test drives the panel to a 1.6 aspect to *get* `right`
(`notebook-typst.spec.ts:290-293`), and the untouched window is around there. The researcher
cannot turn it off either: the placement setting lives inside `TypstHeaders`, which a markdown
page does not draw.

This is `S04`'s own subject — *"a page written before the switch is untouched"* — and `S04`'s
test misses it because the legacy branch asserts only the markdown heading and the absence of
the header box (`tests/e2e/notebook-typst.spec.ts:135-138`).

Fix is one condition, plus one line in that branch:
`await expect(window.locator('[data-testid="notebook-live-render"]')).toHaveCount(0)`.

### 2. (major) Inline mathematics is drawn as a block, and `[S02]`'s new title says "inline and display" while its body can no longer tell them apart

`apps/desktop/src/main/typst.ts:64` prepends `#show math.equation: it => html.frame(it)`.
Typst's `html.frame` is **block level**. Measured on the exact source the test types
(`tests/e2e/notebook-page.spec.ts:207`), the emitted HAST is:

```
body
  p     text "Retention decays as"
  img   class=typst-frame src=data:image/svg+xml;base64,…
  p     text ", so the schedule solves"
  img   class=typst-frame …
```

The sentence is three stacked pieces, with the comma starting its own paragraph. Under KaTeX it
was one line. `state/DECISIONS.md` records the rule as producing "an inlined SVG"; it does not.

The superseded test used to assert `data-display` was `inline` for the first and `block` for the
second (`git show 1c690e2:tests/e2e/notebook-page.spec.ts:205-211`); it now asserts
`await expect(maths).toHaveCount(2)` (`notebook-page.spec.ts:211-212`) — which is exactly as true
when both are blocks. The title *"mathematics is typeset in a notebook block, inline and
display"* is therefore not proved by the body, and the behaviour it stopped watching is the one
that regressed. `S02` is a milestone-6 criterion that still gates and is not on `MILESTONE8.md`'s
supersession list.

A show rule that emits `html.frame` inside a `box` (or `html.elem("span", …)` around it) keeps
the sentence whole; either way the test needs an assertion that distinguishes the two cases
again, or the title has to stop claiming "inline".

### 3. (major) `escapeTypstText` does not escape `~`, so a quoted "~50%" loses its tilde in the typeset page

`packages/document-model/src/typst.ts:71-75` escapes `\ # $ * _ ` @ < > [ ]` plus line-leading
`- + / =`, and its comment says the set is "exact rather than generous". `~` is missing, and in
Typst markup `~` is a **non-breaking space**. Measured:

| quoted text | typeset text |
|---|---|
| `about ~50% of runs` | `about  50% of runs` |
| `a ~ b` | `a   b` |

`selectedText` is named in that same comment as "the one input on this path that a PDF or a page
off the open web controls" — and `~` before a number is ordinary scientific prose. The stored
source keeps the character; what silently loses it is the paper. (`--` → en dash and `"` → curly
quotes also happen and are correct typography for a quotation; the tilde is the one that deletes
meaning.)

### 4. (major) A blank line inside a multi-line Typst construct splits it into two blocks, and neither half compiles

`apps/desktop/src/renderer/block-source.ts:110-118` accumulates non-blank lines until a blank
one. Only ``` fences survive a blank line (`:83-108`). Typst's own multi-line constructs do not:

```
#figure(
  image("/img/dfl_…"),

  caption: [Retention against spacing],
)
```

becomes two blocks; `TypstBlockBody` compiles each alone (`blocks.tsx:160`), so the researcher
gets two red blocks and no figure. The same is true of `#table(…)`, a `#let` with a blank line in
its body, and any `#{ … }` code block. `parseBlocks`' contract is documented as markdown's rule
("blank lines separate blocks") and `S04`'s spec repeats that the two languages share it
(`notebook-typst.spec.ts:107-108`) — but markdown has no construct that spans a blank line
outside a fence, and Typst has several. The guide tells the researcher to write Typst
(`guide.ts:759-760`) and says nothing about the rule.

No test covers it. The cheapest honest fix is a bracket-depth guard in `parseBlocks` for
`language === 'typst'` (do not end a chunk while `(`/`[`/`{` are unbalanced), which is also what
would let `S06`'s `#figure` example be written the way Typst's own documentation writes it.

### 5. (major) `packages/document-model/src/typst.ts` has no unit test

326 lines, entirely pure, and the module's own header says so: *"Everything here is pure and
string-shaped, so it is testable without a compiler"* (`:24-25`). Its markdown siblings are
tested where they live — `packages/document-model/src/excerpt.test.ts`,
`packages/document-model/src/markdown.test.ts` — and there is no `typst.test.ts`. Everything the
module decides is currently proved only by whatever an E2E happens to type: benign fixture
sentences with no punctuation in them.

Findings 3 and 11 are precisely what such a file catches, in milliseconds, without a window.
`escapeTypstText` in particular is a security-shaped function (it is what stops a PDF's text
from carrying `#link(...)` into the researcher's document) and nothing exercises it with hostile
input. `refuseNetworkImports`, `typstSections`, `parseTypstImage`/`withTypstImageWidth` and
`blankNotebookTypst` are all in the same position.

### 6. (major) `[J03]`'s E2E asserts only an absence, while its title still claims the app says something it can no longer say

`tests/e2e/journal.spec.ts:177-190` is titled *"an entry says which other notebook it advanced,
without a margin section for it"*. The body writes an entry and then asserts that
`journal-advances` and `journal-advance-picker` do not exist. Nothing in it makes an advance, and
nothing in it reads one back — the first clause of the title is not tested here.

It is not tested anywhere in the app either, because the picker was the only way to make one:
`journal:advancesNotebook` (`apps/desktop/src/main/handlers.ts:1252`, schema
`packages/shared-types/src/ipc.ts:738`) now has **no renderer caller** — `grep -rn "journal:advance"
apps/desktop/src/renderer` is empty. The edge remains a real typed edge and the repository-level
promise still passes (`tests/integration/journal.test.ts:356`), which is what
`MILESTONE8.md:16-18` permits; what is not permitted is a title that goes on describing a
sentence the researcher can no longer cause the app to say.

Retitle it to what it proves ("the journal margin no longer offers advances"), or fold it into
`[P13]`, which asserts the same absences more thoroughly (`journal.spec.ts:788-841`). The dead
channel should either go or be reachable.

### 7. (major) A `#show` or `#set` rule in either header is accepted and then does nothing, and the guide advertises exactly that use

`typstPrelude` (`packages/document-model/src/typst.ts:324-326`) imports both headers as modules:

```
#import "/wr-global.typ": *
#import "/wr-local.typ": *
```

A wildcard import brings **bindings**. Set and show rules in a module apply inside that module
only. Measured, with `#show heading: it => [SHOW: #it.body]` as the global header and `= Method`
as the body: the page renders `Method`, not `SHOW: Method`. `checkHeader`
(`apps/desktop/src/main/typst.ts:173-182`) compiles the header alone, where such a rule is
perfectly valid, so it is **accepted** and stored — the researcher gets no error and no effect.

`packages/workbench/src/guide.ts:204` tells them to do it: *"Typst definitions shared by every
paper you write — a command for a claim, **a style for a figure**"*. A style for a figure is a
show rule. Either the prelude has to apply the headers' rules (they can be re-exported as a
`#let` template the body is wrapped in, or the header text can be `#include`d rather than
imported — at the cost `typstPrelude`'s comment correctly warns about), or the guide and the
placeholders have to say "definitions only".

---

## Minor

8. **A local header cannot build on the global one.** Measured: global `#let claim(b) = [C: #b]`,
   local `#let loud(b) = claim(strong(b))`, body `#loud[x]` → `unknown variable: claim`. The two
   modules are siblings; neither sees the other. `checkHeader`'s isolated compile
   (`apps/desktop/src/main/typst.ts:180`) also refuses a local header that uses a global name at
   top level, with the same message. One line fixes the common case: prepend
   `#import "/wr-global.typ": *` to the local module's source in
   `apps/desktop/src/main/typst.ts:197`.

9. **The live render is not live, and blanks rather than going stale.** `notebook-panel.tsx:778`
   and `:814` pass `body={page.body}`, which only changes when a block *commits* (blur or
   `Cmd+S`) — so nothing is compiled while a sentence is being typed, and the 250 ms debounce at
   `notebook-typst.tsx:24` has nothing to debounce. The comments claim otherwise
   (`notebook-typst.tsx:15`, "a slow compile is a stale picture"; `:147-149`, "follows the whole
   document while it is being typed"). And when the body does change,
   `typst-view.tsx:208` sets `PENDING` — `svg: null` — before scheduling, so the `<img>` unmounts
   and the pane is empty for the debounce plus the round trip instead of holding the last page.
   Keeping the previous rendering while a new one is in flight is a two-line change to
   `useTypstRender`. **Performance itself is not a problem**: measured on this machine a warm
   HTML compile of a block is 0.06 ms, an identical one 0.02 ms, a block with an equation 0.09 ms,
   and the whole 40-section page to SVG 4.1 ms — the IPC hop dominates, and it is in the main
   process, so no keystroke can be held.

10. **`readBodyFormat` falls back to `typst`.** `packages/database/src/repositories/questions.ts:129-136`
    returns `DEFAULT_NOTEBOOK_BODY_FORMAT` (`'typst'`) when the column holds anything the enum
    does not know. The migration's whole argument is that the unreadable case is the *old* one
    (`016_notebook_typst.ts:5-9`), so the safe fallback here is `'markdown'`. Unreachable today —
    the column has a `NOT NULL DEFAULT 'markdown'` — but it is the one place the decision is
    written backwards.

11. **`parseTypstImage` gives up on an alt containing `)` or `"`.** `IMAGE_CALL`'s second group is
    `((?:,[^)]*)?)` and `ALT_ARG` is `alt:\s*"([^"\\]*)"`
    (`packages/document-model/src/typst.ts:197-199`). A picture whose library title is
    `figure (draft)` produces `#image("/img/dfl_…", alt: "figure (draft)")`, which does not match
    at all: the block stops being an `image` block, loses its resize handle (`P11`) and renders as
    prose. A title containing `"` matches but loses its alt, and `withTypstImageWidth` then writes
    the alt away. Alt text comes straight from `document.title` (`apps/desktop/src/main/handlers.ts:216`),
    i.e. from a dropped file's name.

12. **`refuseNetworkImports` fires inside raw fences.** `packages/document-model/src/typst.ts:289`
    is a plain line-scan, so a block that merely *shows* ` ```#import "@preview/cetz": *``` ` is
    refused and renders as an error. Harmless but wrong, and `typstSections` right above it
    already knows how to skip a fence.

13. **The addon prints `Get HastElementContent.` to stdout on every `hast()` call.** Visible in
    the E2E run above (dozens of `[electron] Get HastElementContent.` lines per test) and in the
    packaged app's main-process output. `state/NEXT_ACTION.md:184` tells the next session to read
    the streamed `list` output; this is now the loudest thing in it.

14. **`apps/desktop/src/renderer/App.tsx:1-13` still describes the shell `U15` removed** — "a
    sidebar", "a right sidebar for annotations", "a bottom panel for reference results". The
    commit *The comments say what the surface is now* reached the other files; this is the shell's
    own header.

15. **`scripts/verify_completion.py:197` still describes `U09` as "Panels and sections minimize
    and drag-resize; the annotations panel closes".** Two thirds of that is retired by `U14`/`U15`
    and the surviving test proves the rest (`shell-chrome.spec.ts:30`). The verifier is not
    weakened by this — it matches on the tag — but the table is now the only place claiming a
    promise nothing keeps.

16. **`tests/e2e/support/corpus.ts:154-155` calls `openLibrary` then `showLibrary`.** After the
    rename the two are the same conditional retry loop with the same 30 s ceiling; one of them
    should go.

17. **Nothing verifies the 46 MB compiler reaches the packaged bundle, and its absence is
    silent.** `apps/desktop/src/main/typst.ts:233-250` degrades to *"The Typst compiler is not
    available in this build"* by design, `electron-builder.yml` relies on electron-builder's
    implicit `node_modules` copy for it (`:22-26`), and the binary lives in an *optional* platform
    sub-dependency under pnpm's isolated layout
    (`node_modules/.pnpm/@myriaddreamin+typst-ts-node-compiler-darwin-arm64@0.7.0/…`). The E2E
    suite runs `out/`, never the bundle. Before the swap, one command settles it:
    `find /Applications/wiki-reader.app -name 'typst-ts-node-compiler.*.node'` — and it belongs in
    the ledger's "checked the built bytes" ritual beside the `markSnapshotHtml` check.

18. **`H11`'s "the moment it is made" is a re-fetch of the archive.** `HtmlReaderView.tsx:262-266`
    changes the frame's `?marks=` query, which is a full load of the saved page; only the
    `#mark-…` fragment set from the new highlight keeps the researcher's place, and it does so by
    landing them on the mark. A `marks` revision that changes for any *other* reason — a highlight
    recoloured or deleted elsewhere — reloads a long article to the top, which is the failure
    `[UX07]` exists for. Predates this range (`c331185`), but `H11` is what made it load-bearing,
    and the new test (`webpage.spec.ts:330-360`) checks only that the reader element was not
    remounted, which this mechanism satisfies.

---

## Followed, and it holds

- **Nothing reaches the disk through Typst.** Driven against the real compiler with the app's own
  virtual root: `#read("/etc/passwd")` → *file not found (searched at /wiki-reader/typst/etc/passwd)*,
  `#read("../../../../etc/passwd")` → *access denied … cannot read file outside of project root*,
  and the same for `#image`, `#include` and `#import` of an absolute path. The renderer sends
  source, never a path; pictures are mounted by internal file id through `resolveFileRequest`
  (`main/typst.ts:261-283`), which is `rrfile://`'s own allow-list. `S06`'s test asserts the
  written source is `#image("/img/dfl_…")` and contains no directory (`notebook-typst.spec.ts:230-231`).
- **The verifier was strengthened, not weakened**: `@myriaddreamin/typst-ts-node-compiler` added
  to `FORBIDDEN_RENDERER_IMPORTS` (`scripts/verify_completion.py:255-263`), and eleven tags added.
  Nothing was removed.
- **The compiled tree is a tree, never a string.** `TypstNode` over IPC, allow-listed tags and
  attributes in main (`typst.ts:67-87`), `src` refused unless `data:image/`, `style` deliberately
  absent, and `renderTypstTree` builds React elements with no `dangerouslySetInnerHTML`
  (`typst-view.tsx:36-73`). Unknown elements are unwrapped rather than dropped, so no sentence is
  lost to a future Typst wrapper. Verified against the real HAST: `class` arrives as a plain
  string here (not hast's `className` array), so the allow-list does match.
- **Escaping holds for everything except `~`** (finding 3): `<ref>`, `@cite`, `a#b`, `$x$`,
  `*bold*`, `_under_`, backticks, `[box]`, line-leading `-`/`+`/`/`/`=`, a trailing backslash and
  a hostile excerpt containing `#link("http://evil.example")` all compile and render as their own
  text.
- **The migration is lossless where it matters.** Migration 016 adds two columns with defaults and
  rewrites nothing (`016_notebook_typst.ts`); only `QuestionsRepository.create` says `typst`
  (`questions.ts:76-96`); every write path — drops, sends, the excerpt picker, the picture picker,
  the template, `appendNotebookBlocks` — branches on `readBodyFormat`, and the block editor, the
  outline and the heading offset all take the page's language as a parameter. The decision is
  written down (`state/DECISIONS.md`, three "Frozen" paragraphs) as `MILESTONE8.md:11-12` demands.
  `INTERNAL_LINK_RE`'s widening to scheme+id (`notebook-body.ts:24`) is right, and the duplicate
  it would otherwise have written is called out in its own comment.
- **`U13` is a real test, not a vacuous one.** It fills the strip, drives three window sizes
  through a main-process resize that waits for the renderer *and* for Dockview's relayout
  (`support/app.ts:104-144`), asserts the active tab is inside its strip on both edges, and then
  asserts non-vacuity twice — `everOverflowed` and `everCutStatus` (`tabs.spec.ts:583-590`). The
  status-bar half is measured against the bar's own box rather than the window's.
- **`U14`/`U15`/`U04` prove what they now claim.** `togglePanel` (`host.ts:576-604`) is one
  gesture with a reveal in the middle; no `shell.minimize` control survives anywhere in the tree
  (grep is empty); `.wr-sidebar` and `bottom-panel` are asserted absent
  (`activity-bar.spec.ts:120-121`); `U04`'s re-anchored assertion would fail if a launcher opened
  a split beside the reader, which is the property that remains once the columns are gone.
- **`S08`'s placement rule is genuinely tested**, including the "else at the end" half on a page
  nobody has written in (`notebook-typst.spec.ts:389-395`), and `insertHere` vs `insertAfter` is
  the right split between a chord and a right-click (`host.ts:958-961`).
- **`S09` is one command over one builder**: the drag runs `sendToNotebook`
  (`panels.tsx:264-272`), the same path `E01`'s send takes, and the test asserts the edge, the
  blockquote and the `annotation://` chip on the page that was already open
  (`linking.spec.ts:520-535`).
- **The guide is covered.** Two new commands and three new panel controls are declared and
  chaptered; `guide.test.ts` and `guide-controls.test.ts` pass, and they are two-way, so a missing
  one would fail the build. The four new chords (`Cmd+Alt+T/O/I/E`) collide with nothing in the
  existing `make` family.

## Suite cost

No regression. The ledger's own gate line for this range records **143 E2E tests in 1.1 m**
against milestone 7's 129 in ≈64 s — 14 more tests for ≈2 s more wall clock, at the same four
workers. Sampled here: the five new Typst specs run in 15.9 s total (0.9–1.5 s each, two of them
with two launches), and the eleven shell specs in 15.9 s (0.8–1.9 s each), so the new work sits
on the suite's median rather than above it. Timeout hygiene holds on the new specs: no fixed
sleeps anywhere in the range, every wait is an `expect`/`poll`, and the only long ceilings are the
established `toPass({ timeout: 30_000 })` retry loops around "press the button if the surface is
not up yet" and two 10 s polls in `U13` where a `ResizeObserver` relayout is genuinely being
waited for. `resizeWindow` returns early rather than waiting out a size the window's `minWidth`
will not grant (`support/app.ts:129`) — the one place this could have cost ten seconds a call.
The pre-existing 60 s wait for a rendered PDF page (`linking.spec.ts:94`) equals the whole
per-test budget and remains the suite's one uncapped-in-practice assertion; it is unchanged by
this milestone.
