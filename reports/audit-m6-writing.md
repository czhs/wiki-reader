# Audit — milestone 6, the writing lens

Range `b824ec5..HEAD` (30 commits, `4b0fd0a` at HEAD). Lens: the paper-grade notebook, LaTeX
rendering, excerpt inserts, discard vs delete. Read: `docs/MILESTONE6.md`, the researcher's
`Descision:` lines as they stood at `b824ec5:reports/DESIGN_GAPS.md`, `state/NEXT_ACTION.md`,
`CLAUDE.md`. Ran `vitest` on `tests/integration/markdown-math.test.ts`,
`packages/document-model/src/excerpt.test.ts`, `packages/document-model/src/notebook.test.ts`,
`apps/desktop/src/renderer/block-source.test.ts` (37 passed) plus a throwaway probe, since
deleted. E2E was not run.

`scripts/verify_completion.py` gained one row (`R01`) and is otherwise untouched — not
weakened. `S01`–`S03` and `I01` are armed with titles that match the criteria.

Findings are ordered by severity. Everything below carries a file and a line.

---

## Major

### 1. LaTeX rendering silently broke highlighting on markdown documents that contain math

`S02` put `$…$` and `$$…$$` into the **shared** corpus renderer
(`packages/markdown-reader/src/render.tsx:79`, `:523`–`:547`). That renderer is also the
markdown reader's (`packages/markdown-reader/src/MarkdownReaderView.tsx:234`). Nothing taught
the *text projection* about the change: `projectText`
(`packages/document-model/src/markdown.ts:205`–`:215`) still emits the literal `$t$` into the
document text, and its own docstring says why that matters — "Wikilink syntax is flattened to
its display text so a search for the alias matches what the reader sees". Wikilinks were
flattened on both sides. Math was flattened on one.

Two consequences, both invisible to the suite:

**a. A sentence containing a formula can no longer be highlighted.**
`captureSelection` measures against the projection, not the DOM — deliberately
(`MarkdownReaderView.tsx:118`–`:125`):

```ts
const text = selection === null ? '' : normalizeText(selection.toString());
...
const start = documentText.indexOf(text);
if (start === -1) { onSelection(null); return; }
```

The visible text of a rendered formula is MathML glyphs (`R=e−t/S`, U+2212 for the minus, no
`$`); `documentText` holds `$R = e^{-t/S}$`. `indexOf` returns `-1`, `onSelection(null)` fires,
and `panels.tsx:623` gates the whole `SelectionBar` on `selection !== null` — so the Highlight
button never appears. Not an error, not a message: the gesture does nothing.

**b. An existing highlight over such a sentence no longer paints.**
`textAtoms` gives a math atom the value `tex` — without its delimiters (`render.tsx:540`,
`:544`). `foldBlock` (`:340`) concatenates atom values, so the folded block reads
`Recall improves when t grows.` while the anchor's quote, which came from `documentText`,
reads `Recall improves when $t$ grows.`. `paintRanges` (`:381`) is an `indexOf`; it misses.

Measured, with the document's own normalized text used as the quote:

```
DOCUMENT TEXT: "Recall improves when $t$ grows."
MARKS with real anchor quote: 0
DOM textContent: "Recall improves when tt grows."
```

**Why no test caught it.** `tests/integration/markdown-math.test.ts:108`–`:121` —
*"paints a highlight around a formula rather than through it"* — passes a quote of
`'Recall improves when t grows.'`, i.e. the `$` already stripped. No anchor this application
can mint has that shape; `createMarkdownAnchor` records `normalizeText` of the projection. The
test asserts the one input for which the code works.

This is a regression against `M02`/`M03`/`H02`, not a milestone-6 criterion, which is exactly
why it slipped: the milestone-6 specs only ever exercise the renderer on a notebook page, where
no anchoring happens.

The fix belongs in `projectText`, beside the wikilink flattening it already does — one
authority for "what the reader sees", not two.

### 2. `questions.delete` — the milestone's only irreversible act — has no test that can fail

`packages/database/src/repositories/questions.ts:225`–`:264` is hand-written polymorphic SQL
over a table with no foreign keys (`links`), it runs in one transaction with a cascade, and it
has **no unit or integration test at all**. Its only caller is `apps/desktop/src/main/handlers.ts:935`;
the only exercise is one E2E path.

That path's after-state assertions cannot fail for two of the four things they claim to check.
`tests/e2e/notebook-lifecycle.spec.ts:53`–`:69`:

```sql
OR (source_type = 'hypothesis'
    AND source_id IN (SELECT id FROM hypotheses WHERE question_id = @id))
OR (target_type = 'hypothesis'
    AND target_id IN (SELECT id FROM hypotheses WHERE question_id = @id))
```

`hypotheses` cascades from `questions` (`packages/database/src/migrations/007_notebooks.ts:40`),
so by the time `remains()` runs at `notebook-lifecycle.spec.ts:291` that subquery is empty. An
orphaned `annotation-supports-hypothesis` edge counts **0** whether or not `delete` removed it.
The spec's own docstring (`:12`–`:15`) promises "every edge those or the notebook were an end
of"; the assertion for the hypothesis half is vacuous.

