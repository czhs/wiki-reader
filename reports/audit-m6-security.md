# Milestone-6 audit — the security lens

The lens that failed to run during the audit, run afterwards. Range `b824ec5..HEAD`
(`b54f510`), which is **wider than the other two reports' range**: they read
`b824ec5..4b0fd0a`, so the seven fixes made after their findings (`da4faa8`, `79d9a6a`) are
inside mine and were read as part of the milestone rather than as a patch on it.

Subject: the IPC surface milestone 6 added (`question:delete` — the milestone's one
irreversible act — `hypothesis:list`, the widened reach of `question:attach`, the zoom lever's
persisted schema, the `wr:drop` notebook-page target), zod coverage on every new channel,
`rrfile://` and its roots, the **vendored KaTeX path** (LaTeX arrives from documents and is
hostile input), the excerpt / `annotation://` link path, the context-menu machinery and how it
composes with the archive frame's selection transport, and the guide's inline SVG and
keyframes. Plus a regression pass over every line of `CLAUDE.md`'s security section.

Method: read the diff and the code around it; ran `markdown-math`, `menus`, `excerpt`,
`internal-links` and `guide-controls` under vitest (47 passed, node 20.19.3); drove KaTeX
directly from node for the adversarial TeX table below; and ran two throwaway probes inside
the tree — one rendering hostile formulas and a hostile excerpt through the real
`renderMarkdown`, one timing `parseMarkdown` — both since deleted, tree verified clean. The
E2E suite was not run. No file in the tree was modified.

What is right, so the findings are read in proportion. The two structural invariants held
without qualification: **exactly two `ipcMain.handle` calls, both in `router.ts`**
(`:208`, `:216`), and **exactly two functions on the bridge** (`preload/index.ts:57-71`,
`:78`) — the milestone added a fourth drop-target attribute and did not add a third bridge
method. Every new channel is in `IPC_CHANNELS` and therefore validated before dispatch
(`router.ts:150-158`) and re-validated on the way out outside production (`:170-180`).
`protocol.ts` is byte-identical to `b824ec5`, so the `rrfile://` roots, the snapshot
containment rule and `snapshotSecurityHeaders` are untouched. `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, `webviewTag: false` are unchanged
(`main/index.ts:216-221`); `sandbox=""` on the archive frame is unchanged
(`HtmlReaderView.tsx`, in the diff, with its comment intact); the renderer CSP is
character-for-character the same in the tree *and* in the shipped bundle. `question:delete`
enforces its precondition in the main process, not the panel, and no command id exists for it,
so no menu and no chord can reach it. And `math.tsx` is genuinely the right shape: MathML
rather than HTML+CSS, `trust: false`, and React elements rebuilt against an allowlist rather
than `dangerouslySetInnerHTML`. The findings below are about what is not held up by anything.

---

## Major

### S1. The allowlist between hostile TeX and a privileged origin has no test that can fail

`packages/markdown-reader/src/math.tsx` is the milestone's one new parser of untrusted input,
and it is placed in the app's own origin. Its docstring states the security argument plainly
(`:11-18`):

> **No HTML string reaches the page.** … the string KaTeX generates is parsed with `DOMParser`
> and rebuilt as React elements against an allowlist of MathML tags and attributes. An
> `\href` or an `\htmlData` that got through KaTeX's own `trust: false` would still not survive
> this pass … The alternative — `dangerouslySetInnerHTML` with a comment explaining why it is
> safe — puts the app one KaTeX regression away from injection into a privileged origin.

The mechanism is two lines: `if (!ALLOWED_TAGS.has(tag)) return null;` (`:119`) and
`if (!ALLOWED_ATTRIBUTES.has(name)) continue;` (`:124`), over the sets at `:33` and `:71`.

**Nothing tests either of them.** `grep` over `tests/` and `packages/` for `ALLOWED_TAGS`,
`ALLOWED_ATTRIBUTES`, `htmlId`, `htmlData`, `\href`, `trust:` finds only `math.tsx` itself.
The whole of the math coverage is `tests/integration/markdown-math.test.ts:59-119`, and its
assertions are:

```ts
expect(math?.getAttribute('data-display')).toBe('inline');
expect(math?.querySelector('math')).not.toBeNull();
expect(math?.querySelectorAll('mi').length).toBeGreaterThan(0);
expect(math?.querySelector('math')?.getAttribute('display')).toBe('block');
```

Every one of those is satisfied by the implementation the docstring rejects. Replace the body
of `renderMath` (`:193-203`) with

```tsx
<span className={…} data-testid="markdown-math" data-display={…} data-tex={tex}
      dangerouslySetInnerHTML={{ __html: html }} />
