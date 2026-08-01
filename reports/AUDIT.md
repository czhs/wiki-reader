# Independent audit — milestone 6

Audited-commit: 4b0fd0a9745d8186821519ba0b9530e82c28594d
Audited-milestone: 6

Brief: falsify "milestone 6 is complete and safe". Three auditors read disjoint lenses — the
writing (`S01`–`S03`, `I01`): the paper-grade notebook, LaTeX, excerpt inserts, and whether
deletion is truly confirmed and truly gone; the surfaces (`E01`–`E03`, `V01`–`V04`, `O01`):
send-to-notebook, hypothesis evidence, the ledger, wiki snippets, graph search, the calendar, the
saved-page lever and the guide — real behaviour, real coverage assertions, and what happens with a
large library; and the security surface the milestone widened: the new IPC channels and their zod
coverage, `rrfile://` and its roots, the vendored KaTeX path (LaTeX arrives from documents and is
hostile input), the excerpt and `annotation://` link path, the context menus and how they compose
with the archive frame's selection transport, the guide's inline SVG, and a regression pass over
every line of `CLAUDE.md`'s security section. None was the context that built the code. Their full
working is in `reports/audit-m6-writing.md`, `reports/audit-m6-surfaces.md` and
`reports/audit-m6-security.md`, including the reproductions, the seeded-library timings, the
adversarial-TeX table and the traces that ended in "I followed it and it holds".

The first two lenses read `b824ec5..4b0fd0a`. The security lens crashed during that run and was
re-run afterwards against `b824ec5..b54f510`, so it read the other two's seven fixes as part of
the milestone rather than as a patch on it; the commit named above is the one all three cover.
Its findings are rows 8–11 below and were closed after the milestone's own commit, which is why
they sit at the end of the table rather than in it by severity.

Every criterion was green and the whole suite passed before the audit began, so nothing here was
found by running the tests. Each finding below was confirmed at the source, and then the fix was
confirmed by mutation: the fix was reverted, the new test was watched to fail, and the fix was
restored. The performance numbers were re-measured on this machine against the compiled
repository, three runs each, before and after, on the same fixture.

