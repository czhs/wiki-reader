# Milestone 1 — the vertical slice

A criterion is satisfied only when an automated test whose title contains its tag passes:

```ts
it('[M03] applies every migration on a fresh database', () => { … });
```

`scripts/verify_completion.py` re-runs the suite and re-parses it every time. Flipping a status
flag in a state file satisfies nothing. `[E2E]` criteria need a real Electron launch through
Playwright and may not be satisfied by a mocked renderer.

## Vertical slice

| Tag | Criterion | Kind |
|-----|-----------|------|
| M01 | Electron application launches correctly | E2E |
| M02 | Dockview workspace renders | E2E |
| M03 | SQLite database and migrations initialize | unit |
| M04 | Zotero items import through the local API | integration |
| M05 | Imported items appear in the library sidebar | E2E |
| M06 | A Zotero PDF attachment opens in a tab | E2E |
| M07 | Two PDFs open side by side | E2E |
| M08 | Reading position is persisted | integration |
| M09 | PDF text is extracted and added to FTS5 | integration |
| M10 | Search results open the correct PDF page | integration |
| M11 | A PDF text selection can be highlighted | E2E |
| M12 | The highlight survives restart | integration |
| M13 | A note can be attached to the highlight | integration |
| M14 | The workspace layout survives restart | integration |

## Link navigation

| Tag | Criterion | Kind |
|-----|-----------|------|
| L01 | Internal links between notes, annotations, documents | unit |
| L02 | F12 opens the target under the cursor | E2E |
| L03 | Shift+F12 lists all references to the current entity | integration |
| L04 | A command lists all links of the selected link's type | integration |
| L05 | A command goes from an annotation to its parent document | unit |
| L06 | Back and forward navigation history | unit |
| L07 | Open-current and open-to-side actions | unit |
| L08 | References panel stays open while navigating results | E2E |
| L09 | Centralized command and keybinding registry | unit |
| L10 | Persistence for links and navigation targets | integration |

## Spec-mandated coverage

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
| T09 | Internal link parsing |
| T10 | Workspace layout serialization |

## Non-test gates

`pnpm typecheck` and `pnpm lint` exit 0 · no `any` in first-party source · renderer imports no
main-process code · `contextIsolation`/`nodeIntegration`/`sandbox` correct and no
`webSecurity: false` · required docs present · working tree clean and HEAD on `origin/main` ·
`experiment_state.json` reports `phase: "milestone-1-complete"`.

## Out of scope

Embeddings / `sqlite-vec`, EPUB, bidirectional Zotero sync, user-editable keybindings JSON
(the registry must support it; no UI required).

---

# Milestone 2

**[`docs/MILESTONE2.md`](MILESTONE2.md)** — 10 criteria (`W01`–`W10`): markdown reading, saved
web pages in their original form, `[[wikilinks]]`, and the graph.

Those tags are inert; the verifier hardcodes its set and doesn't read either milestone file, so
milestone 1 is unaffected. Everything else in `docs/SPEC.md` — the librarian, bulletin board,
corpus model, scoped ingestion — is later. Don't build it, and don't narrow SPEC.md to match
the criteria.
