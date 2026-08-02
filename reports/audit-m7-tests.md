# Milestone 7 audit — the test suites as a development cost

**Lens:** where suite time goes, and what it costs to iterate against these gates.
**Range:** `be7508a..a912606` (33 commits). **Written:** 2026-08-01.
**Not a correctness audit.** Nothing here says a test is wrong; it says what a test costs.

**Provenance.** Every number below is parsed from the verifier's own run at 20:18–20:22
(`logs/verify/playwright.json`, `logs/verify/vitest.json`, `reports/completion_verification.json`,
`logs/verify/*.log` mtimes) or measured directly by this audit. The E2E suite was not re-run.
Load average was 2.5–3.3 throughout and a workflow had been building all day — **rank these
numbers, do not quote them as constants.** Ratios are stable; absolute seconds are not.

A read-only pass earlier today (scratchpad `test-audit.md`, taken at 16:22 against 111 tests in 31
files) is validated and extended here. The last section lists where this audit **corrects** it.

---

## Baseline

| gate | wall | share |
|---|---|---|
| `python3 scripts/verify_completion.py` | **255.8 s** | 204 checks, 203 pass |
| ├ vitest | 5.6 s | 2.2 % |
| ├ **playwright** | **245.2 s** | **95.9 %** |
| ├ typecheck | 0.4 s | — |
| ├ lint | 3.5 s | 1.4 % |
| └ statics + git (incl. `git ls-remote`) | 0.5 s | — |
| `pnpm test` alone | ~5.6 s | 838 tests, 64 files |
| `pnpm test:e2e` alone | ~245 s | 128 tests, 36 files |

Phase boundaries from `logs/verify/*` mtimes against `duration_seconds: 255.8` in
`reports/completion_verification.json`.

**The verifier is the Playwright suite.** Everything else in it is rounding error, and has been
since milestone 4. What changed in milestone 7 is the size of the one thing that matters:

| | at the 16:22 sample | now | Δ |
|---|---|---|---|
| E2E tests / files | 111 / 31 | **128 / 36** | +15 % / +16 % |
| E2E wall | 163.9 s | **245.2 s** | **+50 %** |
| verifier wall | 175.5 s | **255.8 s** | **+46 %** |

Milestone 7 added ~80 s to every gate run in a single day, most of it after the earlier audit was
taken. Nothing in the tree watches this number.

**Distribution.** median test 1.29 s · p95 3.55 s · min 1.24 s · slowest 5.5 s
(`zotero-snapshot.spec.ts:123`). Slowest files: `journal.spec.ts` 20.5 s (11 tests) ·
`wiki.spec.ts` 14.1 s (9) · `zotero-snapshot.spec.ts` 13.1 s (3) · `shell.spec.ts` 12.0 s (7) ·
`graph.spec.ts` 11.5 s (7) · `notebook-landing.spec.ts` 11.1 s (5).

---

## Findings

### 1 · MAJOR — 74 % of the E2E suite is Electron process startup, and `workers: 1` serializes all of it

`tests/e2e/playwright.config.ts:26-27`

```ts
fullyParallel: false,
workers: 1,
```

**The measurement.** Every test's launch count was derived from source (the `window`/`launched`
fixture auto-launches; `launchApp(` is an explicit relaunch) and regressed against the measured
durations in `logs/verify/playwright.json`:

```
model total: 78 auto-launches + 79 explicit launchApp = 157
log:  grep -c "Debugger ending on ws" logs/verify/playwright.log = 157   ← exact match

  1-launch tests:  99   median 1.29 s   min 1.24 s
  2-launch tests:  29   median 2.55 s   min 2.52 s

  fit:  duration = 0.47 s + 1.11 s per launch
  →  157 × 1.11 s = 174 s of 234.6 s test time = 74 % is `electron.launch` + `app.close`
```

The marginal cost of a launch (1.26 s between the two medians) is larger than the *median whole
test*. Actual assertion work in the entire suite is about 60 s. There is nothing to optimise inside
the tests; there is one launch cost paid 157 times in series.

