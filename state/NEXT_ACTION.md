# Next action

## Now

Milestone 3. Everything except **`A03`, `A05`, `A10`** is done, tested and pushed. All three are
E2E, and all three need the same missing thing: **the librarian's face in the renderer.**

The main process is finished and green. `services.ts` builds `workspace`, `view`, `runner`,
`reader`, `librarian` and `scheduler` as `services.agents`; nine `agent:*` channels are handled;
`tests/integration/agent-channels.test.ts` (10 tests) drives them over the real router.

1. **The panel** — a `librarian` sidebar, activity button `activity-librarian`, command
   `wr.toggleLibrarianSidebar` (all three already exist in `@wr/workbench` and `SidebarState`).
   It shows, in this order: the disclosure, the enable switch, the capability switches, the
   pending proposals with **Accept** and **Reject**, and each proposal's citations as buttons.
2. **`A03`** (E2E) — agents off on first launch; the panel shows what would be sent *before*
   anything can be enabled. `agent:enable` already refuses with `CONFLICT` until
   `acknowledgeDisclosure` is true, so the panel must not offer the switch before the
   disclosure has been shown. The sentence in `README.md` must stay true.
3. **`A05`** (E2E) — accept writes a note into the workspace; reject writes nothing.
4. **`A10`** (E2E) — clicking a citation opens its source at its location. Every citation
   carries `documentId` and `location`, already resolved at the boundary.

The E2E harness needs to stage a pending proposal before launching. Do it the way
`agent-channels.test.ts`'s `stage()` does — real `AgentWorkspace.writeOrThrow`, real
`ProposalReader.harvest`, real `db.agentRuns.propose` — and point the app at the same directory
with **`WR_AGENT_ROOT`** (read by `main/index.ts`, alongside `WR_DATABASE_PATH`).

Criteria: `docs/MILESTONE3.md`. Reasoning: `docs/superpowers/specs/2026-07-25-milestone-3-design.md`.

## What is already there

`apps/desktop/src/main/agents/` — eight modules, all tested, all wired.

- `settings.ts` — the switch, the capability set, and `agentDisclosure()`, which **counts the
  database** rather than reciting prose, so the disclosure cannot drift from what is sent.
- `workspace.ts` — the only way anything writes for the agent. Containment decided twice.
- `wiki-view.ts` — the database as crawlable markdown. `materialise()` takes no arguments. It
  seals the tree `r-x`/`r--`, so **`remove()` owns deleting it** — plain `rm -rf` gets `EACCES`.
- `runner.ts` / `stream.ts` — the spawn and its output. `parseStreamLine` returns an *array*.
- `proposals.ts` — the gate. One unresolvable id refuses the proposal whole.
- `librarian.ts` — `pass()`, `accept()`, `reject()`. The task names the wiki by absolute path.
- `schedule.ts` — `decidePass` is pure. `services.agents.startIfEnabled()` arms it at launch,
  and only when agents are on.

## Traps

- **The recorded transcript cannot produce a proposal.** `librarian-stream.jsonl` predates the
  front matter the task now asks for and cites the ids of the library it was recorded against.
  It proves the spawn and the stream; it cannot stand in for a pass. Stage proposals instead.
- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string. See `main/handlers.ts`.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- A branded id in a request is validated by the router, so a malformed placeholder in a test
  returns `INVALID_REQUEST`, not `NOT_FOUND`. The new prefixes are `agr_` and `apr_`.
- Sidebars are `library | questions | journal | librarian | annotations | bottomPanel`. A
  restored workspace reopens the ones that were open; an E2E that clicks the button blind
  closes one.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Rebuild the e2e harness. Weaken the verifier. Build the reviewer agent or hypotheses-as-entities
— both are milestone 4. Show an Electron window. Let the renderer send or receive a filesystem path.