Same shape at `:64`–`:69`:

```sql
FROM card_positions p JOIN links l ON l.id = p.link_id
 WHERE l.source_type = 'question' AND l.source_id = @id
```

`card_positions` is counted *through* `links`. Once the link row is gone the join is empty, so
a surviving position row — the thing the comment at `:289`–`:291` says is the point — counts 0.

A third, smaller gap: the test's predicate omits the `target_type = 'journal'` branch that the
repository's `ownedEdges` has (`questions.ts:244`), so a journal-as-target edge left behind is
also invisible. The repository docstring warns about exactly this — *"two spellings of 'what
belongs to this notebook' is how a count comes to disagree with what actually went"*
(`questions.ts:235`–`:237`) — and the test wrote the second spelling anyway.

The implementation looks correct on inspection (order is `DELETE FROM links` then
`DELETE FROM questions`, so the hypothesis subqueries still resolve; `foreign_keys = ON` at
`packages/database/src/connection.ts:25`). The finding is that nothing proves it and nothing
would notice if it stopped being true.

Remedy: a repository test that captures the link ids and position rows *before* the delete and
asserts on those ids afterwards, plus the library-untouched property. That is the one property
`questions.ts:222` says is "worth testing twice" and it is currently tested once, in an E2E.

---

## Minor

### 3. An inserted excerpt is not persisted; its edge is

`apps/desktop/src/renderer/notebook-panel.tsx:248`–`:268` writes the durable half first
(`question:attach`) and then calls `editor.current?.insert(excerpt.markdown)`. `insert`
(`apps/desktop/src/renderer/blocks.tsx:263`–`:268`) only calls `setRows`/`setEditing`; the
document is written by `commit`, which runs from `onBlur` (`blocks.tsx:335`). Removing a
focused element from the DOM fires no blur, so closing the notebook tab (or any unmount) while
the freshly inserted excerpt is still open loses the quote and keeps the card. The comment at
`:260`–`:262` acknowledges the asymmetry for the *error* case but the same asymmetry exists on
the happy path.

For contrast, the other insert gesture on this surface — a dropped picture — is written by main
before the renderer hears about it (`apps/desktop/src/main/handlers.ts:183`–`:208`). Two
inserts on one page, opposite durability.

`tests/e2e/notebook-page.spec.ts:252` calls `editing.blur()` immediately, so the spec only ever
sees the durable path.

### 4. A `[[wikilink]]` on a notebook page always says "not written yet", and does nothing

`blocks.tsx:130` renders every text block with `renderMarkdown(block.src, { internalLinks })`
and **no** `wikilinks` renderer. `renderWikilink` therefore takes
`context.wikilinks?.resolve(slug) ?? null` → `null` for every target (`render.tsx:266`) and
draws the chip as `wr-wikilink--wanted` with `title={`${target} — not written yet`}`
(`render.tsx:282`–`:286`), even when the page exists; the click handler at `:287` is a no-op.

The researcher's decision line on gap 3 names the parts a paper needs: *"that is Latex,
linking, codeblocks, md, images"*. LaTeX, code, markdown and images all landed. Wikilink
linking on the page renders as a control that lies about the library it is sitting in. (It was
the same on a journal day before this milestone; what changed is that this surface is now the
one the milestone is named after.)

### 5. `[S03]`'s closing assertion is weaker than the sentence above it, and its fixture cannot
support the stronger one

`tests/e2e/notebook-page.spec.ts:220` takes `workspace.documents[0]` — every library item,
ordered `updated_at DESC, id DESC` (`packages/database/src/repositories/documents.ts:229`),
which includes the fixture's saved web page and is not guaranteed to be a PDF. `seedHighlight`
then attaches an unconditionally **pdf** anchor to it
(`tests/e2e/support/librarian.ts:127`–`:136`). `workspace.pdfDocuments[0]` is the accessor that
would make the two agree (`tests/e2e/support/workspace.ts:448`).

The comment at `:264`–`:265` and `:277` claims "The source, open on the highlight — which is
the whole of 'keeps its link to it'". What is asserted (`:278`–`:285`) is a tab bearing the
title and `document.querySelectorAll('[data-testid^="reader-"]').length > 0` — any reader
panel, anywhere in the window. Nothing checks that the marked sentence was revealed or
selected. With a pdf anchor on a possibly-non-PDF document, it could not.

### 6. The delete report double-counts, and drops the one thing the confirmation promised

`apps/desktop/src/renderer/queue-panel.tsx:243`–`:248` prints days, cards and links.
`removed.links` (`questions.ts:255`) counts every owned edge *including* the cards counted at
`questions.ts:250`–`:254`, so the seeded case reads "1 card, 2 links" for two rows one of which
is the card. Meanwhile `removed.hypotheses` is computed (`questions.ts:249`), carried on the
channel (`packages/shared-types/src/ipc.ts:543`) and never shown — although the confirmation
the researcher just read says "Its journal, its claims and its desk go with it"
(`queue-panel.tsx:454`–`:457`). The one number that reports on "its claims" is the one dropped.