**The stated reason is contradicted by the suite's own harness.** `playwright.config.ts:11-13`:

> *"One worker, no parallelism: … running several Electron apps at once on macOS makes window
> focus — which real keyboard input depends on — nondeterministic."*

`tests/e2e/support/app.ts:58-60`:

> *"Background mode keeps the window off the dock and out of the foreground; Playwright drives over
> CDP, **which injects input without OS focus**, so every interaction still works exactly as it
> would in front."*

`WR_BACKGROUND=1` is set on every launch (`app.ts:61`) and no window is ever shown. There is no
focus to contend for. The config comment is a fossil from before background mode existed, and it is
load-bearing misinformation — it is the reason nobody has tried.

**Isolation is already per-test and already parallel-safe**, re-verified against the milestone-7
tree (which added two new on-disk caches):

- `tests/e2e/support/workspace.ts:419` — `realpathSync(mkdtempSync(join(tmpdir(), 'wr-e2e-')))`
- `apps/desktop/src/main/services.ts:472,477` — card-art and agent roots resolve *beside the
  database*, so `B06`'s cache and the librarian's workspace are per-temp-dir
- the demo library's markdown root, same rule (`services.ts:143`)
- `tests/e2e/support/zotero-api.ts:60` — `server.listen(0, …)`, ephemeral port; the only listener
- no `requestSingleInstanceLock` anywhere in `apps/desktop/src/main/`
- no `localStorage`/`sessionStorage` anywhere in the renderer

**One prerequisite.** `apps/desktop/src/main/index.ts:257` falls back to `app.getPath('userData')`.
The suite always overrides the *database* path, but Chromium's **profile** directory (SingletonLock,
GPU cache, LevelDB) is still shared by every concurrent instance. Give each launch its own, at
`tests/e2e/support/app.ts:64`:

```ts
const app = await electron.launch({
  args: [DESKTOP_DIR, `--user-data-dir=${join(workspace.dir, 'chrome')}`],
  env,
});
```

**Change.** `workers: 4`, keep `fullyParallel: false` (so a file's tests stay in declaration order
inside one worker), add `--user-data-dir`, and rewrite the comment at `:11-13`.

**Expected.** 234.6 s of test time over 4 workers, floor-bounded by the longest file (20.5 s), with
CPU contention slowing each launch: **245 s → 80–110 s**, and the verifier **256 s → ~95–125 s**.
Measure it; do not assume the ideal 60 s.

**Caveat that matters more than usual.** Retries cannot paper over parallel flake here:
`scripts/verify_completion.py:838-841` fails `tests: e2e suite green` if *any* result failed, and
`:376-380` marks a tag failed if any tagged spec failed — a retried-then-passed test still fails the
gate. Prove stability before committing: `pnpm test:e2e --workers=4 --repeat-each=3`, three clean
passes. If one file is unstable, pin it with `test.describe.configure({ mode: 'serial' })` rather
than dropping `workers` globally. (No file uses that today — `grep` finds zero.)

---

### 2 · MAJOR — the red-test trap, and the verifier's 40-minute blind kill on top of it

Four numbers compound:

| where | value |
|---|---|
| `tests/e2e/playwright.config.ts:31` | `timeout: 180_000` |
| `tests/e2e/playwright.config.ts:32` | `expect: { timeout: 30_000 }` |
| `tests/e2e/support/app.ts:85` | `waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 })` |
| `tests/e2e/playwright.config.ts` | no `use.actionTimeout`, no `maxFailures`, `retries: 0` |

**Measured, not estimated.** `logs/e2e-align.log:247` and `:536` — two real failures from this
milestone's alignment pass:

```
✘ ledger.spec.ts:345 › [H04] picks the other end from the graph …            (31.4s)
✘ wiki.spec.ts:307   › [F02] puts a file's highlights centre-stage …         (32.2s)

TimeoutError: locator.click: Timeout 30000ms exceeded.
  - <svg … class="wr-graph__canvas" …> intercepts pointer events
```

