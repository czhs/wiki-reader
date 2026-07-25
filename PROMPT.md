# Mission

Build **wiki-reader**, a local-first desktop research reading application that imports
documents from Zotero and provides a VS Code-style reading workspace.

The complete frozen specification is `docs/SPEC.md`. The acceptance criteria for the current
milestone are `docs/MILESTONE.md`. Read them rather than guessing at requirements.

You are operating autonomously inside an existing Ralph loop on:

- macOS (Darwin), Apple Silicon.
- Node 20+ with pnpm via corepack.
- Zotero 7 installed locally, with a real user library.
- An existing Git repository on branch `main`.
- Git remote `origin` = `https://github.com/czhs/wiki-reader.git`.

Continue until the complete milestone-1 vertical slice, its tests, its documentation, and its
independent audit are finished.

Do not declare success merely because code has been written, a package compiles, a dev server
starts, one panel renders, a subset of criteria passes, or the application "looks right".

Only output:

```text
<promise>MILESTONE_COMPLETE</promise>
```

after `python3 scripts/verify_completion.py` exits successfully and every mandatory criterion
in `docs/MILESTONE.md` is satisfied.

If completion is blocked by an external requirement, create `BLOCKED.md`, preserve all
resumable state, and do not emit the completion promise.

---

# Ralph-loop execution rules

You are already inside a Ralph loop. Do not invoke another Ralph loop from within this run.

The loop may re-present this prompt many times. Each iteration must reconstruct state from
files rather than from prior conversational memory. Treat conversation context as ephemeral.

## Turn budget — you are killed without warning

Each iteration runs under a hard cap of **100 assistant turns** (`--max-turns 100` in
`loop.sh`). When you reach it the session is terminated instantly, mid-action, mid-tool-call.
There is no warning, no grace period, and no opportunity to save anything.

You will almost certainly hit this cap. That is normal and expected — the cap exists to keep
context small, not to signal failure. What matters is that being killed costs nothing, because
everything of value was already written to disk and pushed.

Assume **every turn may be your last**. Never hold work in flight that a sudden kill would
lose. Do not save bookkeeping for the end; there is no end.

Evidence this is real: across the first 24 iterations under a 45-turn cap, 20 died at the cap
and 4 died on connection errors. Zero ended cleanly. Because state updates and `git push` were
deferred to a closing sequence that never ran, `state/` went 24 iterations without a single
write, the ledger held one record, and six commits sat unpushed. Do not repeat that pattern.

## Beginning of every iteration

1. Read `CLAUDE.md`.
2. Read `state/experiment_state.json`.
3. Read `state/NEXT_ACTION.md`.
4. Read the last entry of `state/iteration_ledger.jsonl`.
5. Read `state/MILESTONE_STATUS.json` to see which criteria are already verified.
6. Determine the single most useful next action.
7. Do not repeat work already marked verified.

Do not scan the entire repository or reload every log on each iteration. Do not re-read
`docs/SPEC.md` in full when you only need one section — grep it.

## Work in checkpoints — bookkeeping is continuous, never deferred

Bookkeeping is not a closing phase. It is the last step of every unit of work, performed many
times per session.

A **checkpoint** is the smallest amount of work that leaves the repository coherent: one
package implemented, one criterion's tagged test passing, one bug fixed, one gate restored to
green. The moment you reach one, before starting anything new:

1. Run the narrowest gate that proves it — the specific test file, or `pnpm test` /
   `pnpm typecheck` when the change is broad.
2. Atomically update `state/experiment_state.json` (write temp, validate, fsync, rename).
3. Update `state/MILESTONE_STATUS.json` for every criterion whose status changed.
4. Rewrite `state/NEXT_ACTION.md` so a fresh session could resume from exactly this point.
5. Append one record to `state/iteration_ledger.jsonl`.
6. `git commit`, then **`git push origin main` immediately**.

Then begin the next checkpoint. Repeat until the milestone is done or the turn cap kills you.

Rules:

- Never let more than ~15 turns pass without checkpointing.
- Never leave a commit unpushed. An unpushed commit is lost work the moment the session dies.
- If a checkpoint comes due mid-refactor, drive to coherence or revert — do not checkpoint a
  broken tree, and do not skip the checkpoint to keep going.
- Never batch several units of work and checkpoint once at the end. That is the exact failure
  this rule exists to prevent.
- Do not emit the completion promise unless the verifier passes.

The ledger takes **one record per checkpoint**, not one per iteration. Many records per
session is correct and expected.

Ledger record shape:

```json
{
  "checkpoint_id": "...",
  "iteration_hint": "...",
  "started_at": "...",
  "finished_at": "...",
  "phase": "...",
  "actions_taken": ["..."],
  "criteria_advanced": ["M03"],
  "artifacts_created": ["..."],
  "errors": ["..."],
  "next_action": "...",
  "git_commit": "...",
  "pushed": true,
  "state_version": 1
}
```

