# Next action

## Now

**Every milestone-5 criterion has a passing tagged test.** `P01`–`P05`, `F01`–`F03`,
`H01`–`H04`, `D01`–`D02` are done and green. What is left is not code:

1. **Audit milestone 5** into `reports/AUDIT.md`. Its header must claim milestone 5 — the
   verifier reads that file by first match, and the gate fails while it still says 4.
2. `python3 scripts/verify_completion.py` and drive it to 0.
3. `pnpm package`, then replace the bundle in `/Applications`. Nothing has been packaged since
   milestone 4 (bundle 2026-07-31T19:24), and a green criterion means nothing to the
   researcher until it has.

## What D01/D02 changed

- **The keyboard is a scheme, and each binding declares which family it is in.** Four families
  chosen by the *verb*: `Cmd+Shift+<letter>` goes to a page, `Cmd+P` goes to a file, the
  function row follows links, `Cmd+Alt+<letter>` makes something. Panes and retracing keep the
  conventions every app shares. `KeybindingRule.family` is a label, not behaviour — the help
  page groups by it, and inferring it from the modifiers instead is wrong exactly where it
  matters (`Cmd+Shift+W` closes a group and shares its modifiers with every page chord).
- **A page's letter is the first letter of its name that is still free**, scanning left to
  right — so the wiki is `I` and the focused view is `O`. A new page picks its letter by that
  rule, adds one row to `DEFAULT_KEYBINDINGS`, and appears on the help page with no other edit.
- **`WorkbenchHost.notebookInHand()`.** `openNotebook`/`openJournal` demanded an argument a
  keystroke cannot carry, which is why neither could be bound. The host answers; the activity
  bar's Journal button now runs the same command with no args instead of resolving its own.
- **`Cmd+P` is the keyboard's way into a reader** (`FilePalette` in `overlays.tsx`), because a
  document is one of thousands. `Cmd+Shift+R` is the way back out of the pages.
- **The help page is a panel rendered from the two registries**, never a sheet. `commands.all()`
  and the new `keybindings.all()`. It carries `data-command-count` / `data-binding-count`, and
  `[D02]` compares both with `COMMAND_IDS` and `DEFAULT_KEYBINDINGS` — a complete-today
  hand-written page cannot pass it.

## Also open

Eleven milestone-4 minors in `reports/AUDIT.md` and `state/experiment_state.json`. Seven
milestone-3 minors in `docs/SECURITY.md`; `11` (a child ignoring SIGTERM wedges the librarian)
is the only one that breaks a feature. One unit run in five reported a single unnamed failure;
four clean runs since, nothing found.

## Traps

- **`reports/AUDIT.md` is parsed by first match.** Its header must claim milestone 5 before the
  verifier can pass; never write the phrase "unresolved critical/major" in that file.
- **Never accept a filesystem path or a URL on a `wr:invoke` channel.** `wr:drop` is the
  exception and is not on the bridge.
- **`dispatch` returns `result.value`, not `result.data`.**
- **A dialog cannot be driven in background mode** — `WR_BACKGROUND=1` on every E2E launch.
- **Playwright's hit-testing is wrong inside the scaled archive frame.** Compute the point from
  `data-snapshot-scale` and click with `page.mouse`; `locator.click` lands on `<body>`.
- **Keys reach the renderer over CDP**, so a menu accelerator cannot eat one in the E2E suite —
  which is why `U01`'s other half is asserted on the menu template in `main/menu.test.ts`.
- **A failing Playwright test is very slow here.** All 78 green ≈ 2.5 min; one failure pushes a
  single file past 15.
- **`check_state` requires `phase == "milestone-1-complete"`.** Leave the phase alone.
- `tests/e2e/graph.spec.ts` still has older copies of the corpus helpers in
  `tests/e2e/support/corpus.ts` — fold them in when you next touch that file.

## Toolchain

Node 20.19.3 (`.nvmrc`), pnpm 9.15.4 via corepack. `source ~/.nvm/nvm.sh && nvm use` first.
~93 failing database tests means the ABI, not the code. Long runs go to `logs/`; never `pnpm dev`.

## Don't

Weaken the verifier. Build past milestone 5. Show an Electron window. Let the renderer send or
receive a filesystem path. Modify `~/Zotero/zotero.sqlite` — `[B04]` hashes it before and after.
