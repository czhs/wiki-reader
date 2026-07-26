# Next action

## Now

Milestones 1 and 2 are complete — 92/92, audited, pushed. **Milestone 3 starts here.**

Read `docs/MILESTONE3.md` for the criteria and
`docs/superpowers/specs/2026-07-25-milestone-3-design.md` for why they are shaped that way.
Neither is long.

Work in this order. It is a dependency order, not a preference: the librarian links its
findings to questions and journal entries, so those have to exist first.

1. **`C01`–`C03`** — the carry-over fixes. Small, and `C02` clears twelve broken rows that
   currently make the Notes section show `403 Forbidden` on every item.
2. **`Q01`–`Q04`** — the queue.
3. **`J01`–`J03`** — the journal.
4. **`A01`–`A12`** — the librarian. Do `A02` (the write boundary) before anything after it, so
   the rest is built against an enforced boundary rather than a promised one.

Add each tag to `UNIT_TAGS` / `E2E_TAGS` in `scripts/verify_completion.py` as you implement it,
and add `docs/MILESTONE3.md` to its `REQUIRED_DOCS`. Strengthening the verifier is required;
weakening it is never allowed.

## The reference implementation

`~/Desktop/fieldstation` is a Jekyll notebook in daily use that already has the queue, the
journal, and companion-spawned `claude` agents over a Karpathy-style wiki. **Read it before
designing any of the three** — it says what the shape should be. Its `CLAUDE.md` is the map;
`companion/prompts.mjs` and `companion/server.mjs` are the agent runner.

What it keeps in a browser `localStorage` blob and a committed `state.json`, wiki-reader stores
in SQLite as first-class entities. Do not port the storage model, only the shape.

## Traps

- **`A02` and `A04` both pass against no implementation.** An agent told not to write outside
  its folder mostly complies, so assert a write that *tries* to escape is refused. An agent
  asked for citations emits citation-shaped text either way, so resolve every one against the
  database.
- **`--system-prompt` replaces; `--append-system-prompt` does not.** The librarian needs the
  former. Both exist on the installed CLI; check with `claude --help`.
- **Do not add retrieval to the agent path** when the corpus outgrows the context. That is the
  reflex fix and it is wrong: top-k decides what is related before the model thinks, which is
  the judgement the librarian exists to make. The answer is denser notes, not ranked chunks.
  `A11` asserts it. FTS5 is the researcher's search, not the agent's.
- **The wiki is the whole app**, not a folder. The librarian reads all of it and writes only in
  its own workspace; that boundary is the only thing separating it from you.
- **A blank journal day is deleted, not stored as `{md: ""}`.** "No entry" and "an empty entry"
  are the same fact.
- **Queue order is stored, not derived.** It is a judgement about what to do next; sorting by
  date or importance throws it away.
- **`rrfile://` refuses paths outside the allowed roots** — that is the `403` on the stranded
  notes, and it is the mechanism working, not a bug in it.
- **Re-import skips unchanged items.** `import({force:true})` is the way in.
- **`pnpm test:e2e -- --reporter=json` forwards the literal `--`.** The verifier calls it with
  no separator.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

## What the UX criteria encode — don't undo them

`[UX01]`–`[UX09]` came from a user looking at the app while the suite was 92/92 green. Every
assertion in that suite was about text being *present*, which is true of a document rendered in
light grey on cream, set in a substituted font, in a reader that reloads when you touch
anything. When you add a criterion, ask what it would still pass on.

- Reading surfaces take colour from the **paper** scale (`--wr-surface`/`--wr-ink*`), never the
  chrome scale. `[UX02]` fails on any `--wr-*` used but undefined.
- A reader effect keys on `fileUrl` alone. Callback props in a dependency list reload the
  document on every parent render — that was `[UX07]`.
- PDF.js needs `standardFontDataUrl` and `cMapUrl`; the build emits both, in dev too.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. Homebrew node 26 breaks the build; ~93
failing database tests means the ABI, not the code. `source ~/.nvm/nvm.sh && nvm use` first.

`pnpm package` builds a double-clickable `apps/desktop/release/mac-arm64/wiki-reader.app`.

## Don't

Rebuild the e2e harness. Weaken the verifier. Build the reviewer agent or hypotheses-as-entities
— both are milestone 4. Show an Electron window. Let the renderer send or receive a filesystem
path.
