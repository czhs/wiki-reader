# Next action

## Now

All 46 criteria (M/L/T + W01–W12) are implemented, tagged and passing. The milestone-2 audit is
done and both major findings are closed. **The only thing left is to re-run the verifier at the
current commit and, if it is 92/92 with HEAD pushed, emit the completion promise.**

```bash
source ~/.nvm/nvm.sh && nvm use
python3 scripts/verify_completion.py        # ~40s; runs typecheck, lint, vitest and real e2e
```

It exited 0 (92/92) at `4420cea`. Since then: the two audit fixes, a verifier strengthening,
and the milestone-2 audit report. Nothing in those should move a gate — but re-run it, don't
assume. If it is green and `git status` is clean and HEAD is on `origin/main`, emit
`<promise>MILESTONE_COMPLETE</promise>`.

## What the audit changed (don't undo it)

- **`apps/desktop/src/renderer/annotation-actions.ts` is the one definition of the popover's
  edits.** `[W11]` used to write its own copy of those handlers, so no-op'ing the panel's copy
  left all seven `[W11]` tests green. The panel and the test now drive the same code. If you
  ever find yourself rewriting handler logic inside a test, that is the bug this fixed.
- **`tests/integration/zotero-import.test.ts` drives `zotero:import` over the real router.**
  The `[W12]` tests in `packages/zotero-adapter` construct `ZoteroImporter` directly, so the
  channel and the handler that forwards `collection` were covered by nothing. `services.ts`
  now takes `zoteroFetch` (like `extractPdf`) so the fixtures can reach the channel.
- **`packages/graph/src` was added to `RENDERER_SOURCE_ROOTS`** in the verifier. It is imported
  by `graph-panel.tsx` and the forbidden-import rule never reached it.

Open minor findings are listed in `reports/AUDIT.md`; none blocks a criterion. The most real is
**W-4**: `protocol.ts:342-343` claims more containment than `:258-279` enforces for an empty
resource path. No exfiltration path — fix the comment or the gate, not both in a hurry.

## Traps that already cost time

- **A mutation was found live in the working tree** at session start (`markdown-anchor.ts`,
  resolving a lost anchor to its stored offsets instead of reporting it lost). `[W02]` caught
  it. Check `git status` before trusting a clean-looking tree.
- **Re-import skips unchanged items.** `ZoteroImporter` short-circuits an item whose Zotero
  `version` is unchanged, which skips its attachments. `import({force:true})` is the way in.
- **`[M05]` counts the corpus too** — assert `documents.length + corpusPageCount`.
- **`pnpm test:e2e -- --reporter=json` forwards the literal `--`** and demotes the reporter to a
  file filter. The verifier calls it with no separator.
- **`check_state` requires `phase == "milestone-1-complete"`.** The `milestone` field tracks
  milestone 2. Leave the phase alone — it passes as is, and widening the check would weaken it.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. Homebrew node 26 (ABI 147) breaks the build;
~93 failing database tests means the ABI, not the code. `source ~/.nvm/nvm.sh && nvm use` first.

## Don't

Rebuild the e2e harness. Weaken the verifier. Widen milestone-2 criteria to the rest of
SPEC.md. Show an Electron window. Let the renderer send or receive a filesystem path.