## Never steal the foreground

You are running unattended on a machine the user is actively working on. Nothing you do may
take over their screen, focus, or keyboard. A test run that raises a window over what someone
is typing into is a defect, no matter how green it is.

- Launch the app in background mode: the E2E harness sets `WR_BACKGROUND=1`, under which the
  main process **never shows the window at all** — not even inactively — and on macOS sets
  `setActivationPolicy('accessory')` plus `app.dock.hide()`. A window that merely avoids
  taking focus is still a window on the user's desktop, and one per spec is spam. Never
  remove this, and never add a launch path that bypasses it.
- Never call `focus()`, `moveTop()`, `setAlwaysOnTop()`, `app.focus()`, or `shell.openPath`
  / `shell.openExternal` / the `open` command in automated runs.
- Do not start `pnpm dev`; it opens a foreground window and stays running. Build and drive
  the built bundles instead, which is what the E2E suite already does.
- Playwright drives the renderer over CDP, which injects input without OS focus. If a spec
  seems to need a foreground window to receive keyboard or mouse input, the spec is wrong —
  use `page.keyboard` / `page.mouse` rather than raising the window.
- Long-running commands belong in the background with output redirected to `logs/`. Never
  leave a command in the foreground waiting for a human.

If you ever find yourself reaching for something that would put a window in front of the
user, stop and find the background equivalent.

## Avoid rapid empty iterations

Do not busy-poll. If a long build, install, or E2E run is in flight, wait on it rather than
re-checking every few seconds. A slow but healthy `pnpm install` or Electron build is not a
reason to kill and restart it.

If the only remaining action is a long wait, write the number of seconds to `state/WAIT_HINT`
and end the iteration.

---

# Context and memory management

## Required files

```text
CLAUDE.md
state/
  experiment_state.json
  MILESTONE_STATUS.json
  NEXT_ACTION.md
  DECISIONS.md
  iteration_ledger.jsonl
docs/
  SPEC.md
  MILESTONE.md
  ARCHITECTURE.md
  SECURITY.md
  IPC.md
  DATABASE.md
  ZOTERO.md
  FAILURES.md
  HANDOFF.md
reports/
  AUDIT.md
  completion_verification.json
scripts/
tests/
```

## `CLAUDE.md`

Keep below approximately 150 lines. Durable project invariants only: objective, repository
layout, commands, where canonical state lives, security invariants, Git remote expectation,
completion rule, instruction to read state files at each new context.

Do not turn `CLAUDE.md` into a chronological log.

## `state/experiment_state.json`

Canonical machine-readable project state: schema version, current phase, criteria status,
package build status, active blockers, dependency versions, last verified commit, exact next
action. Use atomic updates. Never leave partially written canonical state.

## `state/MILESTONE_STATUS.json`

One entry per criterion tag from `docs/MILESTONE.md`:

```json
{
  "M03": {
    "status": "verified",
    "test_titles": ["[M03] applies every migration on a fresh database"],
    "verified_at": "...",
    "notes": ""
  }
}
```

Allowed statuses: `not_started`, `in_progress`, `implemented_untested`, `verified`, `blocked`.

This file is a cache for your own planning. It is **not** evidence. The verifier ignores its
claims and re-runs the tests.

## `state/NEXT_ACTION.md`

Below 50 lines. What is happening now, what was last verified, the next exact action, the
command a fresh session should run, and what must not be repeated.

## `state/DECISIONS.md`

Concise engineering decisions: date, decision, evidence, alternatives considered, reason,
whether frozen. Do not duplicate routine status here.

## Context-size discipline

Never paste full build logs, full `pnpm install` output, or full test output into context. Use
`tail -n 100`, `grep`, `rg`, `jq`. Inspect the smallest relevant portion of a file. Redirect
verbose output to timestamped files under `logs/`.

Subagents must write detailed results to repository files and return only short summaries.

---

# Startup preflight (fail fast)

On the first iteration, before implementation work:

1. `node --version` >= 20.11 and `pnpm --version` resolves.
2. Git branch is `main` and `git ls-remote origin` succeeds.
3. `docs/SPEC.md` and `docs/MILESTONE.md` exist and are readable.
4. Zotero reachability is probed and the result recorded in `state/experiment_state.json`:
   - `http://127.0.0.1:23119/connector/ping` -> is Zotero running?
   - `http://127.0.0.1:23119/api/users/0/items?limit=1` -> is the local API enabled?
5. Free disk capacity measured.

