# Next action

## Now

**Do not emit `<promise>MILESTONE_COMPLETE</promise>` yet, even though the verifier says so.**

`verify_completion.py` reports **117/117** and prints `MILESTONE COMPLETE` at `81f6530`. It is
wrong about the audit, and only about the audit: it checks that `reports/AUDIT.md` names a
commit *reachable from HEAD*, and the commit it names is `4420cea` — the milestone 2 one. That
file's own title is "milestones 1 and 2". **Nobody has read milestone 3.** The remaining work
is that audit, and the promise waits on it.

Everything else is done. Every milestone 3 criterion has a passing tagged test; gates are
typecheck ✓, lint ✓, 524 vitest ✓, 37 Playwright ✓, tree clean, HEAD pushed.

The audit brief is in `docs/LOOP.md`. Point it at the librarian, which is where the new risk
is. Places worth an adversarial read:

1. **`A03` is the load-bearing one.** The claim is that with agents off nothing touches the
   network. Try to falsify it: is there *any* path from a fresh launch to `materialise()`, to
   a spawn, or to `scheduler.start()`? The E2E asserts `<agentRoot>/wiki` never appears; ask
   whether that is the only observable.
2. **`agent:accept` writes a file and mints a document.** It is the one channel that writes
   outside the database. Check it cannot be made to write outside the workspace, and that a
   proposal decided twice cannot produce two documents.
3. **The workspace root is now a fixed `SwappableRoots` entry**, so `rrfile://` will serve
   anything under it. Is that the intended blast radius? `.runs/` staging lives under it too.
4. **Weak-assertion sweep on the new tags.** `A05` and `A10` are one Playwright test each;
   mutate the handler and confirm each actually fails.

## What the librarian is

`apps/desktop/src/main/agents/` — eight modules, all tested, all constructed by `services.ts`
as `services.agents`, and reached over nine `agent:*` channels through the one router.

- `settings.ts` — the switch and `agentDisclosure()`, which **counts the database** rather
  than reciting prose, so the disclosure cannot drift from what is sent.
- `workspace.ts` — the only way anything writes for the agent. Containment decided twice.
- `wiki-view.ts` — the database as crawlable markdown. `materialise()` takes no arguments and
  seals the tree `r-x`/`r--`, so **`remove()` owns deleting it** — plain `rm -rf` gets `EACCES`.
- `runner.ts` / `stream.ts` · `proposals.ts` (the gate) · `librarian.ts` · `schedule.ts`.
- Renderer: `renderer/librarian-panel.tsx`, the `librarian` sidebar, `activity-librarian`.

## Traps

- **The recorded transcript cannot produce a proposal.** `librarian-stream.jsonl` predates the
  front matter the task now asks for and cites the ids of the library it was recorded against.
  It proves the spawn and the stream. Tests stage proposals instead, through the real
  `AgentWorkspace` and the real `ProposalReader` — see `tests/e2e/support/librarian.ts`.
- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string. See `main/handlers.ts`.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- The E2E env is `WR_DATABASE_PATH`, `WR_ZOTERO_DATA_DIR`, `WR_MARKDOWN_ROOT`, `WR_AGENT_ROOT`,
  `WR_BACKGROUND` — all real runtime modes, no test-only branch in the app.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build the reviewer agent or hypotheses-as-entities — milestone 4. Show an
Electron window. Let the renderer send or receive a filesystem path. Emit the promise before
the audit.
