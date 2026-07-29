# Next action

## Now

**Ship the bundle, then close the milestone.** `pnpm package` →
`apps/desktop/release/mac-arm64/wiki-reader.app`, replace `/Applications/wiki-reader.app`.
The installed bundle is from 2026-07-29T00:29 and carries **neither** `K01`–`K03` **nor** any
of the three audit fixes below. The researcher runs the bundle, not the tree.

Then `python3 scripts/verify_completion.py`. If it exits 0 with HEAD pushed, emit
`<promise>MILESTONE_COMPLETE</promise>`.

## What just happened

The milestone-4 audit ran — four independent lenses over `fde3e38..c072375`, written to
`reports/audit-m4-{notebooks,journal-links,library-graph,security}.md` and folded into
`reports/AUDIT.md` (`Audited-milestone: 4`). It found **three majors, all now fixed**, each
confirmed by reverting the fix and watching the new test fail:

1. **A routine import undid curation.** `zotero:import` falls back to the remembered picks, so
   with any standing scope ticked the plain Import button was a *scoped* run and lifted every
   removal inside it. Fixed with `ScopeOrigin` — `'named'` (this action pointed at a
   collection) vs `'remembered'` (the standing picks); only `'named'` restores.
2. **"Queued to be searchable again" was a no-op.** Nothing has ever drained an `index-fts`
   job, so a restored document *and all its annotations* stayed unfindable forever, and
   `[B01]` asserted the queue row as its evidence. Fixed with
   `SearchIndexer.reindexDocument`, an `index-fts` drain in `pipeline.ts`, and the local-file
   restore path enqueuing one too.
3. **Card art's allow-list held on the first hop only.** `artUrl` asks for `format=image`,
   which Scryfall answers *with a redirect*, so `redirect: 'follow'` let the reply choose the
   host. Fixed by following redirects by hand with the allow-list on every hop (scheme and
   port too, bounded at 3), and naming `cards.scryfall.io` in the disclosure, `README.md` and
   `docs/SECURITY.md`.

Gates after the fixes: typecheck 0 · lint 0 · build 0 · **650** unit tests (was 645) · E2E 65.

## Traps

- **`reports/AUDIT.md` is parsed by first match.** The milestone-4 header must stay at the top;
  the milestone-3 section deliberately no longer uses the literal `Audited-commit:` /
  `Audited-milestone:` tokens. Never write the phrase "unresolved critical/major" in that file
  — the verifier greps for it and fails.
- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **A failing Playwright test is very slow here.** Green suite ≈ 2 min; one failure can push a
  file past 15. Long durations mean failures, not a hang.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

## Also open

Eleven minor findings, listed in `reports/AUDIT.md` and `state/experiment_state.json`. The two
worth doing first are **`[N06]`'s guard, which the un-dragged default already satisfies**, and
**the card-art 8 MB cap, checked after `arrayBuffer()`** so it bounds disk and not heap. Seven
milestone-3 minors remain in `docs/SECURITY.md`; `11` (a child ignoring SIGTERM wedges the
librarian) is still the only one that breaks a feature outright.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 4. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
