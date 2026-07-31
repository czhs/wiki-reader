# Next action

## Now

**Milestone 4 is complete.** `verify_completion.py` passed 152/152 on 2026-07-31 with HEAD
`c808b3d` pushed, and the bundle packaged 2026-07-31T19:24 is installed at
`/Applications/wiki-reader.app`. The researcher's running instance (PID 4057) is still the old
bundle until they restart the app; four hidden `.wiki-reader-superseded-*.app` copies in
`/Applications` are theirs to delete after that.

There is no milestone 5 yet. Do not build past milestone 4 (`docs/SPEC.md` is still later).
Until new direction arrives, the only open work is the minor findings below.

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
