/**
 * The Playwright fixtures every spec uses: a seeded workspace and a running Electron app.
 *
 * Each test gets its own temporary library and its own Electron process. That is slower than
 * sharing one instance, but it is the only way the restart-shaped criteria can be honest —
 * and it means one spec leaving a highlight behind cannot change what another spec sees.
 *
 * The app is pointed at the temporary workspace with the same environment variables the main
 * process already reads in production (`WR_DATABASE_PATH`, `WR_ZOTERO_DATA_DIR`), plus
 * `WR_BACKGROUND` to keep an unattended run from stealing focus. All three are real runtime
 * modes; no test-only branch exists in the application for the suite's benefit.
 */
import {
  _electron as electron,
  expect as playwrightExpect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, type E2EWorkspace } from './workspace.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly window: Page;
}

/**
 * Start Electron against an existing workspace.
 *
 * Exported separately from the fixture because the restart criteria need to stop the app and
 * start a second one over the *same* database directory.
 *
 * `extraEnv` is for runtime configuration a single spec needs — `WR_ZOTERO_ENDPOINT` pointing
 * at the fixture API, so an import can be driven from inside the running app (criterion B05).
 * Real variables the production main process reads, like the four below.
 */
export async function launchApp(
  workspace: E2EWorkspace,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<LaunchedApp> {
  // Launched from a directory rather than a packaged bundle, so `app.isPackaged` is false and
  // the main process takes its dev branch. That branch loads `ELECTRON_RENDERER_URL` when the
  // variable is *defined*, so it has to be absent — not empty — or the window navigates to
  // the empty string and never renders the built bundle.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RENDERER_URL' || value === undefined) continue;
    env[key] = value;
  }
  env['WR_DATABASE_PATH'] = workspace.databasePath;
  env['WR_ZOTERO_DATA_DIR'] = workspace.zoteroDataDir;
  // The corpus root is main-process configuration in production too — the renderer never
  // names a folder to read, so pointing the app at the temporary wiki is an environment
  // variable here exactly as it would be on a real machine.
  env['WR_MARKDOWN_ROOT'] = workspace.corpusRoot;
  // Same reasoning: where the librarian's workspace lives is main-process configuration, and
  // pointing a temporary library at its own is exactly what a second installation would do.
  env['WR_AGENT_ROOT'] = workspace.agentRoot;
  // The suite runs unattended on a machine someone else is using. Background mode keeps the
  // window off the dock and out of the foreground; Playwright drives over CDP, which injects
  // input without OS focus, so every interaction still works exactly as it would in front.
  env['WR_BACKGROUND'] = '1';
  Object.assign(env, extraEnv);

  // A Chromium profile of its own, inside this test's workspace. Everything else the app
  // touches is already per-workspace — the database, the corpus, the agent root, the card-art
  // cache — but the profile directory comes from `app.getPath('userData')`, which is one
  // shared directory for every launch. It is the one thing four workers would contend on.
  const app = await electron.launch({
    args: [DESKTOP_DIR, `--user-data-dir=${join(workspace.dir, 'chrome')}`],
    env,
  });

  // Electron's own stderr is the only place a main-process crash is reported; without this a
  // failed launch reads as an unexplained `firstWindow` timeout.
  app.process().stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[electron] ${chunk.toString()}`);
  });

  const window = await app.firstWindow();

  // A renderer exception unmounts the React tree, which shows up downstream as "the panel
  // never appeared" rather than as the error it actually was. Surface both here.
  window.on('pageerror', (error) => {
    process.stderr.write(`[renderer] uncaught: ${error.stack ?? error.message}\n`);
  });
  window.on('console', (message) => {
    if (message.type() === 'error') process.stderr.write(`[renderer] ${message.text()}\n`);
  });
  await window.waitForLoadState('domcontentloaded');
  // The shell mounts only after the renderer has its first IPC response, so every spec can
  // assume the workspace is interactive from here.
  // 30s, not 60. A shell that has not mounted in half a minute is a renderer exception, not a
  // slow machine — and this wait is what every test in a broken run pays, one after another.
  await window.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 });
  return { app, window };
}

/**
 * Resize the window the way a hand does, and wait for the page to have been told.
 *
 * `page.setViewportSize` is a browser-context idea and does nothing to an Electron window, so
 * this goes through the main process. The wait is on the renderer's own `innerWidth`, because
 * `setBounds` returns before the web contents have relaid out and every measurement taken in
 * between is of the old size.
 */
export async function resizeWindow(
  launched: LaunchedApp,
  width: number,
  height: number,
): Promise<void> {
  const before = await launched.window.evaluate(() => window.innerWidth);
  const centreBefore = await launched.window.evaluate(
    () => document.querySelector('[data-testid="dockview-container"]')?.clientWidth ?? 0,
  );
  await launched.app.evaluate(
    ({ BrowserWindow }, size) => {
      const [first] = BrowserWindow.getAllWindows();
      first?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  // Waited for by *change*, not by target: the window has a `minWidth`, so asking for less
  // than that is answered with the minimum, and waiting for a number it is not allowed to
  // reach is ten seconds spent per call for nothing.
  if (before === width) return;
  await launched.window.waitForFunction((was) => window.innerWidth !== was, before, {
    timeout: 10_000,
  });
  // And then for the workspace to have been told. Dockview relayouts from a `ResizeObserver`,
  // so the page knowing its new width and the tab strip having been laid out at that width are
  // two different frames — every measurement taken in between is of the size before.
  if (centreBefore === 0) return;
  await launched.window.waitForFunction(
    (was) => (document.querySelector('[data-testid="dockview-container"]')?.clientWidth ?? 0) !== was,
    centreBefore,
    { timeout: 10_000 },
  );
}

interface Fixtures {
  readonly workspace: E2EWorkspace;
  readonly launched: LaunchedApp;
  readonly window: Page;
}

export const test = base.extend<Fixtures>({
  workspace: async ({}, use) => {
    const workspace = await createWorkspace();
    try {
      await use(workspace);
    } finally {
      workspace.dispose();
    }
  },

  launched: async ({ workspace }, use) => {
    const launched = await launchApp(workspace);
    try {
      await use(launched);
    } finally {
      await launched.app.close();
    }
  },

  window: async ({ launched }, use) => {
    await use(launched.window);
  },
});

export { expect } from '@playwright/test';

/**
 * Bring the library forward, whatever is in front of it.
 *
 * The library is a tab now (`U15`), not a column that is always there, so opening a document
 * from it puts that document's tab over it — which is what a tab strip does. Every spec that
 * opens a second file therefore has to ask for the shelf back first, the same way the
 * researcher does: press the button on the activity bar.
 *
 * Conditional, because that button is a toggle (`U14`): pressing it while the library is
 * already in front puts it away.
 */
export async function showLibrary(window: Page): Promise<void> {
  const body = window.locator('[data-testid="library-panel"]');
  // Retried, because a window that has just launched restores its workspace over IPC: a press
  // that lands before the restore has is answered by a workspace that is about to be replaced.
  await playwrightExpect(async () => {
    if (!(await body.isVisible())) {
      await window.locator('[data-testid="activity-library"]').click();
    }
    await playwrightExpect(body).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