Against a **1.29 s median**, one red assertion costs **31 s — a 24× penalty**, and the run was
`5.1m` instead of `~4.1m` for two of them. That is the cheap failure mode.

**The expensive one is a fixture break** — a renderer exception, which is exactly what the
label-halo regression in `state/NEXT_ACTION.md` produced. Then every test waits the full 60 s at
`app.ts:85`: `journal.spec.ts` alone is 11 × 60 s = **11 min**, and the whole suite is
128 × 60 s ≈ **128 min**.

**And 128 min does not happen — something worse does.** `scripts/verify_completion.py:813` runs the
suite with `timeout=2400` (40 min). `run()` at `:302-314` uses `capture_output=True` and on timeout
returns `(124, "", "timed out after 2400s")` — **stdout is discarded entirely**. The JSON report was
already unlinked at `:805` and the JSON reporter only writes at the end, so `e2e_json` does not
exist and the stdout fallback at `:824-831` has nothing to parse. Result: `tests: e2e produced
results` fails, and `check_tags` then reports **`no test tagged [X]` for all 85 E2E tags**. Forty
minutes of machine time produce zero diagnosis and 86 misleading failures.

`capture_output=True` also means a *healthy* verifier run prints nothing for four minutes.

**Change.**

- `use: { …, actionTimeout: 10_000 }` — **this is the one the earlier audit missed.** The measured
  failure above was `locator.click`, not `expect`; lowering `expect.timeout` alone would not have
  capped it. Playwright 1.62's action default is 30 s when `actionTimeout` is unset.
- `expect: { timeout: 10_000 }` (~3× p95), `timeout: 60_000` (11× the slowest observed test).
- `app.ts:85` → `{ timeout: 30_000 }`.
- Give the **dev loop** `--max-failures=1` on the CLI. Do **not** put `maxFailures` in the config:
  the verifier needs a complete run to map every tag, and an early stop would report untested tags
  as "no test tagged" — the same false red as above.
