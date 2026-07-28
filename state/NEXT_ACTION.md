# Next action

## Now

**The milestone-3 audit landed. Work its findings, then write `reports/AUDIT.md`.**

The audit is `reports/audit-m3-security.md` — a read-only trace of the librarian surface at
`f6fbede`. 15 findings: 1 critical, 6 major, 8 minor. **Unresolved critical or major findings
block the promise**, so the majors are the work. Do not emit the promise until `AUDIT.md` is
written at a commit that has them resolved.

## Resolved

- **Finding 1 (critical) — `agent:progress` published absolute filesystem paths** to every
  renderer and painted them on screen, breaking `CLAUDE.md`'s "the renderer never receives or
  builds a filesystem path". Both free-text fields leaked: tool targets (`Read` takes an
  absolute `file_path`) *and* message prose (the model narrates its own cwd — fixture line 43).
  `withoutFilesystemPaths` in `main/paths.ts` reduces each absolute path to root-relative, or
  to its basename when it is outside every root. `agentProgress` takes the roots;
  `AgentServices.progressRoots` names them once so a third publisher cannot forget.
  `tests/integration/agent-progress.test.ts` asserts no absolute path survives the *real*
  recorded transcript — it caught 9 leaks before the fix.

## Remaining blockers, in the order to take them

2. **The wiki copy is never removed** (`wiki-view.ts:136-141`). `WikiView.remove()` has no
   production caller; turning agents off does not call it. `README.md:16` and the disclosure
   read as promises that it does. Full text of every document, highlight, question and journal
   entry sits at `<userData>/agent/wiki` forever. Call it from `agent:enable{false}` and close.
3. **`agent:accept` TOCTOU** — a double accept mints **two documents** for one file.
   `agentRuns.accept` is guarded by `WHERE status='pending'`; `documents.create` is not, and
   runs before it across two awaits. `upsertByPath` then orphans the first. Reachable by
   double-clicking Accept (`librarian-panel.tsx:268-275` has no `disabled`).
4. **`agent:run` race spans `materialise()`** — `runner.busy` goes true only *after* the spawn,
   so two calls both pass the guard, both rebuild the wiki on one root (one `rm -rf`ing while
   the other seals), and two `claude` processes spawn.
5. **`A02` asserts a door the agent does not use.** `AgentWorkspace` bounds writes the *app*
   makes; the spawned `claude` writes with its own tools. Real containment is cwd + a
   `chmod`-sealed `--add-dir` + the CLI's permission model. Have `fake-claude.mjs` *attempt* an
   escape.
6. **`A13` passes on the wrong cause.** The recorded run did write a finding; it landed in the
   run-directory root and `harvest` only reads `.runs/<id>/proposals/`. That is a harvest miss
   described in the test comment as a quiet pass.
7. **No test harvests a real agent's output.** Every proposal is hand-staged front matter, so
   the seam finding 6 shows is broken is uncovered.

Minors 8–15 are listed in `state/experiment_state.json` under `audit.milestone_3`. They do not
block, but 9 (`docs/SECURITY.md` has no milestone-3 content, and two of its lines are now false)
is cheap and worth doing with the rest.

`reports/AUDIT.md` still names `4420cea`, a milestone-2 commit. It needs `Audited-commit: <sha>`
naming a real ancestor of HEAD, a `## Findings` section, and no placeholder text.

## Traps

- **A failing Playwright test is very slow here** (screenshot + error context). A green suite is
  ~2 minutes; one failure can push a file past 15. Long durations mean failures, not a hang.
- **The recorded transcript cannot produce a proposal** — it predates the front matter the task
  asks for. See `tests/e2e/support/librarian.ts`. Finding 7 is about closing exactly this.
- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string. See `main/handlers.ts`.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- Dockview hides an inactive tab's × until hover; it relayouts from a ResizeObserver, so poll.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build any of milestone 4. Show an Electron window. Let the renderer send or
receive a filesystem path. Emit the promise with a major finding open.
