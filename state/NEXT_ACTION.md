# Next action

## What is happening now

Bootstrap session completed the repository skeleton, the Ralph loop harness, the frozen spec,
the milestone criteria, and the completion verifier. The monorepo toolchain is installed and
the first packages are being implemented.

## What was last verified

- `pnpm` 9.15.4 active via corepack; Node v23.11.0.
- Git repo on `main`, remote `origin` = `https://github.com/czhs/wiki-reader.git`, reachable,
  remote repository exists and is empty.
- **Zotero 7.0.32 running and the local API is ENABLED** (the user turned it on during
  bootstrap). `http://127.0.0.1:23119/api/users/0/items` -> 200. Library id `12123053`.
- Real API fixtures recorded to `packages/zotero-adapter/test/fixtures/`:
  `items-top.json` (8 items), `collections.json` (8), `tags.json` (15). Real wire shapes —
  do not invent fixture structures, extend these.
- `better-sqlite3` 11.10.0 built for BOTH ABIs: Node (ABI 131) at the default path for
  vitest, Electron 33.4.11 staged at
  `apps/desktop/resources/native/electron-33.4.11/better_sqlite3.node`. SQLite 3.49.2 with
  FTS5 confirmed working. Open the DB in main with `{ nativeBinding: <staged path> }`.
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` (59 tests) all pass.

## Next exact action

Work criteria in `docs/MILESTONE.md` order. Immediate sequence:

1. `T01`/`M03` — finish `@wr/database`: migration runner, `001_initial`, repositories, tests.
2. `M01`/`M02` — Electron shell + Dockview workspace + Playwright E2E harness.
3. `T02`/`T03`/`M04` — Zotero adapter against recorded fixtures, then live.

## Command a fresh session should run

```bash
cat state/experiment_state.json | python3 -m json.tool | head -40
pnpm test 2>&1 | tail -30
```

## What must not be repeated

- Do not re-run `corepack prepare`; pnpm is already active.
- Do not re-create the directory skeleton, `PROMPT.md`, `loop.sh`, `ralph_pretty.py`,
  `docs/SPEC.md`, `docs/MILESTONE.md`, or `scripts/verify_completion.py`.
- Do not re-probe Zotero more than once per iteration.
- Do not weaken the verifier.