### 7. A journal page open on a deleted notebook never hears about it

`question:delete` publishes `notebook:changed` with `reason: 'deleted'`
(`handlers.ts:938`). Two surfaces subscribe: `notebook-panel.tsx:198` (handles `'deleted'`
explicitly) and `notebook-directory.tsx:140`. `journal-panel.tsx:168` subscribes to
`journal:changed` only, so a journal page stays on screen, still editable, after its notebook
is gone. The first commit fails at `handlers.ts:1079` with a `notFound` into the status bar and
the typed day is lost. The guard is right; the page is not told.

### 8. The excerpt chip has no broken state

`renderInternalLink` (`render.tsx:229`–`:256`) always draws an enabled button titled "Go to the
source"; it is disabled only when the *view* supplied no `internalLinks` renderer. If the
highlight has been deleted, or its document removed from the library, the click resolves
`annotation:get`, fails, and reports into the status bar. The app already owns the vocabulary
for this — `ResolvedLink.broken` renders `"${otherTitle} (missing)"` and disables the control
(`notebook-panel.tsx:85`–`:103`), on the very same page. An excerpt is the one citation in the
app that does not get that treatment.

(The quote itself survives both, correctly: it is markdown in `questions.body`, and
`library:removeDocument` keeps annotations and links — `handlers.ts:604`–`:622`.)

### 9. Caret placement inside a block containing math lands at the end of the block

`blocks.tsx:92` reads `element.textContent` as "the rendered text" and hands it to
`sourceOffsetFor` (`block-source.ts:179`–`:202`), which walks the rendered string as a
subsequence of the source. `math.tsx:33`–`:36` keeps `annotation` in `ALLOWED_TAGS`, so KaTeX's
`<annotation encoding="application/x-tex">` is in the tree; it is `display:none` in MathML Core,
but `textContent` ignores CSS. Measured:

```
BLOCK textContent: "Retention decays as R=e−t/SR = e^{-t/S} over time."
```

Those extra characters are not in the source, so `skipTo` runs the cursor to `src.length` and
every subsequent click in that block puts the caret at the end — the failure `P05` exists to
prevent, reintroduced for any block with a formula in it. The comment at `math.tsx:30`–`:32`
gives a real reason to keep the annotation (copy-paste, screen readers); the fix belongs on the
reading side — measure the visible text rather than `textContent`.

---

## Checked and sound

- **Discard vs delete is genuinely two acts.** The precondition is in the main process
  (`handlers.ts:928`–`:934`), not only in the panel; `notebook-lifecycle.spec.ts:234`–`:249`
  drives the bridge directly to prove it, which is the right shape of test. No context menu
  offers either (`packages/workbench/src/menus.ts:147`–`:153`), and the file says why at `:24`.
- **Deletion really is a hard delete, and really does spare the library.** Cascades exist for
  `journal_entries`, `hypotheses`, `question_tags` and `card_positions`
  (`migrations/007_notebooks.ts:31,40`, `012_notebook_journals.ts:48`, `008_desk_board.ts:29`),
  `foreign_keys = ON` (`connection.ts:25`), and `delete` orders the link removal before the row
  removal so the hypothesis subqueries still resolve (`questions.ts:258`–`:261`). Nothing
  notebook-shaped is in the FTS index (`packages/search/src/indexer.ts` indexes documents,
  chunks, annotations and notes only), so there is no stale search residue.
- **An excerpt is markdown and stays one block.** `excerptMarkdown`
  (`packages/document-model/src/excerpt.ts:44`–`:56`) never emits a blank line, which is what
  `parseBlocks` splits on (`block-source.ts:48`); `excerpt.test.ts:26`–`:35` asserts exactly
  that, including the escaping and the no-valid-id fallback.
- **KaTeX is a real bundled dependency, MathML only.** `katex@0.18.1` in
  `packages/markdown-reader/package.json`, resolved in `pnpm-lock.yaml`, recorded in
  `THIRD_PARTY_NOTICES.md:65`. No HTML string reaches the page: `math.tsx:181`–`:193` parses
  and rebuilds against an allowlist. No stylesheet, no fonts, no `font-src` surface.
- **`question:attach` is idempotent**, so quoting the same highlight twice does not grow a
  second card (`packages/database/src/repositories/links.ts:88`–`:96`, and the
  `UNIQUE (type, source, target)` index at `migrations/001_initial.ts:164`).
- **`mergeAppend` is properly covered** — the milestone-5 picture-drop bug now has five cases in
  `apps/desktop/src/renderer/block-source.test.ts`.
- **The verifier is armed and unweakened**: `S01`–`S03`, `I01` present with matching titles
  (`scripts/verify_completion.py:167`–`:178`); the only change in range adds `R01`.
