# Next action

## Now

**Two things left: seven usability fixes, then the milestone-3 audit. Do not emit the promise
until both are done.**

## Usability — `U01`–`U07`, all live at 117/117

Found by a person using the app after every gate went green. Details and causes are in
`docs/MILESTONE3.md`; the short version:

- **`U01`/`U02` first — they share one cause.** There is no close command anywhere: no
  `Ctrl+W` binding, no `wr.closeTab` in `COMMAND_IDS`. The keystroke falls through to Chromium,
  which closes the window and takes the app down. Add the command; the split-group case and
  both criteria follow from it.
- **`U04` is the severe one.** The four left sidebars are independent booleans rendered as
  siblings, so opening them all leaves **252px of a 1440px window** for the document. An
  activity bar switches the single left sidebar; it does not stack. Measured, not estimated.
- `U03` a long title pushes the tab's × out of reach once several tabs share the strip.
- `U05` `openLinkGraph` seeds from the current subject and has no "everything" form, so the
  always-enabled button silently does nothing with an empty workspace.
- `U06` no comment affordance in the reader — `[W11]`'s popover is the only path and nothing
  points at it.
- `U07` "Run a pass now" is disabled until the librarian is enabled and never says so.

## Then the audit

**The verifier says complete and is wrong about exactly one check.**

`verify_completion.py` reports **116/124** — the seven `U` criteria above have no tests yet.
Every `C`/`Q`/`J`/`A` criterion passes: typecheck ✓, lint ✓, 524 vitest ✓, 37 Playwright ✓.

When those seven are green it will print `MILESTONE COMPLETE`, **and it will be wrong about one
check**. Its audit gate gets satisfied by `reports/AUDIT.md` naming a commit reachable from
HEAD; that commit is `4420cea`, a milestone 2 one, and the file's own title is "milestones 1 and
2". **Nobody has read milestone 3.** Do not take the promise on that.

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

`apps/desktop/src/main/agents/` — nine modules, all tested, all constructed by `services.ts`
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

Weaken the verifier. Build any of milestone 4 — `docs/MILESTONE4.md` is written and its tags are
deliberately **not** armed in the verifier yet; arming them now would make it demand milestone 4
of a loop working on milestone 3. Finish `U01`–`U07` and the audit first. Show an
Electron window. Let the renderer send or receive a filesystem path. Emit the promise before
the audit.
