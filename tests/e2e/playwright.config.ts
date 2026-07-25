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
 * One worker, no parallelism: each test launches its own Electron process against its own
 * temporary database, and running several Electron apps at once on macOS makes window
 * focus — which real keyboard input depends on — nondeterministic.
 *
 * The JSON reporter here writes to `logs/e2e-report.json`, not to the path the verifier
 * reads. `scripts/verify_completion.py` re-runs this suite with `--reporter=json` and points
 * `PLAYWRIGHT_JSON_OUTPUT_NAME` at `logs/verify/playwright.json`, unlinking it first, so a
 * stale passing report can never outlive a failing run.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A cold Electron start plus PDF.js rendering a real document is comfortably slower than
  // the default 30s, and a timeout here would read as a product failure.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['json', { outputFile: '../../logs/e2e-report.json' }]],
  outputDir: '../../logs/playwright-artifacts',
  use: { trace: 'off', video: 'off', screenshot: 'only-on-failure' },
});