**Known environment condition:** at project start the Zotero local API returned HTTP 403
because "Allow other applications on this computer to communicate with Zotero" was not enabled
in Zotero Settings -> Advanced. If it still returns 403, that is a *user action*, not a code
bug. Record it in `BLOCKED.md` only if it is the sole remaining blocker for M04. Continue
implementing everything that does not depend on live Zotero data, and keep the Zotero
integration tests runnable against recorded API fixtures so they are not blocked by it.

---

# Implementation rules

Follow `docs/SPEC.md`. In addition:

- Work criterion by criterion, in the order given in `docs/MILESTONE.md`, except where a
  dependency forces otherwise.
- Write the test for a criterion together with the implementation. A criterion with an
  implementation but no passing tagged test counts as incomplete.
- Tag tests with the criterion ID in the title: `it('[M08] restores the saved page', ...)`.
- Keep TypeScript strict. Do not introduce `any`. Do not add `eslint-disable` to silence a
  real type error.
- Do not stub core behavior and mark it complete. A stub is only acceptable for items listed
  as out of scope in `docs/MILESTONE.md`, and must throw a clear "not implemented" error.
- Do not create fake data paths when real integration is feasible. Zotero fixtures must be
  recorded from the real local API shape, not invented.
- Add structured logging around ingestion, extraction, and indexing. Do not silently swallow
  failures.
- Never weaken `scripts/verify_completion.py` to make it pass. Strengthening it is allowed.
  If a criterion is genuinely mis-specified, record the argument in `state/DECISIONS.md` and
  change `docs/MILESTONE.md` explicitly, not silently.
- Never commit user library data, PDFs from the real Zotero storage directory, or a populated
  application database.

## Security invariants (never regress)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- No `webSecurity: false`, no `allowRunningInsecureContent`, no remote module.
- The preload exposes exactly one typed `invoke` plus one `subscribe`. No raw filesystem,
  database, shell, or arbitrary IPC.
- Every IPC payload is validated at the main-process boundary before dispatch.
- Archived HTML renders script-disabled in a sandboxed iframe with a restrictive CSP, no Node,
  and blocked navigation.
- File bytes reach the renderer through the custom `rrfile://` protocol, which resolves an
  internal file ID through the database and refuses paths outside the allowed roots. The
  renderer never receives or constructs a filesystem path.

---

# Testing

Unit and integration tests run under Vitest. E2E tests run under Playwright driving a real
Electron build.

Required commands:

```bash
pnpm test          # vitest run (unit + integration)
pnpm test:e2e      # playwright, real Electron
pnpm typecheck
pnpm lint
```

Tests must be deterministic. Use a temporary directory for each database test. Do not depend
on test execution order. Do not write to the user's real Zotero directory under any
circumstance — tests that touch Zotero read only, through the local API or recorded fixtures.

---

# Independent audit

Before emitting the completion promise, dispatch a subagent as an independent auditor with
`docs/SPEC.md`, `docs/MILESTONE.md`, the source tree, the test suite, and
`reports/completion_verification.json`.

The auditor must attempt to falsify the claim that milestone 1 is complete, specifically
checking for: tests that assert nothing meaningful, criteria satisfied by mocks where real
integration was feasible, security invariants that regressed, `any` reintroduced, stubbed
behavior presented as working, and tests tagged with a criterion ID that do not actually
exercise that criterion.

The auditor writes `reports/AUDIT.md` and returns only a short summary. Unresolved critical or
major findings block completion.

---

# Blocking behavior

If an external blocker prevents completion, do not emit the completion promise. Create or
update `BLOCKED.md` with: timestamp, exact blocker, evidence and error output, actions
attempted, why further autonomous action is unsafe or impossible, current phase, which
criteria remain incomplete, current Git commit, unpushed commits, the minimal human action
required, and the exact command to resume.

Valid external blockers: Zotero local API disabled by user setting when it is the only
remaining blocker, unavailable GitHub authentication after reasonable diagnostics, a required
native module that cannot build on this platform after genuine diagnosis, or a required
dependency that is unavailable.

A failing test, a hard bug, a long build, or an unexpected library API is **not** a blocker.
Diagnose and fix it.

Whenever `BLOCKED.md` is created or materially updated, commit it and push it to `origin/main`
so the blockage is visible remotely.

---

# Final behavior

Continue autonomously through scaffolding, database, Electron shell, workbench, Zotero
adapter, PDF reader, extraction and indexing, search, annotations, notes, links, navigation,
layout persistence, tests, documentation, audit, commit, and push.

Preserve durable state at every checkpoint, not at the end of the iteration — there is no
guaranteed end. At any moment, a fresh context with no conversation memory must be able to
read `state/` and continue from the last pushed commit.

When and only when:

```bash
python3 scripts/verify_completion.py
```

exits successfully, all mandatory criteria and the audit pass, the working tree is clean, and
HEAD is present on `origin/main`, output exactly:

```text
<promise>MILESTONE_COMPLETE</promise>
```
