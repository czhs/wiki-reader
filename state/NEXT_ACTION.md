# Next action

## Now

All 46 criteria (M/L/T + W01–W12) pass, plus `[UX01]`–`[UX06]`, which cover six defects a
user found by *looking at the app* while the suite was 92/92 green. Re-run the verifier and,
if it is 92/92 with HEAD pushed, emit the completion promise.

```bash
source ~/.nvm/nvm.sh && nvm use
python3 scripts/verify_completion.py        # ~65s; typecheck, lint, vitest, real e2e
```

## The lesson the UX criteria encode — don't undo it

Every assertion in the original suite was about text being **present**: `innerText`, element
counts, anchors that resolve. All of it passes on a document rendered in light grey on cream,
on a page set in a substituted font, and on a reader that jumps 280px when you annotate it.
When adding a criterion, ask what it would still pass on.

- **`[UX01]`/`[UX02]`** — the markdown surface was 1.34:1. `--wr-surface` was used by a
  stylesheet and defined by nothing, so it fell back to a paper literal while `--wr-text`
  resolved to the *dark chrome's* light grey. There are now two colour scales: chrome
  (`--wr-bg`/`--wr-text`) and paper (`--wr-surface`/`--wr-ink*`). **A reading surface never
  uses a chrome token.** `[UX02]` fails on any `--wr-*` used but undefined.
- **`[UX03]`** — annotating must not move the document. See DECISIONS.
- **`[UX04]`/`[UX05]`** — PDF.js ships neither the standard-14 font programs nor the CID
  cmaps; `electron.vite.config.ts` copies both next to the bundle and `pdfjs.ts` points at
  them. Without this, 25 of 71 papers in a real Zotero library render in substituted metrics.
- **`[UX06]`** — Zotero snapshots are *single files* with everything inlined. `[W03]` uses a
  multi-file fixture, which is not the shape Zotero produces.

## Traps that already cost time

- **PDF.js reports a missing font from the *worker*.** `page.on('console')` never sees it, so
  a test asserting on console output passes with the font URL pointed at a directory that
  does not exist. `[UX05]` asserts on the *response* and on `document.fonts` instead. Mutate
  the URL and watch it fail before trusting any change here.
- **The e2e fixtures are easier than the real world.** `sample-paper.pdf` is synthetic and
  embeds its fonts; the `[W03]` snapshot is hand-written multi-file. Both hid real defects.
  To reproduce something a user reports, point the harness at `~/Zotero/storage` — overwrite
  the materialised attachment bytes after `createWorkspace()` and launch with `launchApp`.
- **`.wr-sidebar .wr-list` matched every descendant**, so each section inside a sidebar body
  became its own scroll area. It is `.wr-sidebar > .wr-list` now.
- **A mutation was once found live in the working tree** at session start. Check `git status`
  before trusting a clean-looking tree.
- **Re-import skips unchanged items.** `import({force:true})` is the way in.
- **`pnpm test:e2e -- --reporter=json` forwards the literal `--`.** The verifier calls it with
  no separator.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.

## Known, not fixed

- **`reports/AUDIT.md` W-4**: `protocol.ts:342-343` claims more containment than `:258-279`
  enforces for an empty resource path. No exfiltration path. Fix the comment or the gate.
- **Two library rows can share a title** — a Zotero library legitimately holds the preprint
  and the published page of one paper as two items. They are disambiguated by type rather
  than collapsed; collapsing would hide a real item.
- **Remote subresources in a snapshot never load.** In a real 28-snapshot library every one
  is an ad, a beacon or a tracking pixel, so this costs no fidelity — but a page that
  genuinely needed a remote stylesheet would render unstyled rather than loudly.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. Homebrew node 26 (ABI 147) breaks the
build; ~93 failing database tests means the ABI, not the code. `source ~/.nvm/nvm.sh && nvm use`.

## Don't

Rebuild the e2e harness. Weaken the verifier. Widen milestone-2 criteria to the rest of
SPEC.md. Show an Electron window. Let the renderer send or receive a filesystem path.
