# Next action

## Now

**Milestone 3 is complete.** `scripts/verify_completion.py` exits 0 at 125/125, the independent
audit is in `reports/AUDIT.md` with no critical or major finding left open, the tree is clean
and HEAD is on `origin/main`.

Nothing in milestone 3 is left to build. **Do not start milestone 4** — `docs/MILESTONE4.md` is
written and its tags are deliberately not armed in the verifier; arming them would make the
gate demand milestone 4 of a loop working on milestone 3.

## If this loop keeps running

The seven minor audit findings are open by choice and recorded in `docs/SECURITY.md` and in
`reports/AUDIT.md`. In the order they are worth doing:

1. **11 — a child that ignores SIGTERM wedges the librarian permanently.** `runner.ts:175-215`
   sends SIGTERM on timeout but settles only on `close` or `error`, so the entry stays in
   `#active`, `busy` stays true, and every later pass is refused as `already-running`. Wants a
   SIGKILL escalation and a settle-on-timeout. The only one of the seven that breaks the
   feature outright.
2. **13 — no cap on harvested proposals.** `proposals.ts:135,147` lists every `.md` and reads
   each whole into memory; the body is stored uncapped while the run summary is capped at 4000.
3. **14 — `A03`'s E2E observable is sound by ordering, not construction.** `<agentRoot>/wiki`
   catches a spawn only because `pass()` materialises before spawning. Assert the spawn itself.
4. **8 — the `rrfile://` allow-list holds the whole agent workspace**, not just `notes/`. Not
   reachable today; narrowing it is a change to the root wiring in `services.ts:150-157`.
5. **10 — the child inherits the whole main-process environment.** Wants an allow-list, best
   done with a live `claude` to test against.
6. **12 — `WR_AGENT_EXECUTABLE`** names an arbitrary binary to spawn. Same class as
   `WR_DATABASE_PATH`.
7. **15 — dead clause** at `workspace.ts:220`. One line.

## What the audit changed, worth not undoing

- **`agentProgress` takes roots and reduces every path in a progress line.** Both free-text
  fields, not just tool targets — the model narrates its own working directory in prose.
- **`LibrarianService` owns `busy`, not the runner.** A pass is not only its child process;
  `materialise()` runs first and is the long part.
- **`accept` shares its in-flight promise per proposal id.** A double click is one intention.
- **Switching agents off removes the wiki copy.** `README.md` and the disclosure are read as
  promises about switching back off.

## Traps

- **A race test that only fails half the time is not a guard.** The accept race reproduced 3
  times in 6 as a plain `Promise.allSettled` pair. It is held on a gate now — and the first
  gate that made it deterministic released its writer too early to open the window at all, so
  check both directions by mutation, never just the green one.
- **A failing Playwright test is very slow here.** A green suite is ~2 minutes; one failure can
  push a file past 15. Long durations mean failures, not a hang.
- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build any of milestone 4. Show an Electron window. Let the renderer send or
receive a filesystem path.
