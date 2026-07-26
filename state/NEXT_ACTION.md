# Next action

## Now

Milestone 3. Everything through `J03`, plus **`A01`, `A02`, `A04`, `A06`–`A09`, `A11`, `A12`**,
is done, tested and pushed. What is left is **`A03`, `A05`, `A10`, `A13`** — and all four are
one piece of work: **wire the librarian into the app and put a face on it.**

Nothing in `apps/desktop/src/main/agents/` is constructed outside tests. `services.ts` does not
build a workspace, a view, a runner, a reader, a `LibrarianService` or a `LibrarianScheduler`.
That is the first job; every remaining criterion is downstream of it.

1. **Wire it up** — `services.ts` builds those six; the workspace root joins the fixed list in
   `SwappableRoots` so `rrfile://` can serve an accepted note. Finishes **`A13`**, whose logic
   is already tested — what is missing is that nothing in the running app schedules a pass.
2. **`A03`** (E2E) — agents off until enabled, and enabling **first discloses what would be
   sent**. With agents off nothing touches the network: don't materialise the view, don't
   spawn, don't start the timer. The sentence in `README.md` that promises this must stay true.
3. **`A05`** (E2E) — a proposals panel listing what a pass produced, with accept and reject.
   `LibrarianService.accept`/`.reject` already work and are integration-tested; the gate needs a
   Playwright spec tagged `[A05]` driving real buttons.
4. **`A10`** (E2E) — clicking a citation opens its source at its location. Every `Citation`
   already carries `documentId` and `location`, resolved at the boundary.

New channels: `agent:status|enable|disclosure|run|cancel`, `agent:listProposals`, `agent:accept`,
`agent:reject`. One router, zod-validated, as always.

Criteria: `docs/MILESTONE3.md`. Reasoning: `docs/superpowers/specs/2026-07-25-milestone-3-design.md`.
Agents: `docs/AGENTS.md`. All three are short.

## What the librarian already is

`apps/desktop/src/main/agents/` — seven modules, all tested, none wired.

- `workspace.ts` — the **only** way anything writes on the agent's behalf. Containment is
  decided twice: lexically, then again on the **real** path of the deepest existing ancestor,
  because `open()` follows symlinks. `runDirectory(id)` mints `.runs/<id>`; `list()` skips it.
- `wiki-view.ts` — the database as crawlable markdown named by entity id. `materialise()` takes
  **no arguments**: no query, no limit, nothing to rank with. It seals the tree `r-x`/`r--`, so
  **`remove()` owns deleting it** — plain `rm -rf` gets `EACCES`.
- `prompt.ts` — capabilities are data, one line each, appended only when enabled.
- `runner.ts` / `stream.ts` — the spawn and its output. `parseStreamLine` returns an *array*.
- `proposals.ts` — the gate. Resolves front-matter ids **and** body `[[wikilinks]]`; one
  unresolvable id refuses the proposal whole. The capability check runs before resolution.
- `librarian.ts` — `pass()`, `accept()`, `reject()`. Accept is the only path that writes into
  the workspace body; it also mints a `markdown` document with `source = 'librarian'` and
  `librarian-note-cites` edges to every citation.
- `schedule.ts` — `decidePass` is pure (12 h; 2 h after a batch of ≥10 imports). The timer is a
  shell with no policy in it.

Migration **006** adds `agent_runs` and `agent_proposals`. A CHECK refuses an accepted row with
no `workspace_path`: accepting *is* writing the file.

`tests/fixtures/agents/` — a **recorded** Claude Code 2.1.220 transcript and a stub that replays
it as a real child process, writing its argv to `spawn-argv.json`. Re-record with the recipe in
that directory's `README.md`; don't hand-edit it.

## Traps

- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string. See `main/handlers.ts`.
- **`--system-prompt-file` replaces; `--append-system-prompt` does not.** It is absent from
  `claude --help`'s option list but real, and validates the file before any network call.
- **No retrieval in the agent path.** `A11` reads the agent modules' own source and fails on
  `embed|vector|cosine|topK|bm25|rerank` or an `@wr/search` import.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- A branded id in a request is validated by the router, so a malformed placeholder in a test
  returns `INVALID_REQUEST`, not `NOT_FOUND`. Ids are `<prefix>_<26 chars>`; the new ones are
  `agr_` and `apr_`.
- Sidebars are `library | questions | journal | annotations | bottomPanel`. A restored workspace
  reopens the ones that were open; an E2E that clicks the activity button blind closes one.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Rebuild the e2e harness. Weaken the verifier. Build the reviewer agent or hypotheses-as-entities
— both are milestone 4. Show an Electron window. Let the renderer send or receive a filesystem path.
