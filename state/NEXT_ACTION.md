# Next action

## Now

Milestone 3 is under way. **`C01`–`C03` are done, tested and pushed.** Next is the queue.

Work in this order — it is a dependency order, not a preference: the librarian links its
findings to questions and journal entries, so those have to exist first.

1. **`Q01`–`Q04`** — the queue. **Start here.**
2. **`J01`–`J03`** — the journal.
3. **`A01`–`A13`** — the librarian. Do `A02` (the write boundary) before anything after it, so
   the rest is built against an enforced boundary rather than a promised one.

Criteria: `docs/MILESTONE3.md`. Reasoning: `docs/superpowers/specs/2026-07-25-milestone-3-design.md`.
Agents: `docs/AGENTS.md`. All three are short.

Every milestone-3 tag is already in `UNIT_TAGS` / `E2E_TAGS` in `scripts/verify_completion.py`,
so the verifier fails on each one until its test passes. Strengthening it is required;
weakening it is never allowed.

## What C01–C03 left you

- **`settings`** — migration 003, `db.settings` (key → JSON, validated with zod *at the point
  of use*, never in the repository). The queue's hand-ordering has a home here if it needs one.
- **`SwappableRoots`** (`main/paths.ts`) — the allow-list object every path check holds, with
  one root that can be replaced at runtime. Hand it out; never snapshot `.roots`.
- **`db.documents.purge(id)`** — hard delete, cascades through the schema. `links` and
  `external_references` have no FK, so the caller clears those in the same transaction.
- **`services.chooseDirectory`** — injected, so a native dialog is the only untested part of
  choosing a folder. Refused in background mode.

## The reference implementation

`~/Desktop/fieldstation` is a Jekyll notebook in daily use that already has the queue, the
journal, and companion-spawned `claude` agents over a Karpathy-style wiki. **Read it before
designing any of the three** — it says what the shape should be. Its `CLAUDE.md` is the map;
`companion/prompts.mjs` and `companion/server.mjs` are the agent runner. What it keeps in a
browser `localStorage` blob and a committed `state.json`, wiki-reader stores in SQLite as
first-class entities. Port the shape, not the storage model.

## Traps

- **A main-process string ending in the bare word `import`, followed by another string
  literal, breaks the build.** electron-vite places its CommonJS shim after the last match of
  a static-import regex over the whole bundle, and that pattern matches inside string
  literals. The failure is `Unterminated string literal` in `out/main/index.js`, nowhere near
  the cause. See the comment at `main/handlers.ts` `zotero:listCollections`.
- **`A02` and `A04` both pass against no implementation.** An agent told not to write outside
  its folder mostly complies, so assert a write that *tries* to escape is refused. An agent
  asked for citations emits citation-shaped text either way, so resolve every one against the
  database.
- **`--system-prompt` replaces; `--append-system-prompt` does not.** The librarian needs the
  former. Check with `claude --help`.
- **Do not add retrieval to the agent path** when the corpus outgrows the context. That is the
  reflex fix and it is wrong: top-k decides what is related before the model thinks, which is
  the judgement the librarian exists to make. `A11` asserts it. FTS5 is the researcher's
  search, not the agent's.
- **Organisation is the goal; compression is not.** A pass that finds nothing must write
  nothing (`A13`).
- **A blank journal day is deleted, not stored as `{md: ""}`.**
- **Queue order is stored, not derived.** Sorting by date or importance throws away a
  judgement about what to do next.
- **Re-import skips unchanged items.** `import({force:true})` is the way in.
- **`pnpm test:e2e -- --reporter=json` forwards the literal `--`.** The verifier calls it with
  no separator.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

## What the UX criteria encode — don't undo them

`[UX01]`–`[UX09]` came from a user looking at the app while the suite was 92/92 green. Every
assertion in that suite was about text being *present*. When you add a criterion, ask what it
would still pass on — `[C03]` measures a layout box and a computed font size for that reason.

- Reading surfaces take colour from the **paper** scale (`--wr-surface`/`--wr-ink*`), never the
  chrome scale. `[UX02]` fails on any `--wr-*` used but undefined.
- A reader effect keys on `fileUrl` alone. Callback props in a dependency list reload the
  document on every parent render — that was `[UX07]`.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. `pnpm package` builds the .app.

## Don't

Rebuild the e2e harness. Weaken the verifier. Build the reviewer agent or hypotheses-as-entities
— both are milestone 4. Show an Electron window. Let the renderer send or receive a filesystem
path.