```

and the DOM still contains a `<math>` with `<mi>` children and the right `display`, so all
fifteen tests in that file still pass — and so does every other test in the tree, because
`math.tsx` has no other caller. The comment at `:14-18` names that exact regression as the
thing to be prevented, and there is no instrument that would notice it.

Nor is the allowlist's *content* pinned. Adding `'href'`, `'style'` or `'id'` to
`ALLOWED_ATTRIBUTES` — the three the comment at `:68-70` says are deliberately absent, one of
them because "an id would let a formula collide with the app's own anchors" — changes nothing
any test observes.

This is the same shape as the writing lens's finding 4 (`questions.delete`, closed): the
implementation is correct on inspection — I confirmed by probe that `\href`,
`\includegraphics`, `\htmlClass`, `\htmlId`, `\htmlData` and `\htmlStyle` all reach the page as
an inert `<mtext>\href</mtext>` and that `mathcolor`/`mathbackground` are stripped — and
nothing proves it or would notice if it stopped being true. That the property currently holds
is not the finding; that it is unguarded is.

Remedy, in the file that already has the fixture: a case per refusal — a disallowed tag
dropped with its subtree, a disallowed attribute dropped from an allowed tag, `\href` and
`\htmlId` producing no `a`/`href`/`id` anywhere under `[data-testid="markdown-math"]`, and one
that asserts `renderMath`'s output is React elements (`renderMarkdown` returns a `ReactNode`
tree; a string would show up as a text node) rather than believing the comment.

---

## Minor

### s1. A formula may lay out a 1.6-million-pixel box, because `maxSize` is left at its default

`renderMath` calls KaTeX with four options (`math.tsx:175-181`): `displayMode`, `output`,
`throwOnError: false`, `trust: false`, `strict: 'ignore'`. It does **not** set `maxSize`, which
is the option KaTeX documents for exactly this case, and whose default is `Infinity`. The
allowlist then admits every MathML length attribute — `width` (`:103`), `height` (`:84`),
`depth` (`:78`), `voffset` (`:102`), `lspace`/`rspace` (`:87`, `:96`), `minsize`/`maxsize`
(`:90`, `:89`) — on `mspace` (`:43`) and `mpadded` (`:59`), which are the tags `\rule`,
`\kern`, `\hspace` and `\raisebox` compile to.

Rendered through the real `renderMarkdown` in jsdom, `A $\rule{99999em}{99999em}$ B` produces:

```html
<span class="wr-math" data-testid="markdown-math" data-display="inline"
      data-tex="\rule{99999em}{99999em}">
  <math><semantics><mrow><mpadded height="0em" voffset="0em">
    <mspace width="99999em" height="99999em"></mspace>
  </mpadded></mrow><annotation …>\rule{99999em}{99999em}</annotation></semantics></math>
