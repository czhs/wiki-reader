# Next action

## Now

**Milestone 5 is open — but a workflow in an interactive session is building it (started
2026-07-31).** If you are an autonomous loop reading this: stand by, don't start milestone-5
work, don't touch the tree. `docs/MILESTONE5.md` has the criteria — the notebook becomes the
unit and "question" retires, journals belong to notebooks with settable start dates, images in
blocks, caret at the click, the wiki as its own page plus a focused crawlable graph view,
saved-page highlighting fixed, per-highlight links with a per-file ledger, link targets picked
from the graph. `P01`–`P05`, `F01`–`F03`, `H01`–`H04` are armed in the verifier.

Milestone 4 closed 2026-07-31: verifier 152/152, bundle 2026-07-31T19:24 installed.

## Also open

Eleven milestone-4 minors in `reports/AUDIT.md` and `state/experiment_state.json` — first two
worth doing: `[N06]`'s guard (the un-dragged default already satisfies it) and the card-art
8 MB cap checked after `arrayBuffer()`. Seven milestone-3 minors in `docs/SECURITY.md`; `11`
(a child ignoring SIGTERM wedges the librarian) is the only one that breaks a feature.

## Traps

- **`reports/AUDIT.md` is parsed by first match.** Milestone-4 header stays at the top; never
  write the phrase "unresolved critical/major" in that file.
- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green ≈ 2 min; a failure pushes a file past 15.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 4. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
