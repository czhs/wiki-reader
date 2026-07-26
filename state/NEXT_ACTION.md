# Next action

## Now

Milestone 3. `C01`–`C03`, the queue (`Q01`–`Q04`), the journal (`J01`–`J03`) and **`A02`** are
done, tested and pushed. What is left is the rest of the librarian: `A01`, `A03`–`A13`.

Next is **`A01`** — spawn a headless `claude` under an overriding system prompt and stream its
progress. Then `A03` (off by default, disclosure), the capabilities (`A06`–`A09`), `A04`/`A10`
(citations), `A05` (accept / reject), `A11`–`A13`.

Criteria: `docs/MILESTONE3.md`. Reasoning: `docs/superpowers/specs/2026-07-25-milestone-3-design.md`.
Agents: `docs/AGENTS.md`. All three are short. Every milestone-3 tag is already armed in
`scripts/verify_completion.py`; strengthening it is required, weakening it never allowed.

## What A02 left you

`apps/desktop/src/main/agents/workspace.ts` — `AgentWorkspace`, rooted at one directory, the
**only** way anything writes on the agent's behalf. Build the runner on it, don't route around it.

- `write` / `writeOrThrow` / `read` / `list`, all taking a workspace-relative path.
- Containment is decided twice: lexically after `resolve`, then again on the **real** path of the
  deepest existing ancestor, because `open()` follows symlinks and a link planted inside the root
  passes any string test. A refusal logs `warn agent write refused` with what was asked for.
- `runDirectory(runId)` mints `<root>/.runs/<runId>`. A run writes there, not into the workspace
  body — nothing lands without an accept — and `list()` skips `.runs` for exactly that reason.
- Not yet wired into `services.ts`. `A01` is where it gets a root and an owner.

## Traps

- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string. See `main/handlers.ts`
  `zotero:listCollections`.
- **`A04` passes against no implementation.** Resolve every citation against the database.
- **`--system-prompt-file` replaces; `--append-system-prompt` does not.** The librarian needs the former.
- **No retrieval in the agent path.** `A11` asserts it. FTS5 is the researcher's search.
- **Organisation, not compression.** A pass that finds nothing writes nothing (`A13`).
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- A branded id in a request is validated by the router, so a malformed placeholder in a test
  returns `INVALID_REQUEST`, not `NOT_FOUND`. Ids are `<prefix>_<26 chars>`.
- Sidebars are `library | questions | journal | annotations | bottomPanel`. A restored workspace
  reopens the ones that were open; an E2E that clicks the activity button blind closes one.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Rebuild the e2e harness. Weaken the verifier. Build the reviewer agent or hypotheses-as-entities
— both are milestone 4. Show an Electron window. Let the renderer send or receive a filesystem path.
