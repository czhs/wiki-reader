# Next action

## Now

Milestone 3. `C01`–`C03` and **the whole queue, `Q01`–`Q04`, are done, tested and pushed.**

1. **`J01`–`J03`** — the journal. **Start here.**
2. **`A01`–`A13`** — the librarian. Do `A02` (the write boundary) first, so everything after it
   is built against an enforced boundary rather than a promised one.

Criteria: `docs/MILESTONE3.md`. Reasoning: `docs/superpowers/specs/2026-07-25-milestone-3-design.md`.
Agents: `docs/AGENTS.md`. All three are short. Every milestone-3 tag is already armed in
`scripts/verify_completion.py`; strengthening it is required, weakening it never allowed.

## What the queue left you

- Migration 004 `questions` — `ordinal` is the hand-order and nothing derives it. The CHECK
  refuses a discarded row with no reason, so no path produces one.
- `db.questions` — `create` appends at the end; `reorder(ids)` takes a **subset**, collects the
  ordinals those ids already occupy, and hands them back out in the new order, so a drag inside
  a filtered list cannot disturb the questions interleaved around it.
- Channels `question:create|get|list|update|discard|reorder|attach`. `question:update` refuses
  `status: 'discarded'` (that goes through `discard`, which carries the reason); `question:attach`
  checks both endpoints exist before writing the edge.
- `'question'` is a `LinkableEntityType` and resolves in `EntityResolver.describe`.
- `renderer/queue-panel.tsx` is the panel: a `questions` sidebar behind a new activity-bar
  button, reordered by pointer-drag **and** by the arrow keys on the grip. The order on screen
  lives in a ref (`shown`) as well as in state, so a drop commits exactly what the last move
  left — a state updater that also sent the request would send it twice under StrictMode.
- The journal wants the same shape: entities in the database, a panel that never re-derives
  what the researcher arranged, and `~/Desktop/fieldstation` as the reference for the shape
  (its journal is a `{ '<YYYY-MM-DD>': { md, updated } }` map; see its `CLAUDE.md`).

## Traps

- **A main-process string ending in the bare word `import`, followed by another string literal,
  breaks the build** — electron-vite's CJS shim lands inside the string. `Unterminated string
  literal` in `out/main/index.js`, nowhere near the cause. See `main/handlers.ts`
  `zotero:listCollections`.
- **`A02` and `A04` both pass against no implementation.** Assert a write that *tries* to escape
  is refused; resolve every citation against the database.
- **`--system-prompt` replaces; `--append-system-prompt` does not.** The librarian needs the former.
- **Do not add retrieval to the agent path.** `A11` asserts it. FTS5 is the researcher's search.
- **Organisation is the goal, not compression.** A pass that finds nothing writes nothing (`A13`).
- **A blank journal day is deleted, not stored as `{md: ""}`.**
- **Re-import skips unchanged items.** `import({force:true})` is the way in.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- `[UX01]`–`[UX09]` came from real use: reading surfaces take the **paper** scale
  (`--wr-surface`/`--wr-ink*`), and a reader effect keys on `fileUrl` alone.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Rebuild the e2e harness. Weaken the verifier. Build the reviewer agent or hypotheses-as-entities
— both are milestone 4. Show an Electron window. Let the renderer send or receive a filesystem path.
