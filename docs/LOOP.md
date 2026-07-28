# Loop protocol — read when needed, not every iteration

## Ledger record

One record per checkpoint, not per iteration. Many per session is correct.

```json
{
  "checkpoint_id": "...", "started_at": "...", "finished_at": "...",
  "phase": "...", "actions_taken": ["..."], "criteria_advanced": ["M06"],
  "errors": ["..."], "next_action": "...", "git_commit": "...", "pushed": true
}
```

## Independent audit (before the completion promise)

Dispatch a subagent as an auditor with `docs/SPEC.md`, the active milestone criteria, the
source tree, the test suite, and `reports/completion_verification.json`.

Its job is to **falsify** the claim that the milestone is complete. Specifically: tests that
assert nothing meaningful, criteria satisfied by mocks where real integration was feasible,
regressed security invariants, `any` reintroduced, stubs presented as working, and tests
tagged with a criterion ID that don't actually exercise it.

It writes `reports/AUDIT.md` and returns a short summary. The verifier requires that file to
contain an `Audited-commit: <sha>` line naming a real ancestor of HEAD, an
`Audited-milestone: <n>` line matching the milestone being gated, a `## Findings` section, and
no placeholder text. Unresolved critical or major findings block completion.

The milestone line exists because a commit stays an ancestor of HEAD forever: without it, the
audit of one milestone silently satisfies the gate for the next.

## Blocked by something external

A failing test, a hard bug, a long build, or an unfamiliar library API is **not** a blocker.
Diagnose and fix it.

Real blockers: a required credential or service the user must enable, a native module that
genuinely cannot build after real diagnosis, an unavailable dependency.

If you hit one: write `BLOCKED.md` with the timestamp, the exact blocker, the error output,
what you tried, which criteria remain, the current commit, the minimal human action needed,
and the command to resume. Commit and push it so it's visible. Do not emit the completion
promise.

## Context discipline

Never paste full build, install, or test output into context. Use `tail -n 50`, `grep`, `jq`.
Redirect verbose output to timestamped files under `logs/`. Subagents write detail to files
and return short summaries.
