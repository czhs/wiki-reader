/**
 * Playwright configuration for the Electron end-to-end suite.
 *
 * These specs own the criteria that cannot be honestly proved without a real Electron
 * process: that the app launches with its security invariants intact (M01), that the
 * Dockview workspace renders (M02), that imported items reach the sidebar (M05), that a
 * Zotero PDF attachment opens and renders through `rrfile://` (M06), that two readers sit
 * side by side (M07), that a real text selection becomes a highlight (M11), that F12 follows
 * the link under the cursor (L02), and that the references panel survives navigation (L08).
 *
 * **Four workers, one file at a time each.** Three quarters of this suite's wall clock is
 * Electron process startup — 157 launches at about 1.1s each — so the worker count is the
 * single largest lever on what a checkpoint costs. It used to be one, justified by macOS
 * window-focus nondeterminism; the harness itself contradicts that, because Playwright drives
 * over CDP (`support/app.ts`), which injects input without OS focus, and `WR_BACKGROUND=1` is
 * set on every launch so no window is ever shown. What isolation genuinely needs is that two
 * apps share nothing, and they do not: a per-test `mkdtemp` workspace, card-art, agent and
 * demo roots resolved beside that database, an ephemeral Zotero port, no single-instance
 * lock, and a Chromium profile directory of its own passed at launch.
 *
 * `fullyParallel: false` stays: files run in parallel, tests within a file do not, so a spec
 * that walks one workspace through several launches still runs in order.
 *
 * **The timeouts are caps, not comfort.** The median test takes 1.3s and the slowest observed
 * about 5.5s, so 180s per test and 30s per assertion were not budgets, they were the cost of
 * being wrong: a single broken fixture made every one of 129 tests wait a full minute, which
 * the verifier then killed at its own 2400s having produced no diagnosis at all. `actionTimeout`
 * is set explicitly because it is otherwise Playwright's own 30s default — lowering
 * `expect.timeout` alone would not have capped a `locator.click`.
 *
 * The JSON reporter here writes to `logs/e2e-report.json`, not to the path the verifier
 * reads. `scripts/verify_completion.py` re-runs this suite with `--reporter=list,json` and
 * points `PLAYWRIGHT_JSON_OUTPUT_NAME` at `logs/verify/playwright.json`, unlinking it first,
 * so a stale passing report can never outlive a failing run.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './support/global-setup.ts',
  fullyParallel: false,
  workers: 4,
  retries: 0,
  // 11× the slowest test observed on this machine. A cold Electron start plus PDF.js rendering
  // a real document is the thing being allowed for; anything past this is a hang.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: '../../logs/e2e-report.json' }]],
  outputDir: '../../logs/playwright-artifacts',
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    // Never inherited from `expect.timeout` — Playwright applies its own 30s default to
    // actions, which is where the two real failures of this milestone spent 30 of their 31s.
    actionTimeout: 10_000,
  },
});