## Findings — milestone 6

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | critical | **`graph:overview` became quadratic in (documents × linked highlights).** `V01`'s new annotation branch of the `places` CTE joined the materialised, unindexed `degrees` CTE to `documents`, so SQLite drove from `documents` and walked every annotation-degree row once per file — `SCAN d` / `SEARCH g USING AUTOMATIC PARTIAL COVERING INDEX (entity_type=?)`, one column. Re-measured on the same fixture (4 citations and 20 highlights per paper, one highlight in ten linked): 400 papers 123 ms, 1,500 papers 1,957 ms, **3,000 papers 8,988 ms**. better-sqlite3 is synchronous and this runs in the process that owns the database, so that is nine seconds in which no reader loads, no search returns and no highlight saves. Not once a session either: `wiki-panel` re-runs it on every `library:changed` that is not an `annotation`, and `link:create` publishes one per link — accepting twenty librarian proposals with a wiki tab open re-ranks the library twenty times, and the link picker's "By looking" tab renders the same body. | Fixed — the branch drives from `degrees`, which on it is the small side (the highlights something links, not the library's highlights), and the paper's liveness is the same test written as a set membership SQLite answers from the primary key per surviving highlight rather than once per file. Same answer, row for row, asserted in the probe. 8,988 ms → 87 ms at 3,000 papers; 1,957 ms → 65 ms at 1,500; 123 ms → 9 ms for the ranking at 400. |
| 2 | major | **The perf guard written for exactly this query could not see the new branch.** `[F01] ranks the library without a per-row existence check over every link` seeds 400 documents, 10,000 links and **zero annotations**, so the branch finding 1 lives in never reached the clock it keeps. It also could not have caught it if it had: the pathological plan contains no `CORRELATED` and does use both link indexes, so all three of its plan assertions pass on the nine-second query, and at that fixture's size the regression is worth about 130 ms — under the 400 ms ceiling. | Fixed — the fixture now marks 8,000 sentences and links one in twenty, so the branch is in the answer (`totalNodes` is files *plus* the linked marks, and not the other 7,600) and in the clock. The plan assertion is the one that has teeth: every lookup of `degrees` must constrain `entity_id`, not just `entity_type`, and a `SCAN g` fails it the same way. Reverting the fix fails it in 1.5 s. |
| 3 | major | **LaTeX rendering silently broke highlighting on any markdown document containing maths.** `S02` put `$…$` into the shared corpus renderer — which is also the markdown reader's — and nothing taught the *projection* about it: `projectText` still emitted the literal `$t$` into the text anchors are measured against, while flattening `[[wikilinks]]` on both sides, which its own docstring explains is the point. Two consequences, both invisible to the suite because milestone-6 specs only render a formula on a notebook page, where nothing anchors. (a) `captureSelection` matches `selection.toString()` against the document text, gets −1 for any selection crossing a formula, calls `onSelection(null)`, and `SelectionBar` is gated on that — so the Highlight button never appeared at all, with no error and no message; confirmed in real Chromium, not only in jsdom. (b) `textAtoms` gives a formula the TeX without its delimiters, so a folded block can never match a quote containing `$`, and existing highlights over such sentences stopped painting: measured with the document's own normalized text as the quote, **0 marks**. A regression against `M02`/`M03`/`H02`. The milestone's own test passed because it wrote the quote by hand with the `$` stripped — a shape no anchor in this application can mint. | Fixed at the cause, in one place: the alternation that decides what an inline construct counts as is `@wr/document-model`'s and is now *shared* — `projectText` flattens with it and `renderMarkdown` builds its atoms from it, so there is one answer rather than two. `[[Page#section]]` was the same defect and went with it: the chip is labelled with the target, and the projection said "target section". The reader reads a selection that touches a formula back out of the DOM in the spelling the document uses, a formula being atomic there for the same reason it is atomic when painting. Four new tests derive the quote from the document's own projection rather than spelling it, plus an E2E over a corpus page with a formula in it that drags the sentence, presses Highlight, and reads the stored quote back off the channel. |
| 4 | major | **`questions.delete` — the milestone's one irreversible act — had no test that could fail.** Hand-written polymorphic SQL over a table with no foreign keys, run in a transaction beside a cascade, with no unit or integration cover at all; its only exercise was one E2E path whose after-state assertions could not fail for two of the four things they claimed. Both were the same mistake — a predicate that resolves *through* something the delete has already removed: `… IN (SELECT id FROM hypotheses WHERE question_id = @id)` is empty once the cascade has run, so an orphaned `annotation-supports-hypothesis` edge counted 0 either way; and `card_positions` counted through a join on `links` counts 0 as soon as the link is gone, whatever became of the position row. The spec's predicate also omitted the `target_type = 'journal'` branch the repository has — the second spelling the repository's own docstring warns about. | Fixed in the tests, which is where the fault was: the implementation was correct and is now proved. Four repository tests capture every edge and position **by id** before the act and ask about those ids after it, cover the day-as-target branch, assert the library edge and the second notebook's rows are untouched, and assert the refusal takes nothing. Three mutations were watched to fail: dropping the hypothesis branch, dropping the journal-target branch, and deleting the row before the links so the subqueries resolve empty — the ordering invariant the docstring names. The E2E spec seeds a day-as-target edge and asks about its own ids too. |
| 5 | major | **`E02`'s evidence never reached an open notebook page.** The criterion is evidence attached by hand and the milestone's stated layout is a reader beside the notebook — so the researcher marks the sentence that settles a claim, links it, and the *For* line does not move. The page subscribes to `notebook:changed`; `link:create` published only `library:changed`, and `hypothesis:attachEvidence` published nothing at all. And even with an event, `reloadBoard` re-fetched the whole page and kept only `cards`, discarding `hypotheses` — which is where `supporting`/`opposing` live. The `[E02]` spec passed because it opened the notebook *after* the link, mounting the panel for the first time: true of a cold mount, silent about the workflow. | Fixed — both link writes and `hypothesis:attachEvidence` announce to the notebook whose claim, desk or day the edge has an end on (`notebooksTouchedBy`, beside `documentsTouchedBy`, with `link` as a new `notebook:changed` reason); the reload keeps the *draft* and nothing else, which is the only thing worth keeping. The `[E02]` spec now opens the notebook first, stamps the mounted panel, and asserts the *For* line fills on the same mount. Four integration tests read what the channels published, including that two library rows tell no notebook anything. |
| 6 | major | **The guide declared Find on "Every graph surface" and the focused view had none.** The `map` chapter tells the reader to type in Find and covers `openFocusView`; `SceneFilter` was rendered by two surfaces. The focused view draws the same discs and the same viewport group, and it is the surface a dense paper's neighbourhood is crawled on — twenty-four marked sentences round one paper is the density `V02` exists for. `O01`'s machinery could not catch it: the control is declared once and drawn once, inside `graph-canvas`, so every declared-versus-drawn assertion was satisfied while the sentence the page printed was false. | Fixed — the focused view has the filter, matching the middle, the marked sentences and the files at the edge, dimming lines with nodes and panning through the module that owns every viewport. And the promise is now checkable: a control whose declared surface is "every graph surface" is enumerated against the files that draw the shared scene, so a fourth surface cannot ship without one. New E2E `[V02] the focused view dims what does not match and moves to what does`, and the source check fails the moment the filter is taken out. |
| 7 | major | **`E03`'s point is a panel, and no test drove that panel.** The gap it answers is a rendering complaint — "Link this highlight…" existed only where linking had already happened — and the fix produces three things the researcher sees: the `Marked in this file` heading, a group per sentence, and `Nothing said about this sentence yet.` None of the three was asserted anywhere; `ledger-unlinked-`, `ledger-link-highlight-`, `ledger-highlights-heading` and `data-highlight-count` appeared in no test. The `[E03]` integration test is a good test and stops at the channel. | Fixed — a new E2E marks two sentences of a corpus page, links one, opens the ledger and reads the heading, the count, both groups, the quoted label, the empty group's sentence and the button back off the page, then links the unlinked one from the ledger and watches the group fill in place. Two mutations were watched to fail: not seeding the groups from the file's own highlights, and dropping the empty group's sentence. |

| 8 | major | **The allowlist between hostile TeX and a privileged origin had no test that could fail.** `packages/markdown-reader/src/math.tsx` is the milestone's one new parser of untrusted input, placed in the app's own origin, and its docstring argues at length that the string KaTeX emits is *parsed* and rebuilt as React elements against an allowlist rather than handed to `dangerouslySetInnerHTML` — "one KaTeX regression away from injection". The mechanism is two lines, and nothing exercised either. Replacing the body of `renderMath` with `dangerouslySetInnerHTML={{ __html: html }}` left a `<math>` with `<mi>` children and the right `display` in the DOM, so all fifteen tests in `markdown-math.test.ts` still passed — and so did the rest of the tree, because the file has no other caller. Nor was the list's *content* pinned: adding `href`, `style` and `id` to `ALLOWED_ATTRIBUTES` — the three its own comment says are deliberately absent — changed nothing any test observed, because `trust: false` means KaTeX never emits one. The auditor confirmed by probe that the property does currently hold; that it was unguarded is the finding. | Fixed by pinning, which is where the fault was: the implementation is correct and is now proved. Fifteen new cases assert the *mechanism*, not only its effect — both allowlists by exact contents, with `href`/`id`/`style`/`class`/`onclick`/`src` named as absent; the rebuild driven directly with markup KaTeX cannot produce, so a refused tag is dropped **with its subtree** and a refused attribute is dropped from an allowed tag; the six commands that exist to put behaviour or a fetch into the output (`\href`, `\htmlId`, `\htmlClass`, `\htmlData`, `\htmlStyle`, `\includegraphics`) each asserted inert with no `a`, `href`, `id`, `style`, `class` or `src` under the formula; the colours ordinary TeX *does* emit (`mathcolor` from `\textcolor`, `mathbackground` from `\rule`) asserted stripped, which is the attribute filter observed through the public path; and `renderMarkdown`'s return value walked as a React tree, so no element anywhere in it carries `dangerouslySetInnerHTML` and the MathML is present as built elements. Both named mutations were watched to fail — the `dangerouslySetInnerHTML` swap fails 8, the added attributes fail 2 — and restored. The two sets and the rebuild are exported for this, and the file's docstring now names the test that holds it up. |
| 9 | minor | **A formula could lay out a 1.6-million-pixel box.** `renderMath` never set KaTeX's `maxSize`, whose default is `Infinity`, while the allowlist admits every MathML length attribute on the `mspace`/`mpadded` that `\rule`, `\kern`, `\hspace` and `\raisebox` compile to. `$\rule{99999em}{99999em}$` reached the DOM as `<mspace width="99999em" height="99999em">` inside a reader panel — from any markdown file, and, because of finding 10, from a highlight taken out of any document and quoted onto the page the researcher writes their paper on. | Fixed — `maxSize: MAX_USER_SIZE_EM` (10), which is wider than any formula the researcher writes and narrower than anything that hurts. Two tests: the hostile rule comes back capped at `10em` in both dimensions, and `\hspace{2em}`/`\rule{2em}{1em}` are left alone. Removing the option fails the first. |
| 10 | minor | **`excerptMarkdown` escaped the title and left the quote raw markdown.** The `sourceTitle` is library metadata and was escaped with a comment explaining why; `selectedText` is *document-controlled* — the one input that came out of a PDF or off the open web — and went into the blockquote unescaped, and a blockquote's contents are markdown. A highlight reading `— [Ebbinghaus 1885](annotation://ann_…)` rendered a **second attribution chip above the real one**, navigating to a different annotation, on the app's one feature whose criterion is "keeps its link to the source". Bounded — `safeHref` refuses `javascript:`/`data:`, `will-navigate` refuses every foreign URL, the CSP refuses a remote pixel and raw HTML renders as text — so nothing executed and nothing left the machine. `> ` prefixing was being relied on as an escaping mechanism it is not. | Fixed — the quote is escaped as text, at the characters that begin a construct and only where they can begin one: `\`, `` ` ``, `*`, `[`, `]`, `<`, `~`, `|` everywhere; `#`, `-`, `+`, `=`, `>`, `:` and `1.` where they lead a line; `_` only when it is not between two word characters, so `file_9` keeps its underscore and `_loud_` does not. Five new tests, including the forged chip driven all the way through `renderMarkdown`: exactly one `annotation://` chip, and it is the one this function wrote. Reverting the escape fails four. Two residues are recorded rather than fixed and are named in the docstring — see below. |
| 11 | minor | **The shared inline-construct pattern was quadratic, in the process that owns the database.** `INLINE_CONSTRUCT_RE`'s wikilink branch admitted `[`, its own opening delimiter, so a run of them backtracked quadratically: 8,000 characters 385 ms, 32,000 5.6 s, **64,000 22 s** — and `flattenInline` runs on every block of every markdown file the corpus importer reads, synchronously, beside a better-sqlite3 handle. Not a milestone-6 regression: the identical branch was `WIKILINK_RE` at `b824ec5` and timed the same. It is here because milestone 6 promoted this expression to *the* shared authority for both processes, which is the moment its properties stop being the wikilink renderer's problem. | Fixed — `[` is excluded from the target class, in `INLINE_CONSTRUCT_RE` and in `WIKILINK_RE`, which must exclude the same characters or the links one collects are not the chips the other draws. Verified not to change what matches: both expressions were run over all 364 source, markdown and state files in the tree and agreed on every match, index and group; the only shape that reads differently is `[[[Page]]`, which now means `[` followed by a link to `Page` rather than a link to a page named `[Page`. Four new time-bounded tests over `parseMarkdown` at 64,000 and 32,000 characters, including the `$` runs that were always linear. Putting `[` back fails three, the first of them in 22 s. |

No finding was demoted: all eleven were reproduced before they were fixed. One critical was raised
and is closed; no major finding remains open.

### Minor findings left open, with reasons

Recorded rather than fixed; none bears on a criterion's evidence, and each is named here so its
absence is not mistaken for coverage. They are also in `state/experiment_state.json`.

- **An inserted excerpt is not persisted; its edge is.** `question:attach` writes first and the
  quote reaches the document only on blur, so unmounting the tab with the excerpt still open
  loses the quote and keeps the card. The dropped-picture path on the same page is the opposite.
- **A `[[wikilink]]` on a notebook page always reads "not written yet" and does nothing**: the
  block editor renders with no `wikilinks` renderer, so every chip resolves to `null`.
- **`[S03]`'s closing assertion is weaker than the sentence above it**: it takes
  `workspace.documents[0]`, which is not guaranteed to be a PDF, while `seedHighlight` attaches
  an unconditionally pdf anchor; and it asserts that *some* reader panel exists rather than that
  the marked sentence was revealed.
- **The delete report double-counts and drops what the confirmation promised**: `removed.links`
  includes the cards counted beside it, and `removed.hypotheses` is computed, carried on the
  channel and never shown — although the confirmation says "its claims go with it".
- **A journal page open on a deleted notebook is never told**: it subscribes to `journal:changed`
  only, so it stays editable and the first commit fails into the status bar with the day lost.
- **The excerpt chip has no broken state**, where every other citation on that page renders
  `"… (missing)"` and disables itself.
- **Caret placement inside a block containing maths lands at the end of the block**: `textContent`
  includes KaTeX's `<annotation>` TeX, which is not in the source, so `sourceOffsetFor` runs the
  cursor off the end — the failure `P05` exists to prevent, for blocks with a formula in them.
- **`$…$` inside *inline code* is flattened by the projection and rendered literally.** The same
  hole `[[wikilinks]]` has had since the projection was written: `mdast-util-to-string` has
  already dropped the backticks by the time the block text is flattened, so the two sides cannot
  be told apart at the string level. Narrow, and now shared by maths.
- **The ledger's own link count contradicts itself under truncation and is never drawn.** The
  repository says the count is deliberately unbounded by the entries' limit; the `[E03]` test
  asserts it equals the rows the ledger would print. Both hold below 400 entries.
- **`highlightsForDocument` has no limit and carries untruncated text**, where its sibling takes a
  limit and the resolver caps excerpts at 240 characters; and the panel re-runs it on every
  `library:changed`, whatever document it was about.
- **The ledger's comment describes an order the code does not use** ("in the order they were
  marked"; the repository orders down the page, and the `[E03]` test asserts that).
- **A marked sentence on the map is offered "Open Document"**: the `graph-node` menu's first group
  has no `forTypes`, and `openAnnotation` — what the `highlight` menu offers for the same thing —
  is absent.
- **The wiki's header and its hint are wrong when highlights are elided by the cap**: `quoted` is
  counted over the drawn nodes and `totalNodes` over the whole set, so the header can say "N files
  and notes" with highlights inside N.
- **The map's filter can only match the first 120 characters of a marked sentence**, because the
  title and the snippet are truncated before they leave main and the page matches on those.
- **`question:attach` accepts a soft-deleted highlight**: `annotations.get` does not filter
  `deleted_at`, unlike `listByDocument` beside it. Reachable by a caller, not by a hand; the same
  hole is in `hypothesis:attachEvidence`.
- **The saved page's persisted zoom is unbounded** — `z.number().positive()` — while the lever
  only ever emits one of six steps and clamps at both ends.
- **`PANEL_CONTROLS` ↔ `data-control` is set equality, so an undeclared widget is invisible**: the
  focused view's Labels checkbox and Reset button, and `Restore` on the discarded shelf, are
  features with no attribute on them. Finding 6 added one per-surface check; this is the general
  case.
- **`calendarMonths`'s `leading` docstring says the 1st falls under its own weekday**; the code
  aligns the first *drawn* day, which for the first month of a range is usually not the 1st.
- **A `$…$` in a quoted highlight still draws as a formula**, which escaping cannot reach:
  `render.tsx` runs the shared inline pass over mdast `text` values, and markdown has already
  consumed the `\$` by then. Fixing it means a second parser, or making the projection and the
  fold disagree about escapes — which is the defect finding 3 was. Bounded by `MAX_USER_SIZE_EM`
  (finding 9), and named in `excerpt.ts`'s docstring so it reads as a decision.
- **A bare `https://…` in a quoted highlight is autolinked by GFM**, which has no punctuation to
  escape. The anchor prints its own destination rather than hiding one behind a label,
  `will-navigate` refuses every URL that is not this window's origin, and `setWindowOpenHandler`
  denies — so it is a URL on the page. Asserted as that, rather than assumed away.

---

# Independent audit — milestone 5

Audited commit (milestone 5): f93477062c288983c6112b63f1240ae351799858

Brief: falsify "milestone 5 is complete and safe". Four auditors read disjoint lenses against
`7796795..f934770` — the notebook, the journal, blocks, images and the retirement of the word
"question" (`P01`–`P05`); the wiki page and the focused view under real rendering, real refocus
and a large library (`F01`–`F03`); the links that hold on — saved-page highlighting, per-highlight
links, the file ledger and picking a target from the graph (`H01`–`H04`); and the security
surface the milestone widened. None of them was the context that built the code. Their full
working is in `reports/audit-m5-notebooks.md`, `audit-m5-graph-views.md`, `audit-m5-links.md`
and `audit-m5-security.md`, including the reproductions and the traces that ended in "I followed
it and it holds".

Every criterion was green and the whole suite passed before the audit began, so nothing here was
found by running the tests. Each finding below was confirmed at the source, and then the fix was
confirmed by mutation: the fix was reverted, the new test was watched to fail, and the fix was
restored.

## Findings — milestone 5

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | major | **The retired word survived in every failure the researcher can be shown.** `[P01] no surface calls a notebook a question` reads seven surfaces in their success state and never provokes a failure — which is where the word lived. `IpcCallError` prefixed every user-facing message with the channel name (`ipc.ts:31`), and nine sites in `handlers.ts` threw `notFound('question', …)`. Both reach the screen through `describeError(...).message`: opening a notebook whose row is gone read **"question:notebook: question not found"**, on the page milestone 5 renamed. The same file already said `notFound('notebook', …)` in three other places, so these were missed call sites, not a decision. | Fixed — the message a person reads is the main process's sentence and nothing else; the channel is kept as a field on the error, for a log. All nine sites say `notebook`. Two new tests: `[P01] is the main process's sentence, with no channel name in front of it` (`renderer/ipc.test.ts`), and `[P01] says notebook, not question, in every refusal a missing notebook can produce`, which drives thirteen `question:*`/`journal:*` channels through the real router against a missing id. |
| 2 | major | **The directory never re-read while the app ran.** `load` was a `useCallback([])` behind one `useEffect`, and the panel subscribed to nothing — the only library-derived surface with no subscription. Dockview hides a tab by detaching its content element and React does not unmount a portal whose host node is detached, so no effect re-ran on return. Open the directory, open a notebook's journal from its row, write the day, come back: the row still read `Journal — nothing yet`. A notebook created from the queue never appeared on the shelf. | Fixed — the panel re-reads on reveal (`api.onDidVisibilityChange`) and subscribes to `journal:changed`, `library:changed` and `notebook:changed`. New E2E `[P01] re-reads the shelf when you come back to it, rather than remembering it` writes a day through the journal page and asserts the row's `data-entries` in the same process. |
| 3 | major | **`[F02]`'s ring was not in reading order, and its test failed about one run in three.** The order was `page_index, created_at, id`; `page_index` is `NULL` for every markdown file and every saved page, so on this app's corpus the ring was *creation* order with a random ULID suffix breaking ties inside a millisecond. Eight runs of `tests/integration/graph.test.ts` gave three failures. Creation order is not reading order either: mark paragraph 9 then 2 and the ring reads 9, 2. | Fixed — migration 013 projects each anchor's `position.start` beside `page_index` (every anchor kind records one), and the ring orders by `(page_index, text_start, created_at, id)`. New test `[F02] rings the highlights in the order the page reads, not the order they were made` marks five paragraphs bottom-up, in distinct milliseconds so the old ordering fails deterministically rather than two runs in three. |
| 4 | major | **The focused view under-reported its own elision by a thousand files.** `FOCUS_EDGE_LIMIT = 2000` cut the edge set before ranking, so it — not `neighbourLimit` — decided which files appeared, and `elidedNeighbours` was counted from what survived the cut. Reproduced: one file linked to 3,000 others, `neighbourLimit: 16` → "16 drawn, 1,984 more", with 2,984 actually not shown. The constant's own comment and `state/DECISIONS.md` both promised the opposite. | Fixed — "where it leads" is grouped in SQL, one row per file reached, with no ceiling on the edges considered: the work is proportional to the file's own degree, which is the thing being asked about, and the count is exact. New test `[F02] counts every connected file it left out, however many there are` seeds 2,100 neighbours and asserts 2,084. |
| 5 | major | **The wiki page dropped a real edge between two nodes it had drawn.** `EDGES_PER_NODE = 400` capped `#edgesTouching`, which `overview` called once per drawn node, so in `overview` the cap decided which *lines* existed. Reproduced: two hub files with more than 400 links each, joined by a link made afterwards — both drawn, zero edges, `truncated` and `elidedNodes` speaking only about nodes. | Fixed — `overview` reads its edges once, over the drawn set, through an indexed temp table joined to `links` on both ends. The per-node cap is the frontier expansion's again and says so. New test `[F01] draws the link between two hub files, and says how many lines it left out`. |
| 6 | major | **`GraphOverview.edges` was unbounded while the schema documented the answer as capped.** On a dense corpus (1,000 files, 200,600 links) `graph:overview({nodeLimit: 300})` returned 24,865 edges, each serialised over IPC and drawn as its own element, with no counter to confess it. | Fixed — `edgeLimit` on the request (capped in the contract), `totalEdges`/`elidedEdges` on the answer, `truncated` true when either half was cut, and the wiki page shows the two elisions separately. New test `[F01] caps the lines as well as the discs, and says how many it dropped`. |
| 7 | major | **`overview()` read the whole `links` table synchronously, on every redraw.** The class docstring claimed no code path read `links` whole; the ranking read it twice with a six-branch existence check per row — 997 ms/1,570 ms at 1,000 docs and 200,600 links, with better-sqlite3 synchronous, so the whole main process. And it ran on *every* `library:changed`: a wiki tab left open anywhere re-ranked the library for each highlight made, work that by design can never change the picture. | Fixed at both ends. The liveness test is joined once against the (usually empty) set of deleted endpoints instead of asked six ways per row, and each half is grouped along an index it can scan in order: 272 ms → 122 ms for the ranking, 2,750 ms → 230 ms for the whole answer on the dense corpus. The ranking counts only the kinds the map draws, which makes "a highlight cannot change this answer" true rather than approximate — so the panel does not redraw for one. The docstring says what is now the case. Two new tests: `[F01] ranks the library without a per-row existence check over every link` reads the plan of the statement the repository actually ran (through better-sqlite3's `verbose`), and `[F01] cannot be changed by a highlight, and is not redrawn for one` asserts the invariant and the panel's subscription together. |
| 8 | major | **The crawl carried the previous file's pan and zoom onto the next file.** `graph-canvas` documents the rule — "a remembered pan would put the next file's picture somewhere the reader left the last one's" — but a re-seat only changes `FocusPanelBody`'s `documentId` prop, so `useSceneView`'s state survived it and nothing reset it. Every focused file is laid out at the middle of the scene, so at the extremes the new file was drawn off the panel entirely. No test read `data-pan-x`/`data-zoom` across a refocus. | Fixed — `useSceneView(subject)` returns to rest when what the scene is *of* changes, in the module whose docstring states the rule; the focused view passes its file id. New E2E `[F03] leaves the previous file's pan and zoom behind when it refocuses` pans by dragging the canvas, crawls to the file at the edge, and asserts the viewport and the new centre. |
| 9 | major | **A saved-page anchor fabricated its own text evidence.** `H01` hands `createHtmlAnchor` a hint of `{0, len}` because a context-menu selection carries no offsets. When the words were not in the extracted text verbatim, `locateNearest` kept the hint: it became the recorded position *and* the place `createQuoteSelector` cut prefix and suffix from — confident context describing a passage nobody marked, which `scoreContext` then uses to choose between occurrences. And the fuzzy pass is bounded to the hint ± 4000, so a sentence further down was never searched. Reachable: `extractHtmlText` scans markup, so it emits `display:none` prose and drops `svg`/`math`, while Chromium's selection is the opposite in both. Measured: a misaligned range at confidence 0.52 near the top, `null` 7.8k characters down. | Fixed at the cause — `locateNearest` says when it cannot find the quote, and the anchor then records no offsets and no context: `HtmlAnchor.position` is optional, and a quote-only anchor is re-found by searching the whole page. The markdown path keeps the reader's real offsets and drops only the invented context. New test `[H01] records no offsets and no context when the words are not in the extracted text`, over a real archived page with hidden markup inside the marked sentence, 7.8k characters down. |
| 10 | major | **The ledger listed a deleted highlight's link as a live, unbroken connection.** `findForDocument` promised the opposite in its docstring, but filtered `annotations.deleted_at` only when deciding whether an endpoint was inside *this* file; the far end was described by a resolver that never checks it, so `resolve()` reported `broken: false`. Probed: paper A's ledger was byte-identical before and after the highlight at the other end was deleted, while `graph.focus` correctly dropped the neighbour — two milestone-5 surfaces disagreeing about the same fact, and the panel navigating to a highlight that no longer exists. | Fixed — the graph's `LIVE_EDGE` moved into `repositories/live-edge.ts` and the ledger query uses it, so both ends are checked in one definition rather than two copies and an omission. New test `[H03] drops a deleted highlight's link from the ledger, as the focused view does` asserts both surfaces before and after the deletion. |
| 11 | major | **`H01` shipped with no affordance.** The context menu is the only route by which a selection leaves the archive, and nothing on the page said so — no hint, no empty state, no label. Every other reader raises its bar on `mouseup`, so the gesture a researcher has learned everywhere else did nothing at all on a saved page, which from the outside is the bug `H01` was written to fix. `[H01]` passed only because `selectAndInvoke` knows to right-click. | Fixed — the article panel says it, in the strip where the selection bar appears: "Select text in the page, then right-click it to highlight." Asserted in `[H01]` before any selection is made and again after the highlight is created. |
| 12 | major | **A stale `selectedDocumentId` sent the ledger, the focused view and the link picker to the wrong file.** `getActiveEntity` pairs `selectedAnnotationId` with `selectedDocumentId`, two independently written fields: only `makeHighlight` set both, and tab activation re-pointed the file only when the new tab was a `pdf-reader`. Open saved page B, open paper A, click back to B, press the ledger chord — A's ledger opens over B, and the annotations sidebar has been showing A's highlights all along. | Fixed — tab activation runs the host's one rule for every reader kind, the three highlight-activation handlers set both halves the way `makeHighlight` does, and navigating to a highlight sets the file it is in. A highlight from the file you just left stops being the current selection instead of being paired with a file it is not in. New E2E `[H03] opens the ledger of the tab in front, whatever kind of reader it is`. |

No critical finding was raised, and no major finding remains open. Nothing was demoted: all
twelve were reproduced before they were fixed.

### Minor findings left open, with reasons

Recorded rather than fixed; none bears on a criterion's evidence, and each is named here so its
absence is not mistaken for coverage. Two were closed in passing — the focused view added its
two elision counters together, and the wiki page and the focused view now report theirs
separately, which is what the channel's two budgets are for.

- **`[P05]`'s gating E2E clicks the bare paragraph**, whose rendered text is its markdown source,
  so `sourceOffsetFor` is the identity function for the whole test; the mapping is covered only
  by the untagged unit test.
- **A dropped picture discards block text held only in component state**: `journal:changed`
  reloads the day without regard to an open editor, and block text reaches the database on blur.
- **`JournalRepository.count()` is dead** and its comment claims it is the directory's count;
  the directory instead materialises every day's markdown of every notebook to produce two
  integers.
- **`P03`'s start date is one-directional** — an entry older than the chosen day silently wins —
  and the integration test blesses the deviation rather than naming it.
- **The materialised wiki still writes `questions/`** and stamps `type: question`; off unless
  agents are enabled, which is the only reason it is minor rather than part of finding 1.
- **"Lists every notebook" is proved only for notebooks that are not discarded**: the dropped
  rows render in a second list with no test id.
- **A nested code fence is restructured the first time the day is saved**; the round-trip test
  only asserts stability from the second parse onward.
- **"The whole graph at once" tops out at 300 nodes**, and no test at any level exercises the
  wiki page in its truncated state — which is its state for every real library.
- **At the default size the map's discs and labels overlap**, and the layout test uses 40 nodes
  and integer-rounded positions, so it cannot see it.
- **Overlapping loads are applied unconditionally** in both graph surfaces: change the size
  picker twice on a large library and the older answer can land last.
- **A note node in the link picker's map is a dead click that says nothing.**
- **Three graph surfaces, three answers to "show labels"**: `G02` persists the preference and
  the two new surfaces each hold a local `useState(true)`.
- **`F02`'s geometry assertions read the layout's own numbers**, not the transform; the new
  `[F03]` viewport test is the first thing in the E2E suite that reads a drawn viewport.
- **The keyboard route to "Link this to…" has no "is this highlight on the file I am looking at"
  guard**, where the reader's strip does; the picker names the source, so it is visible.
- **The article panel knows an anchor is broken and never tells the sidebar**: only the PDF
  reader publishes resolutions.
- **`openLedger` and `openFocusView` resolve their subject through the link under the cursor**,
  which `#linkSubject` deliberately does not.
- **`article-reader` descriptors still claim `readerMode: 'readability'`** while the panel
  hardcodes `'original'` and explains at length that the field is a lie.
- **The ledger truncates in silence** at 400 rows and prints `entries.length` as "N links".
- **Neither half of the `H01` transport has a unit or integration test**: the refusals in
  `reportSnapshotSelection` and `document:getSnapshotText` are held by construction only.
- **`[H04]`'s "one of its annotations" assertion cannot distinguish success from a degraded
  path**: both branches of `describeLinkTarget` contain the word it asserts.
- **`canonicalLinkType` still returns the type the whole `H02` design exists to refuse**; no
  production caller reaches it today.
- **`document:getSnapshotText` reads any library file whole**, untyped and unbounded — not a
  path escape, but a renderer-triggerable whole-file read into the process that owns the
  database.
- **The `webpage:selection` topic is unbounded and broadcast**, where every other size-sensitive
  field in the contract carries a maximum.
- **Subframe navigation is not locked** (`will-frame-navigate` is unbound), and milestone 5 made
  the frame's URL an identity; two other layers still hold, and a mismatched selection is
  dropped rather than misattributed.
- **A saved-page anchor still lands on the *first* occurrence of a repeated sentence.** The
  fabricated-context half of this is finding 9; what remains is that a hint of "the top of the
  page" cannot distinguish two identical sentences, and the sandbox is why there is no better
  hint. Recorded in `state/DECISIONS.md`.

### What was checked and held

Named because a verified invariant is worth as much as a finding, and because the next session
should not re-derive it.

- **`H01` is fixed at the cause.** A snapshot renders inside `sandbox=""` at an opaque origin
  with no script: `getSelection()` cannot cross into it, `contentDocument` is cross-origin, and
  the frame has no script to `postMessage` out. Taking the selection from Chromium's
  context-menu parameters in the main process grants the archive nothing. `packages/html-reader`
  is untouched in the whole range — no sandbox token, no CSP relaxation, no second iframe, no
  `webSecurity` change.
- **`P02` is the strongest work in the range**: the day is keyed `(notebook_id, date)` at the
  schema, no repository method can read or write a day without naming its notebook, the link
  endpoint carries the notebook, and the *upgrade* is tested against a real migration-011
  database carrying a real edge. The orphan-journal case adopts rather than deletes.
- **`P04` is not satisfied by a mock**: the drop builds a real `File` so `webUtils.getPathForFile`
  is genuinely exercised, the payload is zod-validated in the router, and "the bytes arrived" is
  `naturalWidth > 0` over `rrfile://`, with inode and size checks proving nothing was copied.
- **`H02`'s new type is genuinely new**, and the third test in `highlight-links.test.ts` proves
  the idempotency collision it avoids is real rather than asserting the guard exists.
- **`F03`'s re-seating cannot be bypassed**: `panelSubjectKey` keys `focus` on kind alone,
  `RESEATED_PANEL_KINDS` makes a reveal carry the new descriptor, and the panel reads the
  descriptor rather than panel state.
- **The preload still exposes exactly `invoke` and `subscribe`.** The journal drop target is read
  in the preload's world and re-validated in the router; `wr:drop` remains off the bridge.
- **No path crosses the boundary** on any new channel, and `P04` writes `![title](rrfile://<id>)`
  in main. `rrfile://` roots are not widened: a dropped picture admits exactly one file.
- **`scripts/verify_completion.py` was only added to** in this range, and only added to again
  here — no tag, root or forbidden import was removed or weakened.
- **No test was deleted** to make room: `graph.spec.ts`'s removed lines are helpers that moved to
  `tests/e2e/support/corpus.ts`, and no `.skip`, `.todo` or `.fixme` exists anywhere in the suite.

## Gates after the fixes

`pnpm typecheck` 0 · `pnpm lint` 0 · 712 unit tests in 57 files, 0 failures (701 before; the
fixes added eleven) · `pnpm test:e2e` 81 specs, 0 failures (78 before).

---

# Independent audit — milestone 4

Audited commit (milestone 4): c072375f828c026e4f2f1fdafef3433df0cd0441

Brief: falsify "milestone 4 is complete and safe". Four auditors read disjoint lenses against
`fde3e38..c072375` — the field notebooks (`N01`–`N08`), the journal and the link/note surfaces
(`N09`–`N11`, `K01`–`K03`), the library and the graph (`B01`–`B05`, `G01`–`G03`, `G06`), and
the security surface the milestone added (`G04`, `G05`, the drop and add-file paths, the IPC
router). None of them was the context that built the code. Their full working is in
`reports/audit-m4-notebooks.md`, `audit-m4-journal-links.md`, `audit-m4-library-graph.md` and
`audit-m4-security.md`, including the traces that ended in "I followed it and it holds".

Every criterion was green and the whole suite passed before the audit began, so nothing here
was found by running the tests. Each finding below was confirmed at the source and then
re-confirmed by mutation: the fix was reverted, the new test was watched to fail, and the fix
was restored.

## Findings — milestone 4

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | major | **A routine import silently undid the researcher's curation.** `zotero:import` falls back to the remembered picks when no collection is named (`handlers.ts:367`), and the importer's only test for "the researcher asked for this" was `scoped: scopeKeys !== null` (`importer.ts:303`), which then lifts the removal. So once any standing scope was ticked — the ordinary state of the app — the plain Import button was a *scoped* run, and every removal inside those collections came back. `[B01] a routine import leaves a removal alone` passed only because its fixture never wrote `zotero.importScope`. This is the exact failure `importer.ts:246-250` promises against: "no sync that quietly undoes a morning's curation", and the blacklist problem wearing the opposite face. | Fixed — the caller now says where the scope came from (`ScopeOrigin`, `'named'` vs `'remembered'`); only a collection named in *this* action lifts a removal. New test `[B01] a routine import leaves a removal alone even when the picks cover it` sets the standing scope to the victim's own collection, and asserts both halves: the routine run leaves it removed, and naming that same collection still brings it back. |
| 2 | major | **"Its text is queued to be searchable again" was a no-op.** The restore path enqueues an `index-fts` job (`importer.ts:415`) and nothing has ever drained one: the only consumer claims `'extract-text'` (`pipeline.ts:102`), and `workers/indexing` is a declared stub. `[B01]` cited that queued row as its evidence, so "queued to be reindexed" and "never reindexed" had the same observable. Because `library.remove` drops *every* entry carrying the document id, annotations included, a restored document stayed unfindable and its highlights stayed unfindable permanently — the researcher's own words, lost from search while the paper sat back on the shelf looking whole. The local-file restore path (`local-files.ts:173`) queued nothing at all. | Fixed — `SearchIndexer.reindexDocument` re-projects the document record, its chunks and its annotations from rows that never left; the pipeline drains `index-fts`; the local-file restore enqueues one too. `[B01]` now drains and searches instead of reading the queue, and a new `[B03] a highlight answers searches again once the paper is back` asks through `search:query` for the words the researcher selected. |
| 3 | major | **Card art's "one allow-listed host" was enforced on the first hop only.** `#request` checked `new URL(url).host` against the constant and then passed `redirect: 'follow'`, with nothing reading `response.url`. The bytes, the content type and the destination could all come from whatever a `Location` header named. Not theoretical: `artUrl` asks for `format=image`, which Scryfall answers *with a redirect*, so following an unchecked hop was the normal path, and the picture arrived from a host named in neither the disclosure, `docs/SECURITY.md` nor `README.md`. A `Location: http://…` was followed too, and main-process `fetch` is Node's, so the window's request blocker never sees it. | Fixed — redirects are followed by hand with the allow-list applied to **every** hop, scheme and port included, bounded at three. The image CDN is now named as what it is (`CARD_ART_IMAGE_HOST`), and the disclosure, `README.md` and `docs/SECURITY.md` all name both hosts, because the honest fix was to disclose the request the app actually makes rather than to keep a bargain that described a different one. Three new `[G05]` tests: the real one-hop path is followed, a hop off the list is refused *before* the second request is made, and `http:` or a port of its own is refused. |

No critical finding was raised, and no major finding remains open.

### Minor findings left open, with reasons

Recorded rather than fixed; none bears on a criterion's evidence, and each is named so its
absence is not mistaken for coverage.

- **A setext heading spanning two lines leaks its underline into the section body**
  (`notebook.ts:95-104`): `endOfHeading` hard-codes a two-line setext heading. No `[N02]` test
  uses setext at all. Proved by execution against the built module.
- **`[N06]`'s anti-regression guard does not discriminate**: `expect(placed.x + placed.y)
  .toBeGreaterThan(0)` (`board.spec.ts:139`) is satisfied by the *un-dragged* default
  `defaultSpot(0) = {16,16}`, so an implementation that committed a card's pre-drag position
  on pointer-up would pass the whole spec. The comment above the line names this failure mode.
- **Two of the six things `N03` names have no way in**: `importance` is never displayed and
  `coverFileId` can never be set from the running app. The criterion is integration-kind and is
  met through the real router, but by the milestone's own `N08` principle these point nowhere.
- **`N10`'s trap is not discriminated by any test**: the shipped `projectStart()` correctly
  reads `MIN(applied_at)` from `schema_migrations`, but substituting `firstDate() ?? today`
  leaves all four assertions passing. `runMigrations` takes an injected clock, so telling "when
  the project began" from "when the first entry was written" was feasible.
- **An empty code block marks an unlogged day as logged**: `EMPTY_CODE_BLOCK` does not trim to
  empty, so `serializeBlocks`' "a block nobody typed into is dropped" is false for `+ code`.
- **Writing a day then switching days in one gesture leaves the calendar marker stale**
  (`journal-panel.tsx:210-217`): the write lands, the bubble does not update.
- **The 8 MB card-art cap bounds the disk, not the process**: the cap is checked after
  `arrayBuffer()`, and undici decompresses transparently — measured at 65,250 bytes on the wire
  expanding to 67,108,864 in heap.
- **`SwappableRoots.withdraw` has no caller**: the admitted-file allow-list is monotonic, so a
  removed local document's path stays readable for the life of the installation.
- **`question:update.coverFileId` checks that the file exists but not that it is an image**,
  where `graph:setNodeIcon` checks both.
- **Four new channels take `entityId: z.string().min(1)` with no maximum**, and
  `graph:setNodeName` writes without an existence check — the same gap `docs/SECURITY.md`
  already records for `link:create`.
- **Three tests tagged `[B05]` test environment-variable parsing, not importing a collection.**
  `B05` is an E2E tag, so the verifier reads the real evidence at `library.spec.ts:223`; the
  tags on the unit tests are wider than what they exercise.

### What was checked and held

Named here because a verified invariant is worth as much as a finding, and because the next
session should not re-derive them.

- `B04`'s hash covers a real, openable `zotero.sqlite` at exactly the path the services are
  built with — sha256, size, mtime, and the absence of `-wal`/`-journal`.
- The `B01` blacklist is genuinely gone: no `listRemoved`, no `restoreDocument`, no Removed
  list, no stale table and no test still asserting the replaced behaviour.
- `N05`'s trap is closed. Citations resolve through the same `findReferences`/`EntityResolver`
  the references panel uses, and the test asserts the highlight's own words plus a non-null
  anchor-derived location, which an id-echoing implementation cannot produce.
- `N07`'s seam is real and not computed at both ends: the path comes from
  `webUtils.getPathForFile` in the preload over `wr:drop`, which is genuinely off the bridge,
  and admission widens the allow-list by exactly one file. The E2E proves `/etc/hosts` lands
  nowhere.
- `G03` asserts the document title unchanged *in the database* after a `force` re-import.
  `G06`'s parentage comes from the graph query, is withheld when the container was not sent,
  and uses real Cytoscape compound nodes.
- `K02` asserts both of an annotation's edges and identifies each by relationship. `K03` is a
  live rendering: `search('')` returns every registered command uncapped, the test iterates the
  real `DEFAULT_KEYBINDINGS`, and the list is opened by clicking rather than by chord.
- `N11` has one store, structurally: no block table in any migration, and `commit()` re-parses
  the markdown the main process answered with. `N09` measures the page against a real reader,
  and `toggleJournalSidebar` is gone from the type union, so a regression would not compile.
- `rrfile://` containment re-verified **by execution** against the real `paths.ts`: traversal,
  a prefix-collision root, a planted symlink, a sibling of an admitted file, the containing
  directory, relative paths, NUL and `%2e%2e` — all refused.
- No channel accepts a filesystem path or a URL; `ipcMain` appears only in `router.ts`; no new
  loose zod; `contextIsolation`, `sandbox` and `nodeIntegration` unchanged; and no `any`,
  `as unknown as`, `@ts-expect-error` or `eslint-disable` anywhere in the milestone-4 diff.

## Gates after the fixes

`pnpm typecheck` 0 · 650 unit tests in 53 files, 0 failures (645 before; the three fixes added
five tests) · `pnpm test:e2e` 65 specs, 0 failures.

---

# Independent audit — milestone 3

Audited commit (milestone 3): f6fbede0099d8f5e0348ff87f194b09f73a9d232

The tree the auditor read, deliberately not HEAD: fifteen findings were opened against
`f6fbede` and the commits after it are the fixes. The full working is kept in
`reports/audit-m3-security.md` — every trace, including the ones that ended in "this is safe",
because "I followed it and it holds" is worth as much as a finding.

Brief: falsify "milestone 3 is complete and safe". Scope: the librarian surface —
`main/agents/*`, the IPC router and handlers, `protocol.ts`, `paths.ts`, `services.ts`, the
renderer panel that drives them, and the tests that claim to cover them. The `[A01]` stream
buffering defect was excluded, having already been diagnosed and fixed in `5ff789b`.

## Findings — milestone 3

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | critical | `agent:progress` published **absolute filesystem paths** to every renderer and painted them on screen, falsifying `CLAUDE.md`'s "the renderer never receives or builds a filesystem path" and `docs/SECURITY.md:14,32`. Both free-text fields leaked: tool targets, because Claude Code's `Read` takes an absolute `file_path`, and message prose, because the model narrates its own working directory. The topic's own contract claimed a relative form. | Fixed — `withoutFilesystemPaths` (`main/paths.ts`) reduces each path to root-relative or basename; `AgentServices.progressRoots` names the roots once so a publisher cannot omit them. `tests/integration/agent-progress.test.ts` runs the real recorded transcript and finds none; it caught nine before the fix. |
| 2 | major | The materialised wiki — full text of every document, every highlight and comment, every question and journal entry — was **never removed in production**. `WikiView.remove()` had no non-test caller. `README.md:16` and the disclosure's withhold line are read by someone deciding whether they can change their mind, and neither was true of switching back off. | Fixed — `agent:enable{false}` awaits `view.remove()` after stopping the timer and cancelling runs. Asserted by running a real pass, checking the copy exists, then switching off. |
| 3 | major | **TOCTOU in `agent:accept`**: the pending check sits two awaits before the state change, so two concurrent accepts both passed it. The proposal row is protected by `WHERE status = 'pending'`; `documents.create` is not, and `documents_slug_idx` is not unique — so a double click minted a second document and `upsertByPath` orphaned the first, leaving a librarian note with citation edges and no file, in the library and the graph, unopenable. | Fixed — `LibrarianService.accept` shares its in-flight promise per proposal id. A later accept still fails the status check. |
| 4 | major | **"One pass at a time" had a race window spanning `materialise()`** — `runner.busy` reads the map the spawn populates, so it was false for the whole of the expensive part. Two runs inside it both passed the guard, both rebuilt the wiki on one root with one `rm -rf`ing while the other sealed, and both spawned a `claude`. | Fixed — `LibrarianService.busy` is true from the moment a pass is entered. Both readers of the stale flag were corrected: the `agent:run` guard and `observe()`, which is what `decidePass` reads. |
| 5 | major | **`A02` asserted a door the agent does not use.** Every test exercised `AgentWorkspace`, which bounds the writes the *app* makes; the spawned `claude` writes with its own tools and never calls it, despite the class header saying "there is no other path". No test had the child attempt an escape. | Fixed — `fake-claude.mjs` now writes into every `--add-dir` root it was given and records the errno; the test asserts the kernel refused each one and no file landed. `ENOENT` is excluded, because an absent wiki would refuse those writes too. The outer boundary is a third party's and is now named as such rather than implied to be covered. |
| 6 | major | **`A13`'s "a pass that finds nothing writes nothing" passed on the wrong cause.** The recorded run *did* produce a finding; it landed in the run-directory root, where `harvest` does not look. "Found nothing" and "wrote it where nobody reads" have the same observable from those assertions. | Fixed — the pass is genuinely quiet now, and a new assertion fails if any markdown the child wrote is left anywhere in the run directory. Checked against the old behaviour: it catches the historical defect. |
| 7 | major | **No test harvested a real agent's output.** Every proposal was hand-staged into a path the test computed itself, so both ends of the write/read seam were the test's arithmetic — the same seam finding 6 showed was broken in the only recording that exists. | Fixed — the child writes to `./proposals/` relative to the working directory the runner gave it, which is what the task instructs, and the real `ProposalReader` finds it. The recorded argv is asserted to still carry that instruction, so a change to either end goes red. |
| 9 | minor | **`docs/SECURITY.md` had no milestone-3 content**, and two of its lines were false. | Fixed — threat-model rows for prompt injection through a hostile saved page and for the child process; four invariant rows; four gaps stated plainly, including the ones below. |

No critical or major finding remains open.

### Minor findings left open, with reasons

Each is recorded in `docs/SECURITY.md` where it bears on the threat model.

- **8 — the `rrfile://` allow-list holds the whole agent workspace**, not just the `notes/`
  directory accepted proposals land in, so `.runs/` staging is inside the served root. Traced
  and not reachable: `rrfile://` takes file ids, not paths, and the only code that mints a row
  under this root does so for `notes/*.md`; the corpus importer skips dot-entries. A widened
  seam, and narrowing it is a change to the root wiring rather than a fix to a hole.
- **10 — the child inherits the whole main-process environment.** Real, and the honest
  mitigation is an allow-list of variables the CLI needs, which is a behaviour change to a
  third-party spawn best made with a live `claude` to test against.
- **11 — a child that ignores SIGTERM wedges the librarian.** No SIGKILL escalation and no
  settle-on-timeout, so `busy` stays true and every later pass is refused. A real availability
  defect, bounded by the app's lifetime and needing no data recovery.
- **12 — `WR_AGENT_EXECUTABLE` names an arbitrary binary to spawn.** Same class as
  `WR_DATABASE_PATH`; an attacker who can set the environment can already run code.
- **13 — no size or count cap on harvested proposals.** Every staged `.md` is read whole into
  memory while the run summary is capped at 4000. One enormous file is a main-process OOM.
- **14 — `A03`'s E2E observable is sound by ordering, not by construction.** `<agentRoot>/wiki`
  catches a spawn only because `pass()` materialises before spawning. The main-process side of
  `A03` is asserted directly in `agent-channels.test.ts`; what is missing is a spawn counter in
  the E2E.
- **15 — dead clause** at `workspace.ts:220`: `parent !== root` is unreachable because
  `isInsideRoot(root, root)` is `true`. Harmless.

### What was traced and found sound

Stated because a trace that ends in "it holds" is evidence too. Full working in the lens file.

- **`A03`, off means off.** No path from a fresh launch to `materialise()`, a spawn,
  `scheduler.start()` or the network with agents disabled. Double-gated: `decidePass` returns
  `disabled` *and* the timer is never armed. Enabling is gated on the disclosure at the channel,
  not in a component. The only outbound primitive with agents off is the Zotero loopback client.
- **Path traversal via `agent:accept`.** The renderer supplies only a constrained id; the
  written path is `notes/<[a-z0-9-]{1,60}>-<6 chars of a minted id>.md`. `resolveWrite`
  independently closes empty/NUL, absolute, lexical `..`, and symlink-through-an-existing-
  ancestor, each asserted with an escape attempt rather than a happy path.
- **One router, zod before dispatch, `contextIsolation`/`sandbox`/`nodeIntegration`, the
  two-function preload, the renderer import boundary.** All hold; no `any`, no
  `eslint-disable`, no `as unknown as` anywhere in milestone-3 code.
- **`A11`, no retrieval.** No `@wr/search` import in the agent path; whole documents by
  chunk-index concatenation with no limit or ranking; no web tool; `--strict-mcp-config` with
  no MCP config.
- **Agent-authored markdown cannot become HTML.** No `dangerouslySetInnerHTML` or `innerHTML`
  in the reader packages or the renderer.
- **The agent cannot choose which table a citation resolves against** — the type comes from the
  id prefix. And the front-matter reader is two hand-parsed forms, not a YAML deserializer.

### Gates after the fixes

`pnpm typecheck`, `pnpm lint`, `pnpm test` (549 in 46 files) and `pnpm test:e2e` (45) all pass.
Each fix was written test-first, and the three that guard a race or a boundary were checked in
both directions — the guard removed must make them red. Two were rewritten after that check
showed they passed anyway: the accept race reproduced only three times in six as a plain race,
and the first barrier that made it deterministic released its writer too early to open the
window at all.

---

# Independent audit — milestones 1 and 2

Audited commit (milestone 2): 4420cea8ee5998fddae26db66c0c795c9c8852ba

Milestone 2 is audited below at `4420cea8`; the milestone-1 audit at `fa5672a8` is kept after
it. Two findings were opened against `4420cea8` and fixed in the commits that follow it, so the
audited commit is deliberately not HEAD — what it names is the tree the auditors read.

## Milestone 2 (W01–W12)

Brief: falsify the claim that milestone 2 is complete. Two lenses, run independently, each
keeping its full working:

- `reports/audit-m2-tests.md` — test honesty: does each tagged test exercise the criterion its
  tag claims? Findings proved by mutating production code and re-running the suite.
- `reports/audit-m2-security.md` — the security and architecture invariants in `CLAUDE.md` and
  `docs/SECURITY.md`, against the source rather than the docs' claims about it.

### Findings — milestone 2

| # | Sev | Finding | State |
|---|-----|---------|-------|
| W-1 | major | `[W11]` built its own copy of the popover's edit handlers, so no-op'ing `AnnotationsView`'s handlers left all seven `[W11]` tests green — the criterion says the colour is changed *from the popover* | closed — the wiring moved to `apps/desktop/src/renderer/annotation-actions.ts`, one definition used by both panel and test; the same mutation now fails `[W11] changes the colour from the popover` |
| W-2 | major | Nothing drove `zotero:import`, so the channel's zod contract and the handler that forwards `collection` were asserted by nothing: the handler could drop the scope and every `[W12]` test would still pass | closed — `tests/integration/zotero-import.test.ts` drives the channel over the real router; dropping the scope in the handler now fails 3 of its 4 tests |
| W-3 | minor | `packages/graph/src` is renderer-consumed (`graph-panel.tsx:16`) but was absent from `RENDERER_SOURCE_ROOTS`, so the forbidden-import rule never reached it | closed — added to `scripts/verify_completion.py`; the package was already clean |
| W-4 | minor | `protocol.ts:258-279` gates snapshot containment on `resourcePath !== ''`, so `rrfile://<file-id>/` is served to a snapshot frame; the comment at `protocol.ts:342-343` overstates the guarantee | open — no exfiltration path (scripts off, opaque origin, remote requests cancelled); the overstated comment is the defect |
| W-5 | minor | `[W10] sends no edge whose other end was withheld` cannot fail — the frontier loop cannot produce the half-edge it describes; removing the edge filter left it green | open — the node-cap test does catch the real elision bug |
| W-6 | minor | `[W03]`/`[W05]` archived pages are markup written by the harness; no recorded snapshot fixture exists | open — the harness writes real files with real CSS and images to disk and the assertions are a computed font and a non-zero `naturalWidth`, which a fallback rendering cannot satisfy; a recorded snapshot would still be better evidence |
| W-7 | minor | `[W01]`'s `rrfile://` test asserts the response shape without performing the fetch; `[W06]`'s resolution test resolves against a hand-built `Map` (the real coverage is untagged, `corpus.test.ts:96`); no test asserts a non-default colour is painted in a reading view | open — each names a seam the tag claims more of than it proves |

No critical finding was raised. Both major findings are closed, each with a mutation that fails
the suite as it now stands and passed against the code as it was. The minor findings above stay
open with their reasons; none of them blocks a criterion.

### What the mutations showed

The suite caught, unprompted: the `[W02]` lost-highlight fallback (a mutation found in the
working tree at the start of the session — resolving a lost anchor to its stored offsets rather
than reporting it lost), the `[W07]` `source_id` delete bug, the `[W10]` node cap, and the
`[W12]` scope filter. `[W04]` is the strongest suite in the milestone. The two majors above are
the cases where a mutation went unnoticed.

### Gates at the fixed tree

`pnpm typecheck` 0 · `pnpm lint` 0 · 432 unit tests in 32 files, 0 failures · 17 E2E specs
against a real Electron launch, 0 failures.

---

# Independent audit — milestone 1

Audited commit (milestone 1): fa5672a823e48faa1c3376672f97ad25551e8f7f

Brief: falsify the claim that milestone 1 is complete. Specifically — tests that assert
nothing meaningful, criteria satisfied by mocks where real integration was feasible, regressed
security invariants, `any` reintroduced, stubs presented as working, and tests tagged with a
criterion ID that do not exercise it.

Two lenses were run against the source tree, the built artefacts and the running suite. Their
full working is kept rather than summarised away:

- `reports/audit-security.md` — the security and architecture invariants in `CLAUDE.md` and
  `docs/SECURITY.md`. 9 findings (3 major, 6 minor).
- `reports/audit-tests.md` — test honesty: does each tagged test exercise the criterion its tag
  claims? 8 findings (3 major, 5 minor), three of them proved by mutating production code and
  re-running the suite.

Every critical and major finding is closed, each with a test that fails against the code as it
was. The minor findings still open are listed below with the reason.

---

## Findings

| # | Sev | Finding | State |
|---|-----|---------|-------|
| S1 | major | Remote-request block bypassable by any host prefixed `localhost`; `ws://`/`wss://` never intercepted | closed — `fafc6cb` |
| S2 | major | `rrfile://` and the extraction pipeline checked paths lexically, so a symlink inside an allowed root read bytes from outside it | closed — `fafc6cb` |
| S3 | major | `docs/SECURITY.md` threat model said hostile PDFs are parsed in the main process; the reading view parses them in the renderer | closed — `4ab6c28` |
| T1 | major | `[L03]` was satisfied by a test that never listed a reference | closed — `f460aee` |
| T2 | major | `[L04]` asserted a pass-through, not a listing | closed — `f460aee` |
| T3 | major | `[T05]` claimed "HTML text normalization" while every test fed plain strings or PDF text items | closed — `f460aee` |
| S4 | minor | `docs/SECURITY.md` §2 and its gaps list described a preload and a router that no longer exist | closed — `4ab6c28` |
| S7 | minor | The renderer-boundary gate never scanned `apps/desktop/src/renderer` | closed — `4ab6c28` |
| S8 | minor | No `setPermissionCheckHandler`; synchronous permission checks fell back to Chromium defaults | closed — `4ab6c28` |
| S9 | minor | Navigation hardening was per-window; the dev allow-check was a prefix match | closed — `4ab6c28` |
| S6 | minor | `zotero:import` returned raw `Error.message` text to the renderer | closed — `fa5672a` |
| T4 | minor | A `[T05]` test asserts on a compile-time constant | open — accepted |
| T5 | minor | A `[T07]` test is vacuous in isolation | open — accepted |
| T6 | minor | A `[T04]` test computes its expectation with the function under test | open — accepted |
| T7 | minor | No `[M04]` test reaches the real `hashFileOnDisk` probe | open — accepted |
| T8 | minor | Nothing joins the M14 store round-trip to the renderer's serializer | open — accepted |
| S5 | minor | Five IPC request fields are `z.unknown()`; link ids and types are unconstrained strings | open — recorded in `docs/SECURITY.md` |
| — | minor | TOCTOU window between `realpath` and `open` in `rrfile://` | open — recorded in `docs/SECURITY.md` |

### The three major security findings

**S1.** `callback({ cancel: !details.url.startsWith('http://localhost') })` admitted
`http://localhost.attacker.example/` — a public, DNS-resolvable host that merely shares the
prefix. This is the same collision `isInsideRoot` was written to prevent for paths, 260 lines
away in the same process. The filter also listed only `http://*/*` and `https://*/*`, so
`ws://` and `wss://` were never handed to the handler. `isLoopbackUrl` now parses the URL and
compares `hostname`; the filter covers all four schemes. CSP would have stopped the request
first in a packaged build — the finding is that the layer documented as the outright block
was not one.

**S2.** `isAllowedPath` compares strings. `stat` and `createReadStream` follow symlinks, and
`grep -rn realpath` over the repository returned zero hits, so a row pointing at
`<zoteroDataDir>/storage/ABCD/paper.pdf`, where that entry is a symlink to `~/.ssh/id_rsa`,
passed the check and was streamed to the renderer with `200 OK`. The same gap sat in the
extraction path. `resolveAllowedPath` now resolves the candidate and re-checks containment
against roots that are themselves resolved, and returns the real path so callers open what was
checked — checking one path and opening another is the hole itself. The adversary must already
be able to place a symlink under the library, which is precisely the tampered-data adversary
the module claims to defend against.

**S3.** A documentation defect, and the most consequential one: `CLAUDE.md` names
`docs/SECURITY.md` as the authority for these invariants, and on the primary row of its threat
model it described a different architecture — parsing in the main process, the renderer
receiving only extracted text and page images. The reading view calls `getDocument` on an
`rrfile://` URL in the renderer and starts a PDF.js worker there. The implementation is
defensible; the document could not be used as evidence about it. Rewritten, along with the
stale claims that the preload exposes a `platform` string, that nothing asserts the bridge's
shape, and that responses are not validated on the way out.

### The three major test findings

All three came from the same question: if the production function returned a constant, would
the tagged test notice?

**T1/T2.** `LinkRepository.findReferences` and `findByType` were each replaced with `return []`
and the suite re-run. `[L03]`, `[L04]` and the unit `[L08]` stayed fully green; only `[L10]`
and `[M13]` caught it. Both tests supplied a value and asserted the same value arrived at a
fake host one call later — no link existed in either test, and `FakeHost.resolveLinks` returned
an array the test never populated. Both criteria are classified `integration` in
`docs/MILESTONE.md`, so they now run over the real router into the real store: a three-document
citation graph in which the edge touching neither end of the queried entity must not come back,
direction narrowing checked in both directions, type narrowing checked against a second type
over the same pair of endpoints, and `otherTitle` asserted because that is what the panel
renders. Re-running the same mutation now fails four of them. The workbench unit tests keep
the command wiring but assert what reached the panel, and `[L03]` resolves `shift+f12` through
`DEFAULT_KEYBINDINGS` rather than calling a command the criterion does not name.

**T3.** Thirteen tests carried `[T05]`; every one fed a plain string or a PDF.js text-item
array to `normalizeText` or `joinPdfTextItems`. No HTML fragment passed through anything,
because there was no HTML-to-text function in the codebase to test. Narrowing the tag's
description to match would have moved the goalposts — T05 is a milestone-1 criterion — so the
function was written: `extractHtmlText` in `@wr/document-model`. It is a scanner rather than a
regex sweep because archived HTML is hostile input and `/<[^>]*>/g` emits `b">text` as prose
given `<a title="a > b">text</a>`. Script and style content is skipped in its own tokenizer
state so `if (a<b)` is not read as markup, character references are decoded after tag removal
so escaped markup in prose survives, inline element boundaries add no whitespace (a space there
puts every anchor spanning a styled word out by one), and source line-wrapping folds while
`<pre>` keeps its structure. Twelve tests, including one asserting that the same sentence
extracted from HTML and from a PDF text layer normalizes identically — the invariant that makes
an anchor portable across representations.

### Minor findings left open, with reasons

- **T4, T5, T6** are weak assertions inside tags whose other tests are load-bearing.
  `NORMALIZATION_VERSION > 0` cannot fail except by editing the constant; the `[T07]`
  chunk-index comparison is vacuous if the chunker returns `[]`, but a sibling test at
  `packages/search/test/chunking.test.ts:75` supplies the length floor; the `[T04]` assertion
  uses `normalizeText` on both sides, which is separately pinned by literal expectations. Each
  is a test that adds nothing rather than one that gives false credit.
- **T7** — no `[M04]` test reaches the default `hashFileOnDisk` probe; every importer test
  injects a stub. It *is* exercised over real files by `tests/e2e/support/workspace.ts`, which
  asserts `filesMissing === 0`, but that seeding runs under `[M05]`.
- **T8** — `[M14]` round-trips a layout through the store and `[T10]` round-trips the
  serializer, but nothing covers the renderer code that joins them, and no E2E spec restarts
  the app. `docs/MILESTONE.md` classifies M14 as integration, so this is a coverage gap rather
  than a rule violation.
- **S5** and the `rrfile://` TOCTOU are recorded in the gaps list of `docs/SECURITY.md` so they
  are visible where the invariants are documented rather than only here.

---

## What was checked and found sound

Recorded because a report of only defects says nothing about coverage. Full evidence with
file:line citations is in the two lens reports.

- **Window flags.** One `BrowserWindow` construction site in the tree, with
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`. No
  `BrowserView`, `WebContentsView`, `openDevTools` or `<webview>` anywhere. No `webSecurity`,
  `allowRunningInsecureContent`, `nodeIntegrationInSubFrames` or `experimentalFeatures` in any
  source file. The built artefact in `out/main/index.js` matches the source, which matters
  because the verifier only greps `src/`. Proved at runtime, not by grep: `shell.spec.ts`
  asserts `require`, `module`, `process` and `electron` are `undefined` in the main world.
- **Preload.** 35 lines, one `exposeInMainWorld`, exactly two methods, neither of which lets
  the renderer name a channel. The built `out/preload/index.cjs` is equivalent. `subscribe`
  returns a real unsubscribe closure.
- **IPC.** Exactly three `ipcMain` references in the repository, all in `router.ts`. Validation
  order is structural check → own-property channel lookup (so `constructor` and `__proto__` are
  not channels) → zod `safeParse` → dispatch. No `passthrough`, `catchall` or `z.any()` in
  `shared-types` or the app. `toIpcError` collapses anything unrecognised to
  `{ code: 'INTERNAL' }` and maps `SQLITE_` to a generic database error. Outbound events are
  validated against `IPC_TOPICS`.
- **Path traversal via `rrfile://`.** `parseFileId` requires an empty pathname and matches the
  id against Crockford base32 *after* decoding, so `..`, percent-encoding, double-encoding,
  absolute paths and NUL bytes all fail. The surviving id is only ever a bound SQL parameter.
  `isInsideRoot` was verified by executing it, not by reading it: traversal, prefix collision
  and macOS case variance all return false, the last being a fail-closed false negative.
- **The renderer never receives a filesystem path.** Traced end to end: `DocumentFileRefSchema`
  omits `path` and requires an `rrfile://` url, `toDocumentFileRef` is the only construction
  site and re-parses through the schema, no other response schema carries a path, and no
  renderer source builds a URL.
- **Renderer boundary.** Zero forbidden imports across all six renderer packages and
  `apps/desktop/src/renderer`, checked at the manifest level too, with transitive re-export
  through `@wr/shared-types` and `@wr/document-model` checked rather than assumed.
- **Zotero is read-only.** The client is HTTP-only against `127.0.0.1:23119` with one call
  site, and its injected `fetch` type cannot express a `method` — a non-GET request is a type
  error, not a review question. No write API is imported anywhere in the adapter.
- **Fixtures are recorded, not invented.** The Zotero fixtures are genuine local-API envelopes
  parsed through the same schema the client uses; the fake is a `fetch`, so pagination, headers
  and error mapping all run for real. `tests/fixtures/sample-paper.pdf` is a real 3-page PDF
  genuinely parsed by `pdfjs-dist/legacy`.
- **The restart criteria really restart.** `Workspace.restart()` closes the database and opens
  a fresh connection against the same file; anything held in memory is gone by construction.
- **M08, M09, M10, M12, M14 are load-bearing.** Each was checked against "what if this returned
  a constant": `[M09]`'s premise assertion fails outright, `[M10]` is cross-checked against
  page text extracted independently in `beforeAll` rather than against the index that produced
  the answer, and `[M12]`, `[M08]` and `[M14]` each have a sibling test a constant cannot
  satisfy.
- **No tests that assert nothing.** A scan for `expect(true)`, `toBeTruthy()`, `.skip`,
  `.todo`, empty `catch {}` and snapshot assertions returned no hits; no test file lacks
  `expect`.

## Coverage shape

`apps/desktop/src` contains no `*.test.ts`. The renderer is covered by the Playwright specs;
the main process by `tests/integration/vertical-slice.test.ts`, which imports `services.ts`,
`handlers.ts` and `router.ts` directly and drives the real router with real zod validation.
This is deliberate and defensible, but it means `host.ts`'s `resolveLinks` has no unit coverage
and only incidental E2E coverage.

`packages/html-reader/src/index.ts` is a stub that throws `NotImplementedError` and exports
`IMPLEMENTED = false`. It is milestone-2 work (`docs/MILESTONE2.md`, W03) and is not claimed by
any milestone-1 criterion. It is named here so its absence is not mistaken for coverage: the
sandboxed-iframe treatment for archived HTML does not exist yet, and `docs/SECURITY.md` says so
in its own gaps list.

## Gates at the audited commit

`pnpm typecheck` 0 · `pnpm lint` 0 · `pnpm build` 0 · 361 unit tests in 23 files, 0 failures ·
11 E2E specs against a real Electron launch, 0 failures.
