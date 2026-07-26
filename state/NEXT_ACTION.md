# Next action

## Now

Milestone 3. `C01`–`C03`, the queue (`Q01`–`Q04`), the journal (`J01`–`J03`), **`A01`** and
**`A02`** are done, tested and pushed. What is left is `A03`–`A13`.

**`A09` and `A11` have passing tagged tests that cover only their first halves** — the prompt
line is gone, the tool set has no retrieval in it. Do not read the green verifier as a finished
criterion. `A09` still needs a direction *proposal* dropped when the capability is off; `A11`
still needs the agent handed *whole documents*.

Next: the wiki view (what the agent reads) and the proposal boundary (what it may hand back),
which together finish `A09`, `A11`, and carry `A04`, `A06`–`A08`, `A12`. Then `A03` (off by
default, disclosure), `A05` (accept / reject), `A10` (navigate), `A13` (schedule).

Criteria: `docs/MILESTONE3.md`. Reasoning: `docs/superpowers/specs/2026-07-25-milestone-3-design.md`.
Agents: `docs/AGENTS.md`. All three are short. Every milestone-3 tag is already armed in
`scripts/verify_completion.py`; strengthening it is required, weakening it never allowed.

## What A01 and A02 left you

`apps/desktop/src/main/agents/` — four modules, **not yet wired into `services.ts`**. Nothing
constructs them outside tests, so the next piece of work owns giving them a root and an owner.

- `workspace.ts` — `AgentWorkspace`, the **only** way anything writes on the agent's behalf.
  Containment is decided twice: lexically after `resolve`, then again on the **real** path of the
  deepest existing ancestor, because `open()` follows symlinks and a link planted inside the root
  passes any string test. A refusal logs `warn agent write refused`. `runDirectory(runId)` mints
  `<root>/.runs/<runId>`; `list()` skips `.runs`, because a proposal is not yet a note.
- `prompt.ts` — capabilities are **data**: one line each, appended only when enabled.
- `stream.ts` — `parseStreamLine` returns an *array* (one assistant line can hold several
  blocks) and `null`-equivalent for anything it does not recognise.
- `runner.ts` — the spawn. `--system-prompt-file`, `--output-format stream-json`, `--tools`
  limited to `CRAWL_TOOLS`, `--strict-mcp-config` with no config. It writes its own system
  prompt *through the workspace*; don't give it a privileged path.

`tests/fixtures/agents/` — a **recorded** transcript from Claude Code 2.1.220 and a stub that
replays it as a real child process, writing the argv it was handed to `spawn-argv.json` so a
test can assert the spawn. Re-record with the recipe in that directory's `README.md`; don't
hand-edit it.

## Traps

- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string. See `main/handlers.ts`
  `zotero:listCollections`.
- **`A04` passes against no implementation.** Resolve every citation against the database.
- **`--system-prompt-file` replaces; `--append-system-prompt` does not.** It is absent from
  `claude --help`'s option list but real, and it validates the file before any network call.
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
