# Next action

## Now

Milestone 2 (`docs/MILESTONE2.md`, W01–W12). The W-tags are **active** in the verifier, so it
fails until each has a passing tagged test. **W01–W10 are done.** Verifier 89/92: `W11`, `W12`
and a clean tree remain.

**W11 — highlight colours.** Six names stored by name, not hex, so theming can't break them:
`default`, `tan`, `spruce`, `ochre`, `clay`, `signal`. Today `annotation:create`/`update` take
a free-form `z.string()` and `panels.tsx` writes the hex literal `DEFAULT_HIGHLIGHT_COLOR =
'#ffd54f'` — both go. Put the enum in `@wr/shared-types`; readers map name → CSS variable.
The popover also edits the comment and deletes (`annotation:update` already takes
`color`/`comment`; `annotation:delete` exists — the UI is what's missing).

Existing rows carry hex. **Decide what an unknown stored value renders as and assert it** —
narrowing the type without that broke 17 repository tests once already.

Then **W12** — scoped Zotero import, additive across collections.

## Traps that already cost time

- **Re-import skips unchanged items.** `ZoteroImporter` short-circuits an item whose Zotero
  `version` is unchanged, which skips its attachments, so bytes are never re-hashed.
  `import({force:true})` is the other way in. This bit W05.
- **`[M05]` counts the corpus too.** The sidebar lists the Zotero import *plus* corpus pages,
  so the assertion is `documents.length + corpusPageCount`. Don't "fix" it back.
- **Don't reintroduce the e2e gate bug.** `pnpm test:e2e -- --reporter=json` forwards the
  literal `--`, which demotes the reporter to a positional file filter. The verifier calls it
  with no separator and points `PLAYWRIGHT_JSON_OUTPUT_NAME` at `logs/verify/playwright.json`,
  unlinking it first.
- **`check_state` still requires `phase == "milestone-1-complete"`.** The `milestone` field
  tracks milestone 2. Flip the phase — and widen that check to accept both — only when W01–W12
  are green.

## Toolchain — read before diagnosing database failures

Node pinned to 20.19.3 in `.nvmrc`, pnpm 9.15.4 via corepack. Homebrew's node 26 (ABI 147) and
pnpm 11 **break the build**. ~93 failing database tests means the ABI, not the code. Shells
here need `source ~/.nvm/nvm.sh && nvm use` first.

## Don't

Rebuild the e2e harness. Weaken the verifier. Widen milestone-2 criteria to the rest of
SPEC.md. Show an Electron window in automated runs. Let the renderer send or receive a
filesystem path.
