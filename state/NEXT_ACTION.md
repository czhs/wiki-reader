# Next action

## Now

**Milestone 6 is open — but a workflow in an interactive session is building it (started
2026-08-01).** If you are an autonomous loop reading this: stand by, don't start milestone-6
work, don't touch the tree. `docs/MILESTONE6.md` has the criteria; the researcher's
`Descision:` lines in `reports/DESIGN_GAPS.md` are the spec's voice. Center: the notebook
becomes paper-grade (blocks, LaTeX, excerpts), reading flows into notebooks, highlights appear
on the wiki with snippets, graph search-in-place, every calendar day rendered, a saved-page
zoom lever, discard vs delete, and a maintained feature guide with motion. `S01`–`S03`,
`E01`–`E03`, `V01`–`V04`, `I01`, `O01` are armed in the verifier.

**S01–S03 are green** (`tests/e2e/notebook-page.spec.ts`), 84 e2e and 733 unit tests passing.
The notebook page is now the journal's block editor promoted, not a second one: `blocks.tsx`
is the editor, `block-source.ts` (was `journal-blocks.ts`) is its pure half, and both surfaces
own only a markdown document. LaTeX is a vendored KaTeX in MathML, parsed back into React
elements — never an HTML string, never a CDN. An excerpt is a blockquote plus an
`annotation://` link (`packages/document-model/src/excerpt.ts`) with a real
`question-references-annotation` edge beside it; **E01 must reuse `excerptMarkdown`**, not grow
a second answer. `RenderOptions.internalLinks` is the chip that makes those links navigate, and
E01/E02 want the same mechanism. `notebook:changed` now carries `reason: 'page-drop'`.

Milestone 5 closed 2026-08-01: verifier 167/167, bundle 2026-08-01T00:46 installed.

**The swap, for whoever does it next.** `pnpm package` → `apps/desktop/release/mac-arm64/`, then
`mv /Applications/wiki-reader.app /Applications/.wiki-reader-superseded-<yyyymmdd-hhmmss>.app`
and `ditto` the fresh one in. Never delete: the researcher was running the old bundle (PID 7789)
at swap time and holds its inodes until they restart. Six superseded bundles are on disk at
~347M each, safe to remove once the app has been restarted.

## The keyboard, in one paragraph

Four families chosen by the *verb*: `Cmd+Shift+<letter>` goes to a page, `Cmd+P` goes to a file,
the function row follows links, `Cmd+Alt+<letter>` makes something. A page's letter is the first
letter of its name still free, left to right. `KeybindingRule.family` is a declared label, never
inferred from modifiers — `Cmd+Shift+W` closes a group and shares its modifiers with every page
chord. A new page adds one row to `DEFAULT_KEYBINDINGS` and appears on the help page, which is
rendered from `commands.all()` and `keybindings.all()` and can never be a hand-written sheet.
The rest is `state/DECISIONS.md`.

## Where things live

A unification sweep folded the duplicates onto what already existed. Before writing near them:

- **`graph-canvas.tsx` is all three graph surfaces' drawing.** `SceneNode`, `SceneViewportGroup`,
  and `useSceneGestures` — controlled, so the neighbourhood panel can persist its viewport per
  seed (`G01`) while the wiki page and the focused view keep theirs in the panel. `useSceneView`
  is that hook plus local state, and returns to rest when its subject changes.
- **`makeHighlight` and `SelectionBar` in `panels.tsx`** are the Highlight button for all three
  readers. A reader supplies the anchor and nothing else; building the anchor is the only part
  that is genuinely the reader's, because only the reader packages may touch its coordinates.
- **`Overlay` and `useCloseOnEscape` in `overlays.tsx`** are the sheet and the dismissal for the
  command list, the file palette and the link picker.
- **`tests/integration/support/workspace.ts`** is the harness. `new IntegrationWorkspace(prefix,
  overrides)`; `overrides` is handed the temp directory and runs on every open, so a restart gets
  the same wiring. `local-files.test.ts` keeps its own, and says why.
- **`defaultSidebars()`** parses `SidebarStateSchema`; do not write the defaults out again.

## Also open

Fifteen design gaps in `reports/DESIGN_GAPS.md`, found by driving every surface and looking at
it. Proposals, not work items. Gaps 9–15 are **Vision alignment** — not "is this awkward" but
"does the criterion's letter deliver what it was asked for". The two that most change what the
app *is*: the wiki draws files and has never drawn a highlight, and nothing anywhere carries
reading into a notebook.

Twenty-five milestone-5 minors and eleven milestone-4 ones in `reports/AUDIT.md` and
`state/experiment_state.json`. The three worth reaching for first: a picture dropped while a
block editor is open discards the unsaved text; the ledger truncates at 400 rows in silence;
neither half of the `H01` transport (`document:getSnapshotText`, `reportSnapshotSelection`) has
a unit or integration test. Seven milestone-3 minors in `docs/SECURITY.md`; `11` (a child
ignoring SIGTERM wedges the librarian) is the only one that breaks a feature.

## Traps

- **`reports/AUDIT.md` is parsed by first match.** The milestone-5 section is at the top and is
  the only one carrying `Audited-commit:`/`Audited-milestone:`; the older sections say
  "Audited commit (milestone N):" so they cannot answer for it. Never write the phrase
  "unresolved critical/major" in that file.
- **Never `git checkout <file>` to undo a probe.** Work in progress is not staged, and it
  takes the file back to HEAD. `git add -A` first, then `git checkout-index -f <file>`.
- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **Playwright's hit-testing is wrong inside the scaled archive frame.** Compute the point from
  `data-snapshot-scale` and click with `page.mouse`; `locator.click` lands on `<body>`.
- **Keys reach the renderer over CDP**, so a menu accelerator cannot eat one in the E2E suite —
  which is why `U01`'s other half is asserted on the menu template in `main/menu.test.ts`.
- **A failing Playwright test is very slow here.** All 81 green ≈ 2.5 min; one failure pushes a
  single file past 15.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- **The verifier needs a clean tree and HEAD on `origin/main`**, so it can only go green after
  the checkpoint commit is pushed. A full run is ~170s.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 5. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