</span>
```

`x\hspace{50000em}y` gives `<mspace width="50000em">` the same way. With `maxSize: 10` KaTeX
emits `width="10em" height="10em"` instead — the guard exists and is simply not asked for.

At the app's 16px root that is ~1.6 million CSS pixels of layout box inside a reader panel. I
did not confirm the visual outcome in Chromium (no E2E run), so what is measured here is the
attribute reaching the DOM, not the frame time; MathML Core in Chromium 130 does honour
`mspace/@width`.

Reachable from ordinary content: any markdown file in the corpus or the notes folder, and —
because the quote is inserted verbatim, see `s2` — from a highlight taken out of any document
and sent to a notebook page. Milestone 6 is the milestone that put this renderer on the page
the researcher writes their paper on.

### s2. `excerptMarkdown` escapes the title and leaves the quote unescaped

`packages/document-model/src/excerpt.ts` treats its two inputs differently, and the asymmetry
runs the wrong way round. The `sourceTitle` — which is library metadata — is escaped with a
comment explaining why (`:26-35`):

```ts
return collapsed.replace(/([[\]\\])/gu, '\\$1');
```

The `selectedText` — which is *document-controlled text*, the one input that came from a PDF
or from markup off the open web — is put into the blockquote with no escaping at all
(`:19-24`, `:51`), and a blockquote's contents are markdown.

Probe, `excerptMarkdown` into the real `renderMarkdown` with an `internalLinks` renderer, i.e.
what a notebook page does (`blocks.tsx:130`, `:198-222`). Highlight text:

```
Spaced repetition improves recall.
— [Ebbinghaus 1885](annotation://ann_…se) and $\rule{99999em}{1em}$ and [a link](https://evil.example/x)
```

renders inside the quote as:

```html
<blockquote><p>Spaced repetition improves recall.
— <button class="wr-internal-link" data-scheme="annotation"
          data-target="ann_…se" title="Go to the source">Ebbinghaus 1885</button>
  and <span class="wr-math" …><math>…<mspace width="99999em" height="1em">…</span>
  and <a href="https://evil.example/x">a link</a></p>
<p>— <button class="wr-internal-link" data-target="ann_…sd">Some [Paper]</button></p></blockquote>
```

Two attribution chips: the forged one, which navigates to a different annotation, above the
real one. The escaped title is visible in the same output doing its job — `Some [Paper]`
renders as a label rather than as a link.

Bounded, and I followed each edge to the wall: `safeHref` (`render.tsx:582-586`) refuses
`javascript:` and `data:`; the external `<a>` is inert because `will-navigate` refuses every
URL that is not the app's own origin (`main/index.ts:103-108`) and `setWindowOpenHandler`
denies (`:99`); `img-src 'self' data: blob: rrfile:` refuses a remote tracking pixel; raw HTML
in the quote renders as text (`render.tsx:200-207`), which I confirmed — `$\text{<script>…}$`
came out as two `markdown-raw-html` code chips and was not even parsed as maths. So nothing
executes and nothing leaves the machine. What is left is that the app's one feature whose
criterion is *"keeps its link to the source"* (`S03`) lets the source dictate what the
provenance line says, and that `> ` prefixing is being relied on as an escaping mechanism it
is not.

Remedy is one line beside the one that is already there: escape the quote's markdown
punctuation the way `linkText` escapes the title's, or state in the docstring that a quote is
deliberately live markdown so the next reader knows it is a decision.

### s3. The shared inline-construct pattern is quadratic, and it runs in the process that owns the database

`INLINE_CONSTRUCT_RE` (`packages/document-model/src/markdown.ts:122-123`) is milestone 6's
best structural idea — one alternation, so `projectText` and `renderMarkdown` cannot disagree
about what a construct counts as — and it is now the single authority in **both** processes:
`renderMarkdown` builds its atoms from it (`render.tsx:85`, `:532-535`) and `flattenInline`
flattens with it (`markdown.ts:309-320`), which `blockToText` (`:283-294`) calls for every
block of every markdown file `corpus.ts:271` parses on import.

Its wikilink branch backtracks quadratically, because `[^\]\n|#]+` admits `[`:

| `[` characters | `parseMarkdown` |
|---|---|
| 8,000 | 385 ms |
| 16,000 | 1,426 ms |
| 32,000 | 5,579 ms |
| 64,000 | **22,191 ms** |

better-sqlite3 is synchronous and this is the process that owns the database, so a 64 KB
`.md` file of one repeated character is 22 seconds during which nothing else in the
application answers. The maths branches are linear (128,000 `$` characters: 1 ms) — they
cannot backtrack, because `[^$]` and `[^$\n]` exclude the delimiter they must stop at.

**Not a milestone-6 regression, and said so plainly**: the identical branch was `WIKILINK_RE`
at `b824ec5` and times identically (8,000 → 172 ms, 32,000 → 2,747 ms for the bare regex,
against 171 ms / 2,748 ms for the new one), and it already ran on this path. It is here
because milestone 6 promoted this expression to *the* shared authority for both processes and
gave it a docstring that says so, which is the moment its properties become everybody's
problem rather than the wikilink renderer's. An anchored possessive form, or a `[^\]\n|#[]+`
that also excludes `[`, removes it without changing what matches.

---

## Things checked and found sound

Traces I followed to the end, so their absence from the list above is a result rather than an
omission.

- **Every new channel is zod-validated in the one router.** The channel table gained exactly
  two names against `b824ec5` — `question:delete` (`ipc.ts:537`) and `hypothesis:list`
  (`:644`) — both with request and response schemas, both dispatched through
  `router.ts:150-164`. `notebook:changed` widened its `reason` enum (`ipc.ts:1188-1197`) and
  is validated on publish (`router.ts:239-244`). `link:findForDocument`'s response grew an
  array with its own schema (`ipc.ts:790-793`, `domain.ts:418-435`).
- **`question:delete` cannot be turned into `question:discard` by any caller.** The
  `status !== 'discarded'` refusal is in the handler (`handlers.ts:986-1000`), not the panel;
  `[I01] refuses a notebook that has not been discarded, and takes nothing`
  (`tests/integration/notebook.test.ts:830-842`) drives the bridge to prove it. No `COMMAND_IDS`
  entry exists for deleting, so `menus.ts` structurally cannot offer it — the exact-equality
  assertion at `menus.test.ts:145-152` pins the notebook menu to three navigation commands.
  The repository's `ownedEdges` predicate (`questions.ts:230-236`) matches journal endpoints by
  `substr(id, 1, len) = @prefix` where the prefix is `<questionId>:`
  (`JOURNAL_ENTITY_SEPARATOR` is `':'`, `domain.ts:296`); question ids are fixed-length ULIDs
  and `:` cannot occur in one, so no other notebook's edges can be caught by the prefix. I
  checked every foreign key into `questions` — `question_tags`, `hypotheses`
  (`007_notebooks.ts:31`, `:40`) and `journal_entries` (`012_notebook_journals.ts:48`), all
  `ON DELETE CASCADE` — and confirmed the agent tables hold **no** reference to a question
  (`006_agents.ts:38-56`), so the delete cannot fail on a constraint and leaves no proposal
  pointing at a notebook that is gone.
- **The preload still exposes two functions.** `contextBridge.exposeInMainWorld('rr', bridge)`
  with `invoke` and `subscribe` (`preload/index.ts:57-78`). The new
  `data-wr-drop-notebook-page` attribute is read inside the preload's own world
  (`:110-111`), and the path it accompanies still comes from `webUtils.getPathForFile`
  (`:156`) and still goes out on `wr:drop`, which the bridge cannot address. The renderer
  chooses *which notebook*, never *which file*, which is the property that matters.
- **No filesystem path reaches the renderer on any new path.** `receivePagePictures`
  (`handlers.ts:220-244`) resolves the file in main and writes `![title](rrfile://<file id>)`
  into `questions.body` (`picturesAsBlocks`, `:154-179`); the renderer receives the markdown
  and builds the URL from an id. `rrfile://` still resolves that id through the database and
  through `resolveAllowedPath` twice (`protocol.ts:249`, `:270`), unchanged.
- **The archive frame and the reader's menu compose rather than collide.** `ReaderFrame`'s
  `onContextMenu` (`panels.tsx:198-200`) is on the panel `div` that wraps the iframe; a
  right-click inside a nested browsing context does not cross into this document, so it never
  fires there. Main's listener (`main/index.ts:111-113`) fires for *every* gesture in the
  webContents, including ones in the renderer's own document — and
  `reportSnapshotSelection` (`:135-145`) discards those, because `parseFileId` returns null
  for anything that is not `rrfile://<file id>` with an empty resource path
  (`protocol.ts:214-218`). The panel then discards any payload for another document
  (`panels.tsx:750-755`). The highlight rows inside the panel call `openMenu`, which
  `stopPropagation`s (`context-menu.tsx:68`), so a right-click on one does not also raise the
  file's menu. Nothing about the zoom lever changes this: it wrapped the iframe in a
  `__viewport` sibling and left `sandbox=""` and `referrerPolicy="no-referrer"` alone.
- **A context menu cannot reach past a guard, and cannot invent an argument.**
  `buildContextMenu` (`menus.ts:224-251`) can only *drop* entries — it reads title, category
  and chord out of the registries and never writes one, and `CONTEXT_MENUS` holds ids only.
  `ContextMenu` executes `run(item.commandId, item.args)` (`context-menu.tsx:206`) with the
  args the surface supplied, and every command that acts on an entity re-validates through a
  branded schema before it calls a channel (`host.ts:626-664` for `sendToNotebook`,
  `blocks.tsx:198-222` for an `annotation://` chip). No command in `COMMAND_IDS` takes a path
  or a URL.
- **The excerpt chip's target is validated twice.** `parseInternalLink`
  (`internal-links.ts:51-83`) is total, refuses any scheme outside the three, and parses the
  id through `DocumentIdSchema`/`AnnotationIdSchema`/`NoteIdSchema`; the fragment is
  `decodeURIComponent` → `JSON.parse` → `DocumentLocationSchema`, each in its own try/catch.
  The chip is a `<button>`, not an `<a>` (`render.tsx:229-262`), and the corpus markdown
  reader supplies **no** `internalLinks` renderer (`MarkdownReaderView.tsx:238`), so an
  `annotation://` link in an imported file renders `disabled` — a hostile file cannot offer a
  live navigation control at all.
- **KaTeX is a real, vendored, bundled dependency.** `katex@0.18.1` in
  `packages/markdown-reader/package.json:24`, integrity-pinned in `pnpm-lock.yaml:2756-2758`,
  MIT, `repository: https://github.com/KaTeX/KaTeX.git`, one dependency (`commander`, used
  only by its CLI). It is inside the shipped renderer chunk
  (`release/mac-arm64/…/out/renderer/assets/index-1GYAzsbi.js`) — I grepped every absolute URL
  in that bundle and the only hits are licence text, documentation links in comments and XML
  namespaces. No stylesheet, no fonts, no `font-src` surface, nothing fetched.
  `DOMParser().parseFromString(html, 'text/html')` (`math.tsx:189`) builds a document with no
  browsing context, so it neither runs script nor loads a subresource.
- **The guide fetches nothing and injects nothing.** `guide.css` contains no `url(`, no
  `@import` and no `http`. The fourteen drawings are inline JSX `<svg>` (`guide-panel.tsx:89`
  onward) with no `<use>`, no `<image>`, no `<foreignObject>`; the only `href` on the page is
  the in-page `#guide-<id>` at `:511`, built from static chapter ids. Every title and chord the
  page prints is read from the registries as text.
- **`normalizeText`'s refactor is behaviour-preserving.** `foldCharacters`
  (`normalize.ts:54-71`) is the five shared steps lifted verbatim, in the same order, and both
  callers apply their own tail exactly as before. `NORMALIZATION_VERSION` did not need to move,
  and every persisted anchor offset still means what it meant.
- **`question:attach`'s bare `targetId: z.string().min(1)` (`ipc.ts:562`) is the house
  convention for a polymorphic endpoint**, not a milestone-6 loosening — `link:create` and
  `hypothesis:attachEvidence` spell it the same way (`:729`, `:731`), and the schema is
  unchanged from `b824ec5`. What changed is reach: the channel is now behind six context
  menus, a chord and the excerpt picker. The handler existence-checks the target
  (`handlers.ts:1011-1018`) and every query is parameterised, so the widening is safe; the
  already-recorded gap that `annotations.get` does not filter `deleted_at` is the one hole in
  that check and is not re-argued here.
- **`notebooksTouchedBy` (`handlers.ts:116-140`) cannot be made to publish a malformed id.**
  Each candidate goes through `QuestionIdSchema.safeParse` before it leaves, and `publish`
  validates the topic payload again (`router.ts:239-244`).
- **The verifier was not weakened.** One row added (`R01`), nothing removed
  (`scripts/verify_completion.py:177`).

## Scratch

The two probes lived at `tests/integration/zz-probe.test.ts`, were run under
`npx vitest run`, and were deleted; `git status --porcelain` is empty. The KaTeX table was
produced by driving `node_modules/.pnpm/katex@0.18.1/…/dist/katex.js` from node directly.
Regex timings are `String.prototype.replace` against the two expressions, three shapes of
input, on this machine.