- In the verifier, drop the e2e `timeout` to something under the worst honest run
  (e.g. 900 s once #1 lands) and stream the child's output to the log file instead of buffering it,
  so a kill leaves evidence.

**Expected.** Nothing on green. Caps a broken file at ~1–2 min instead of 11–33 min, and turns the
40-minute silent failure into a diagnosable one. This is the largest drag on *iteration* even though
it is invisible in the green baseline.

---

### 3 · MAJOR — 45 of 128 E2E tests (87.4 s, 37 %) are surplus to every tag promise, and there is no tier to defer them into

The verifier's law is that every tag keeps a passing test. Computing the **minimum set of E2E tests
that keeps all 85 `E2E_TAGS` green**:

```
minimum covering set:   83 tests   147.2 s
surplus to the tags:    45 tests    87.4 s   (37 % of the suite)
```

The surplus falls into three kinds, and they are **not** equally safe:

| kind | tests | cost | what it is |
|---|---|---|---|
| same-tag duplicate | 30 | 50.5 s | a tag with 2–4 E2E tests |
| `UX*` tier | 10 | 29.1 s | invisible to `TAG_RE` — see finding 7 |
| unit-gated tag | 5 | 7.7 s | tag is in `UNIT_TAGS`, so the verifier reads it from vitest only |

The five unit-gated ones, each verified against `scripts/verify_completion.py:35-107`:

```
journal.spec.ts:122   [J01]  (UNIT_TAGS:77)   2.6 s
journal.spec.ts:168   [J03]  (UNIT_TAGS:79)   1.3 s
library.spec.ts:174   [B03]  (UNIT_TAGS:98)   1.3 s
notebook.spec.ts:87   [N01]  (UNIT_TAGS:92)   1.3 s
ledger.spec.ts:216    [E03]  (UNIT_TAGS:106)  1.3 s
```

The largest same-tag clusters: `[O01]` ×4 in `guide.spec.ts:42,75,119,190` · `[R01]` ×4 in
`context-menu.spec.ts:43,107,156,224` · `[P01]` ×3 in `notebooks.spec.ts:32,129,164` · `[D03]` ×3 in
`help.spec.ts:39,72,135` · `[B06]` ×3 in `card-art.spec.ts:39,111,150` · `[N07]` ×3 in
`notebook-landing.spec.ts:212,249,307`.

**The recommendation is a tier, not a deletion.** Every one of these still gates through
`tests: e2e suite green` (`verify_completion.py:838-841`), and several are load-bearing in ways a
tag count cannot see — `ledger.spec.ts:205-214` says so in its own words:

> *"the `[E03]` integration test is a good test that stops at the channel, and the one E2E that
> names a highlight group names a highlight that already has a link."*

`[J01]`'s E2E is a restart at the UI, which the four vitest `[J01]` tests cannot be. Delete none of
them. Mark them so the **per-commit** loop can skip them and the **per-track** loop cannot.

**Two traps for whoever does this.**

1. **A vitest test carrying an E2E tag proves nothing to the gate.** 44 E2E-gated tags also appear
   in vitest titles — `[F01]` ×12 (`packages/graph/test/graph.test.ts`,
   `packages/workbench/test/panel-targets.test.ts`, `tests/integration/graph.test.ts`), `[S02]` ×20
   (`tests/integration/markdown-math.test.ts`), `[R01]` ×9 (`packages/workbench/test/menus.test.ts`),
   `[O01]` ×12, `[B06]` ×7, `[N11]` ×8. Those tags are checked **only** against Playwright results
   (`verify_completion.py:842`). Deleting `wiki.spec.ts`'s single `[F01]` because "twelve unit tests
   cover it" fails the gate immediately. **The only E2E tests that may be thinned are those whose
   tag is in `UNIT_TAGS`, or whose tag keeps another passing E2E test.**
2. The 45-test list above was computed by picking the *cheapest* test per tag, which is sometimes
   backwards — for `[P07]` it keeps `blocks.spec.ts:181` (the journal) and defers `:126` (the
   notebook page), which is the wrong half. **Treat the list as a candidate pool; choose by hand.**

**Expected.** ~87 s off the per-commit loop at 1 worker, ~25 s at 4 workers. Zero off the gate,
by design.

---

### 4 · MAJOR — no gate ladder is documented, and the two cheapest mistakes each cost four minutes

`docs/LOOP.md` (50 lines) documents the audit gate only; `docs/AGENTS.md`, `CLAUDE.md` and
`state/NEXT_ACTION.md` list the commands but never say **which to run when**. The consequences are
in the tree:

- **Running `pnpm test:e2e` full and the verifier in the same checkpoint costs 500 s where 256 s
  would do.** `verify_completion.py:813` *is* the full E2E run. This is the single largest avoidable
  cost in the loop as it stands, larger than every optimisation in this report except #1.
- **`state/iteration_ledger.jsonl` records the `--` trap already paid for once:**
  > *"`pnpm test:e2e -- --grep`, which pnpm swallowed, so it ran the whole suite instead of one
  > test. Killed it and proved the test load-bearing by mutation afterwards instead."*

  Verified in this audit: `pnpm test:e2e --grep-invert "\[UX"` (no `--`) correctly lists
  **118 tests in 32 files**; `pnpm test:e2e --list` lists 128 in 36. The ladder below spells the
  working form.

The ladder is in its own section at the end of this report.

---

### 5 · MINOR — 62 explicit `timeout: 30_000` restate the config default, and would silently defeat finding 2

63 sites in `tests/e2e/` spell `timeout: 30_000`; 62 of them are on an `expect(…)` — exactly
`playwright.config.ts:32`'s default. They buy nothing today and would keep all 62 assertions at 30 s
after the default is lowered. Concentrations: `library.spec.ts` ×11, `webpage.spec.ts` ×7,
`notebook-landing.spec.ts` ×7, `notebook-page.spec.ts` ×4, `journal.spec.ts` ×4, `blocks.spec.ts` ×4.
Milestone 7 added 15 of them.

Above the default, 13 sites raise to 60 s (`pdf-fidelity.spec.ts:115`, `reading-surface.spec.ts:76,122`,
`ledger.spec.ts:82`, `zotero-snapshot.spec.ts:95,134,179`, `links.spec.ts:249`, `library.spec.ts:241`,
`keyboard.spec.ts:80`, `linking.spec.ts:86`, `support/corpus.ts:91`, `support/app.ts:85`). Those are
the real per-assertion ceilings; each should be justified or cut. Most look copied rather than
measured.

**Change.** Delete every `timeout: 30_000` that merely restates the default, in the same commit that
lowers it. Otherwise finding 2 lands as a no-op across a third of the suite.

---

### 6 · MINOR — 15.8 s of literal `waitForTimeout`, 8.3 s of it after a signal that already resolved

Eleven sleeps, 15,800 ms, 6.7 % of test time — unchanged from the earlier audit and unchanged by
milestone 7 (which added none, to its credit).

**Redundant — a positive signal already resolved on the line above, and in three cases the *next*
line is itself a waiting assertion:**

| site | ms | what precedes it |
|---|---|---|
| `zotero-snapshot.spec.ts:180` | 3000 | `waitForSelector('snapshot-frame')`; **line 183** is `expect(frame.locator('snapshot-heading')).toBeVisible()` |
| `zotero-snapshot.spec.ts:96` | 1500 | `waitForSelector('snapshot-frame')` at `:95` |
| `zotero-snapshot.spec.ts:135` | 1500 | `waitForSelector('snapshot-frame')` at `:134`; `:137` asserts the heading |
| `reading-surface.spec.ts:124` | 1000 | `waitForSelector('[data-testid="pdf-page-0"][data-rendered="true"]')` — the attribute *is* the signal |
| `reading-surface.spec.ts:164` | 1000 | `waitForSelector('[data-testid^="pdf-highlight-"]')` |
| `reading-surface.spec.ts:156` | 300 | `waitForSelector('create-highlight')` |

**Defensible, because the claim is negative** — shorten and anchor, do not delete:
`zotero-snapshot.spec.ts:148,150` (3000 ms, bracketing the annotations toggle for `[UX07]`
"the frame was not reloaded" — the honest anchors are *panel visible* then *panel hidden*),
`pdf-fidelity.spec.ts:117` (2500 ms), `webpage.spec.ts:299` (1500 ms, a debounced persist before
`app.close()`), `reading-surface.spec.ts:77` (500 ms, before reading computed styles).

The suite already contains the honest form of the debounce wait: `blocks.spec.ts:153-154` polls the
database with `expect.poll(() => storedBody(workspace, notebookId), { timeout: 15_000 })`.

**Expected.** ~10 s. Note this saving **does not shrink under parallelism** — a sleep is wall time
inside a worker — but it is concentrated in `zotero-snapshot.spec.ts` (9 s of a 13.1 s file, 69 %),
which is not the critical path once #1 lands. **Do this after #1, one sleep at a time, each validated
with `--repeat-each=5`.** A sleep replaced by the wrong condition reintroduces flake in exactly the
tests that were made flake-proof by sleeping.

---

### 7 · MINOR — the `UX*` tier is enforced by nothing but "suite green", and nothing says so

`scripts/verify_completion.py:204`:

```python
TAG_RE = re.compile(r"\[([A-Z]\d{2})\]")
```

One letter, two digits. `[UX07]` never matches, and `UX01`–`UX09` are in neither `UNIT_TAGS` nor
`E2E_TAGS`. Ten tests, **29.1 s (12 % of the suite)**: `zotero-snapshot.spec.ts:86,123,158` ·
`reading-surface.spec.ts:71,86,116` · `pdf-fidelity.spec.ts:52,89` · `import.spec.ts:15,39`.

These are real regression tests for real past bugs (a phone layout in a reading panel, a saved page
reloading on any workspace re-render, a PDF drawing boxes instead of glyphs) and must stay. But no
criterion depends on them, and nothing in `docs/` says that is deliberate.

**Decide it, either way.** Widen `TAG_RE` to `\[([A-Z]{1,2}\d{2})\]` and add the nine to `E2E_TAGS`
— a *strengthening*, which `CLAUDE.md` permits, and which immediately adds nine required tags — or
write in `docs/` that `UX*` is a second tier the verifier deliberately does not gate. Leaving it
implicit is how it rots: `[UX09]` is already two tests for one number nobody counts.

---

### 8 · MINOR — `--fast` gives no tag feedback, so the loop pays 256 s for a check it wanted in 12 s

`scripts/verify_completion.py:797-799`:

```python
if args.fast:
    record("tests: e2e executed", False, "--fast supplied; e2e skipped")
    ok = False
```

`--fast` skips e2e *and* prints nothing about any of the 85 E2E criteria, so an agent that wants to
know which tags are red runs the full 256 s — repeatedly.

**Change (a development affordance, not a gate change).** Keep the hard `ok = False`, but have
`--fast` additionally read the *existing* `logs/verify/playwright.json` and print the same tag table
prefixed `[STALE <mtime>]`. Add `--only=<regex>` to filter which criteria print. The executed-check
still fails, so `--fast` can still never exit 0.

The invariant to write into the module docstring and keep: **any reduced mode sets `ok = False`
unconditionally, before any other logic.** With that, a fast mode cannot weaken the gate by
construction. This is a strengthening of the docstring, not of the checks — permitted.

**Expected.** Most in-loop verifier calls go 256 s → ~12 s, while the closing gate is bit-for-bit
what it is today.

---

### 9 · MINOR — `pnpm build` spawns 15 `tsc` processes for work one process already does

`package.json:13` → `pnpm -r --filter=!@wr/desktop build && pnpm --filter @wr/desktop build`, run
unconditionally by `tests/e2e/support/global-setup.ts:16-21` before every `pnpm test:e2e`.

**Measured on this machine, warm:**

```
pnpm -r --filter='!@wr/desktop' build      2.09 s   (15 × `tsc -b`, one process each)
pnpm typecheck  (tsc -b tsconfig.build.json)  0.44 s   (all 16 projects, one process)
pnpm -r --filter='!@wr/desktop' exec node -e ""  0.72 s   (pnpm recursion alone)
electron-vite build                        ~4.2 s   (1.57 + 0.007 + 2.58, logs/verify/playwright.log)
```

`tsconfig.build.json` already declares references for all 16 projects; every package tsconfig is
`composite` with `outDir: ./dist`, and `apps/desktop/tsconfig.json` is `emitDeclarationOnly` to
`out/types`. `pnpm typecheck` already runs exactly this and the verifier already passes it, so the
emit is the same work with 1/15 of the process overhead.

**Change.** `"build": "tsc -b tsconfig.build.json && pnpm --filter @wr/desktop build"`. Verify once
that `dist/` is identical.

**Expected.** ~1.6 s per `pnpm test:e2e`, `pnpm build` and `pnpm package`. **Smaller than the earlier
audit's ~4–5 s estimate** — that was extrapolated from a per-process `tsc --version` load; measured,
the 15 spawns cost 2.09 s total, not 5 s. Take it because it is two words and no risk, not because
it is a win.

---

### 10 · MINOR — only two spec files can safely share an app; the rest of the "read-only" idea does not survive contact

157 launches for 128 tests is already minimal *for the current design*: the model matches the log
exactly, and no test both auto-launches and relaunches. The 79 explicit `launchApp` calls are the
restart-shaped criteria, which is the point of them (`tests/e2e/support/app.ts:5-7`).

The only saving left is files whose tests never write. Checked one by one against the milestone-7
tree, the genuinely safe set is small:

| file | tests | safe? |
|---|---|---|
| `guide.spec.ts` | 4 × `[O01]` | **yes** — opens the guide and help pages, reads, asserts |
| `help.spec.ts` | 3 × `[D03]` | **yes** — reads cards, `emulateMedia`, restores at `:161` |
| `sidebars.spec.ts` | 4 | **no** — toggling sidebars mutates persisted workspace layout |
| `tabs.spec.ts` | 3 | **no** — `[U01]`/`[U02]` are tab-group mutations |
| `context-menu.spec.ts` | 4 × `[R01]` | **no** — `:156` opens a notebook and adds a block |
| `reader.spec.ts` | 5 | **no** — `[M11]` creates a highlight |
| `shell.spec.ts` | 7 | partly — `[M01]`/`[M02]` read, others do not |

**Change.** For `guide.spec.ts` and `help.spec.ts` only: `test.describe.configure({ mode: 'serial' })`
plus one app in `beforeAll`/`afterAll`. Nothing is deleted or merged — every title and every `[tag]`
stays exactly where it is, so `verify_completion.py` sees the same spec titles.

**Expected.** 5 launches saved ≈ **5.5 s** at 1 worker; less after #1, since parallelism already
hides launch cost. Do this last, or not at all.

---

### 11 · MINOR (no change) — unit/integration is not the problem, and the repeated DB setup is measured

`logs/verify/vitest.json`: 838 tests, 64 files, 15.0 s summed file time, ~5.6 s wall under
`pool: 'forks'`. **2.2 % of the gate.** Three things checked and found not to be issues:

- **Repeated migration/DB setup, measured rather than assumed.** A fresh temp file plus the full
  16-migration chain costs **10.0 ms** (40 iterations, benchmarked through `openDatabase` and
  discarded — the tree was left clean). 381 tests live in `tests/integration/` and
  `packages/database/test/`; if *every one* opened its own, that is **3.8 s of the 15.0 s file
  time (25 %)**, or roughly **1.4 s of wall** after fork parallelism. A shared template database
  would buy ~0.5 % of the gate and would cost exactly the per-test isolation `pool: 'forks'` was
  chosen for (`vitest.config.ts:14-15`). **Do not do it.**
- **Slowest file** is `tests/integration/graph.test.ts` at 3.29 s, of which 2.21 s is two deliberate
  scale guards: `[F01] ranks the library without a per-row existence check over every link` (1.90 s)
  and `[F02] counts every connected file it left out` (0.31 s). The file records why —
  *"9,041 ms against 124 ms at 3,000 papers"*. Cheapest possible insurance against a 9-second
  regression. **Keep them.**
- **No accidental E2E-shaped work.** The only subprocess spawning is the librarian's
  `fake-claude.mjs` (`tests/integration/support/workspace.ts:38-46`), and the runner's contract *is*
  about a process — argv, exit code, refusal to die on SIGTERM.

Milestone 7's own vitest additions are cheap and correctly placed: `block-source.test.ts` (104 lines,
the pure half of the block editor), `snippet.test.ts` (55), `guide.test.ts` +63, `layout.test.ts` +86,
`demo.test.ts` (193 lines, 0.39 s). This is the right side of the pyramid and it is being used.

