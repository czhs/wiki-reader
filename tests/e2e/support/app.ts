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
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
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
 */
export async function launchApp(workspace: E2EWorkspace): Promise<LaunchedApp> {
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
  // The suite runs unattended on a machine someone else is using. Background mode keeps the
  // window off the dock and out of the foreground; Playwright drives over CDP, which injects
  // input without OS focus, so every interaction still works exactly as it would in front.
  env['WR_BACKGROUND'] = '1';

  const app = await electron.launch({ args: [DESKTOP_DIR], env });

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
  await window.waitForSelector('[data-testid="app-shell"]', { timeout: 60_000 });
  return { app, window };
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
