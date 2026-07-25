# Mission

Build **wiki-reader**: a local-first desktop research reader. Import from Zotero; read PDFs,
saved web pages and markdown in a Dockview workspace; highlight with anchors that survive
re-render; link things together; see the connections in a graph.

Spec: `docs/SPEC.md` (grep it, don't read it whole). Criteria: `docs/MILESTONE.md`, then
`docs/MILESTONE2.md`.

You are inside a Ralph loop on macOS. Do not start another loop.

# Every iteration

Read `state/NEXT_ACTION.md` first. It says what to do next; trust it over re-surveying the
repo. Then work the criteria in order.

Write the test with the implementation. A criterion with code but no passing tagged test is
not done. Tag tests with the criterion ID: `it('[M08] restores the saved page', …)`.

# Turn budget — hand off before you hit it

Hard cap of **500 turns**, enforced by the harness. Hitting it kills the session instantly,
mid-action, with no closing sequence. But 500 is a ceiling, not a target — **end the session
yourself, deliberately, well before it.**

Hand off when you reach a natural stopping point: a criterion is done and checkpointed, a gate
is green again, or the next piece of work is clearly separable. Finish the checkpoint, make
sure `state/NEXT_ACTION.md` would let a stranger continue, and stop.

Prefer handing off to grinding on. Your context fills as you work, and a fresh session reading
a good `NEXT_ACTION.md` reasons better than a long one carrying hundreds of turns of history.
Two clean iterations beat one exhausted one. The loop restarts you immediately; ending early
costs nothing.

Don't hand off mid-refactor, with a red gate, or with uncommitted work.

**Checkpoint constantly.** After each coherent unit of work — a passing test, a restored gate
— do all of this before starting anything else:

1. Run the narrowest gate that proves it
2. Update `state/experiment_state.json` (write temp, rename) and `state/MILESTONE_STATUS.json`
3. Rewrite `state/NEXT_ACTION.md` (under 50 lines) so a fresh session resumes from exactly here
4. Append one record to `state/iteration_ledger.jsonl`
5. `git commit`, then **`git push` immediately**

Never go more than ~15 turns without a checkpoint. Never leave a commit unpushed. Never
checkpoint a broken tree — drive to coherence or revert.

# Never steal the foreground

You run on a machine someone is using. The E2E harness sets `WR_BACKGROUND=1`: the window is
never shown and never takes focus. Don't bypass it, don't call `focus()` or `shell.open*`,
don't run `pnpm dev`. Playwright drives over CDP and needs no focus.

Long commands run in the background with output to `logs/`.

# Toolchain

Node is pinned in `.nvmrc` (20.19.3); pnpm 9.15.4 via corepack. `loop.sh` verifies this before
iteration 1. If the database tests fail en masse, it is the Node ABI, **not** the code — fix
the toolchain, don't touch the database packages.

# Rules

- TypeScript strict. No `any`. No `eslint-disable` to hide a real error.
- Never weaken `scripts/verify_completion.py`. Strengthening it is fine.
- Don't stub core behaviour and call it done. A stub throws and says what's missing.
- No fake data paths where real integration is possible. Fixtures are recorded, never invented.
- Renderer packages never import `electron`, `better-sqlite3`, `@wr/database`, or
  `@wr/zotero-adapter`.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Every IPC payload
  validated with zod in the single router. File bytes reach the renderer only via `rrfile://`.
- Archived HTML is hostile input: sandboxed, scripts off, navigation blocked.
- Never modify `~/Zotero/zotero.sqlite`. Never commit user library data or a populated database.
- Build only what `docs/MILESTONE2.md` lists. The rest of `docs/SPEC.md` is later.

# Commands

```bash
pnpm test          # vitest
pnpm test:e2e      # playwright + real Electron
pnpm typecheck
pnpm lint
python3 scripts/verify_completion.py
```

# Done

Emit `<promise>MILESTONE_COMPLETE</promise>` only after `verify_completion.py` exits 0. That
requires the independent audit, a clean tree, and HEAD pushed to `origin/main`.

The audit brief, the blocked-by-something-external protocol, and the ledger record shape are
in `docs/LOOP.md`. Read it when you need it, not every iteration.
