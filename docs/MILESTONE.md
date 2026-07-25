# Milestone 1 — acceptance criteria

Every criterion below is machine-verified by `python3 scripts/verify_completion.py`.

## How verification works

A criterion is satisfied only when **at least one automated test whose title contains the
criterion tag passes**. Tags are written in square brackets at the start of the test title:

```ts
it('[M03] applies every migration on a fresh database', () => { /* ... */ });
```

The verifier runs the full test suite with a JSON reporter, then asserts that each tag below
appears in at least one passing test and in zero failing tests. Flipping a status flag in a
state file does not satisfy a criterion — the test must exist and pass.

`[E2E]`-marked criteria require a real Electron launch through Playwright
(`pnpm test:e2e`). They may not be satisfied by a mocked renderer.

## Vertical slice criteria

| Tag | Criterion | Kind |
|-----|-----------|------|
| M01 | Electron application launches correctly | E2E |
| M02 | Dockview workspace renders | E2E |
| M03 | SQLite database and migrations initialize | unit |
| M04 | Zotero items can be imported through the local API | integration |
| M05 | Imported items appear in the library sidebar | E2E |
| M06 | A Zotero PDF attachment can be opened in a tab | E2E |
| M07 | Two PDFs can be opened side by side | E2E |
| M08 | Reading position is persisted | integration |
| M09 | PDF text is extracted and added to FTS5 | integration |
| M10 | Search results can open the correct PDF page | integration |
| M11 | A PDF text selection can be highlighted | E2E |
| M12 | The highlight survives application restart | integration |
| M13 | A note can be attached to the highlight | integration |
| M14 | The workspace layout survives restart | integration |

## Link-navigation criteria

| Tag | Criterion | Kind |
|-----|-----------|------|
| L01 | Internal links between notes, annotations, and documents | unit |
| L02 | F12 opens the target under the cursor | E2E |
| L03 | Shift+F12 lists all references to the current entity | integration |
| L04 | A command lists all links of the selected link's type | integration |
| L05 | A command goes from an annotation to its parent document | unit |
| L06 | Back and forward navigation history | unit |
| L07 | Open-current and open-to-side actions | unit |
| L08 | References panel remains open while navigating results | E2E |
| L09 | Centralized command and keybinding registry | unit |
| L10 | Persistence tests for links and navigation targets | integration |

## Spec-mandated test coverage

These tags cover the test list in `docs/SPEC.md` that is not already implied above.

| Tag | Coverage |
|-----|----------|
| T01 | Database migrations (forward, idempotent, foreign keys on) |
| T02 | Zotero item mapping |
| T03 | Duplicate-import prevention |
| T04 | PDF anchor serialization round-trip |
| T05 | HTML text normalization |
| T06 | Text quote anchor resolution (exact, shifted, ambiguous, missing) |
| T07 | Search indexing |
| T08 | Search result location mapping |
| T09 | Internal link parsing (`document://`, `annotation://`, `note://`) |
| T10 | Workspace layout serialization |

## Non-test gates

The verifier additionally requires:

1. `pnpm typecheck` exits 0 with zero errors.
2. `pnpm lint` exits 0 with zero warnings.
3. No `any` type annotation in `packages/*/src` or `apps/desktop/src`
   (`as unknown` narrowing and `// eslint-disable` escapes are counted and reported).
4. Renderer boundary: no import of `electron`, `better-sqlite3`, `@wr/database`, or
   `@wr/zotero-adapter` from renderer-side packages.
5. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` present in the
   BrowserWindow construction, and no `webSecurity: false` anywhere.
6. `README.md` and `THIRD_PARTY_NOTICES.md` exist and cover the required sections.
7. Working tree clean; HEAD commit present on `origin/main`.
8. `state/experiment_state.json` parses and reports `phase: "milestone-1-complete"`.

## Explicitly out of scope for milestone 1

Deferred until after the slice works. Not verified, and not a blocker:

- Archived HTML ingestion and the `ArticleReaderPanel`
- Embeddings / `sqlite-vec` semantic search
- EPUB support
- Bidirectional Zotero synchronization
- User-editable keybindings JSON file (registry must support it; UI not required)

---

# Milestone 2 — the wiki (scope recorded, criteria not yet written)

**Read this before emitting any completion promise.**

On 2026-07-25 `docs/SPEC.md` was amended to merge Field Station's wiki-reader brief (see
`state/DECISIONS.md`). The specification now describes substantially more product than the
milestone-1 criteria above cover. **Passing every criterion above does not mean the
specification is implemented.** It means the original vertical slice works.

Nothing in the milestone-1 table exercises any of the following, all of which SPEC.md now
requires:

- **Markdown as a first-class annotatable document type** — the corpus's primary format
- **The wiki corpus model** — projects, ground truth vs `**/claude/` agent workspace
- **Scoped ingestion** — a *named* Zotero collection, a URL list, hand-dropped files
- **`[[wikilinks]]` and `#tags`** — parsed into derived typed links, with re-indexing that
  preserves manually created links
- **Six-color highlights** with the comment / color / delete popover
- **The librarian and reviewer agents**, and the agent tool boundary that structurally refuses
  writes outside the agent workspace
- **The bulletin board**
- **The graph view** — promoted by the merge from a deferred stub to a required feature

Milestone 2 criteria have not been written. Until they are, `scripts/verify_completion.py`
verifies milestone 1 only, and a green verifier is **not** evidence that the product matches
`docs/SPEC.md`.

Do not silently widen the milestone-1 criteria to cover this scope, and do not narrow SPEC.md
to match the criteria. Write milestone-2 criteria as a deliberate act, in the order above,
with the agent tool boundary first — it is the one item where a bug damages the user's corpus
rather than merely failing a test.