---

## Recommended gate ladder

Three rungs. The rule that keeps it honest: **never run `pnpm test:e2e` full *and* the verifier in
the same checkpoint — the verifier is the full E2E run.**

**Per commit — target under 30 s.**

```bash
source ~/.nvm/nvm.sh && nvm use
pnpm test                       # 5.6 s — always whole; cheaper than deciding what to skip
pnpm typecheck                  # 0.4 s warm
pnpm test:e2e tests/e2e/<the-file-you-touched>.spec.ts --max-failures=1
```

No `--` before Playwright's flags — pnpm swallows it and you get the whole suite (recorded in
`state/iteration_ledger.jsonl`; re-verified today). One file is build (~6 s, ~4.5 s after #9) plus
the file's own time: `blocks.spec.ts` ≈ 14 s, `journal.spec.ts` ≈ 27 s. `--max-failures=1` is what
keeps a bad commit from costing eleven minutes.

**Per track / before a checkpoint — target under 90 s after #1.**

```bash
pnpm test:e2e --grep-invert "\[UX" --max-failures=1   # 118 tests, 32 files (verified)
pnpm lint
python3 scripts/verify_completion.py --fast           # ~12 s once #8 prints the stale tag table
```

Then commit and push — the verifier needs a clean tree on `origin/main`. Run the `UX` tier once at
the end of the track: `pnpm test:e2e --grep "\[UX"`.

**Per milestone close — the gate, unchanged.**

```bash
git push
python3 scripts/verify_completion.py     # 256 s today; ~95–125 s after #1
WR_BACKGROUND=1 pnpm package
```

**This is the only run that may be cited as evidence.** Nothing above it is. Then the bundle swap
per `state/NEXT_ACTION.md`.

**One number to keep.** Record the verifier's `duration_seconds` in
`state/iteration_ledger.jsonl` at each milestone close. It went 175.5 s → 255.8 s during milestone 7
with nothing watching; at that rate milestone 8 closes above five minutes, and the per-commit rung
becomes the only affordable one.

---

## Combined effect

| | today | after #1 | after #1+#2+#3 |
|---|---|---|---|
| `pnpm test:e2e` full | 245 s | 80–110 s | same (#2/#3 buy nothing on green) |
| `verify_completion.py` full | 256 s | 95–125 s | same |
| per-commit rung | — | — | ~20–30 s |
| per-track rung | 245 s | ~85 s | ~65 s (UX tier deferred) |
| a broken spec file | 11–33 min | 11–33 min | ~1–2 min |
| a broken *fixture* | 40 min, no output | 40 min, no output | ~10 min, with a report |
| `pnpm test` | 5.6 s | 5.6 s | 5.6 s |

**#1 is ~85 % of the available saving and is four lines.** #2 changes nothing green and everything
red. #3 and #8 change no test at all — they change what the loop chooses to run, which given how
often these gates are invoked may be worth more than either.

---

## Corrections to the earlier read-only audit (scratchpad `test-audit.md`, 16:22)

Its structure and its top three conclusions hold. Four numbers have moved or were wrong:

1. **Baseline is stale by 50 %.** It sampled 111 tests / 163.9 s e2e / 175.5 s verifier; the tree now
   stands at 128 / 245.2 s / 255.8 s. Its "combined effect" table understates every row.
2. **Launch share was inferred; it is now measured.** It read 139 launches for 111 tests
   ("1.25/test", "mean 1.1 s"). The current tree is 157 for 128, and the regression gives
   `0.47 s + 1.11 s/launch` → **74 % of test time**, which is a stronger argument for #1 than the
   one it made.
3. **Finding #3's saving was 2.5× overstated.** It extrapolated ~5 s of no-op `tsc` spawns from a
   `tsc --version` load; measured, `pnpm -r build` warm is **2.09 s** against **0.44 s** for
   `tsc -b tsconfig.build.json`. Real saving ~1.6 s, not 4 s. The change is still right; its rank
   is not.
4. **Finding #2 was incomplete.** It recommended lowering `expect.timeout`. The failure actually
   measured in `logs/e2e-align.log` is `locator.click: Timeout 30000ms exceeded` — an *action*
   timeout, unaffected by `expect.timeout`. `use.actionTimeout` must be set too. It also missed that
   `verify_completion.py:302-314` discards stdout on its own 2400 s kill, which is what makes a
   fixture break undiagnosable rather than merely slow.

Extended here: the minimum-covering-set computation and the `UNIT_TAGS`-vs-`E2E_TAGS` thinning rule
(finding 3), the measured 10 ms DB-open cost (finding 11), the 62 redundant `timeout: 30_000`
(finding 5), the milestone-7 growth rate, and the ladder's verified command forms.

---

*Nothing in the tree was modified by this audit. The E2E suite was not re-run; vitest was invoked
once, on a temporary file that was removed (`git status` clean afterwards).*
