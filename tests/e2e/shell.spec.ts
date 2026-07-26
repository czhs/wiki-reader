/**
 * The workbench shell, proved against a real Electron process.
 *
 * M01 is deliberately not "a window appeared". A window appears just as readily with
 * `nodeIntegration: true`, and the point of the criterion is that the app launches *with its
 * security invariants intact*. `scripts/verify_completion.py` greps the source for those
 * flags; this spec checks what the running renderer can actually reach, which is the thing
 * the flags are supposed to produce.
 */
import { test, expect } from './support/app.js';

test.describe('application shell', () => {
  test('[M01] launches a single window whose renderer is sandboxed and context-isolated', async ({
    launched,
    window,
  }) => {
    expect(launched.app.windows()).toHaveLength(1);
    await expect(window.locator('[data-testid="app-shell"]')).toBeVisible();
    expect(await window.title()).toBe('wiki-reader');

    // Served from the custom `app://` origin, never `file://` — a `file://` document would
    // share an origin with every other local file.
    expect(window.url()).toMatch(/^app:\/\/bundle\//);

    const reachable = await window.evaluate(() => ({
      // nodeIntegration: false
      hasRequire: typeof (globalThis as Record<string, unknown>)['require'] !== 'undefined',
      hasModule: typeof (globalThis as Record<string, unknown>)['module'] !== 'undefined',
      // sandbox: true + contextIsolation: true — the main world sees no Node realm at all.
      hasProcess: typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined',
      hasElectron: typeof (globalThis as Record<string, unknown>)['electron'] !== 'undefined',
      // The preload bridge: exactly one `invoke` and one `subscribe`, nothing more.
      bridgeKeys: Object.keys((globalThis as Record<string, unknown>)['rr'] ?? {}).sort(),
      bridgeTypes: Object.values((globalThis as Record<string, unknown>)['rr'] ?? {}).map(
        (value) => typeof value,
      ),
    }));

    expect(reachable.hasRequire).toBe(false);
    expect(reachable.hasModule).toBe(false);
    expect(reachable.hasProcess).toBe(false);
    expect(reachable.hasElectron).toBe(false);
    expect(reachable.bridgeKeys).toEqual(['invoke', 'subscribe']);
    expect(reachable.bridgeTypes).toEqual(['function', 'function']);
  });

  test('[M01] refuses to open new windows and blocks navigation away from the app origin', async ({
    launched,
    window,
  }) => {
    // Both refusals are asserted from the main process rather than through the page. A
    // `will-navigate` that main cancels still leaves the renderer with a navigation Playwright
    // is waiting on, so any page-side query here would block on a navigation that, correctly,
    // never completes.
    await window.evaluate(() => {
      window.open('https://example.com', '_blank');
      location.href = 'https://example.com';
    });
    // Give both refusals a chance to be wrong before asserting they were not.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const urls = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((browserWindow) => browserWindow.webContents.getURL()),
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^app:\/\/bundle\//);
  });

  test('[M02] renders the Dockview workspace with its activity bar, sidebars and status bar', async ({
    window,
  }) => {
    await expect(window.locator('[data-testid="activity-bar"]')).toBeVisible();
    await expect(window.locator('[data-testid="library-sidebar"]')).toBeVisible();
    await expect(window.locator('[data-testid="dockview-container"]')).toBeVisible();
    await expect(window.locator('[data-testid="status-bar"]')).toBeVisible();

    // Dockview really mounted, rather than the container merely existing: its own class is
    // applied by the component, not by our markup.
    await expect(window.locator('[data-testid="dockview-container"] .dv-dockview')).toBeVisible();

    // Nothing is open yet, so the centre shows the watermark and the status bar agrees.
    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeVisible();
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('0 panels');
  });

  test('[M02] the activity bar toggles the sidebars it controls', async ({ window }) => {
    const library = window.locator('[data-testid="library-sidebar"]');
    await expect(library).toBeVisible();

    await window.locator('[data-testid="activity-library"]').click();
    await expect(library).toBeHidden();

    await window.locator('[data-testid="activity-library"]').click();
    await expect(library).toBeVisible();

    const annotations = window.locator('[data-testid="annotations-sidebar"]');
    await expect(annotations).toBeHidden();
    await window.locator('[data-testid="activity-annotations"]').click();
    await expect(annotations).toBeVisible();
  });

  test('[M05] lists every imported Zotero item in the library sidebar', async ({
    window,
    workspace,
  }) => {
    // The workspace seeded this database by running the real ZoteroImporter over the recorded
    // local-API fixtures, so these rows are the import's output, not fabricated fixtures.
    expect(workspace.documents.length).toBeGreaterThan(0);

    const sidebar = window.locator('[data-testid="library-sidebar"]');
    await expect(sidebar).toBeVisible();

    const libraryList = sidebar.locator('[data-testid="library-zotero-list"]');
    for (const document of workspace.documents) {
      const row = libraryList.locator(`[data-testid="library-item-${document.id}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(document.title);
    }

    // The library is the Zotero import and nothing else. It used to also hold the markdown
    // corpus the app scans at startup, listed as peers of the papers, which is what made the
    // sidebar unreadable. A row beyond this count means a document the library invented or a
    // second source leaking back in.
    await expect(libraryList.locator('[data-testid^="library-item-"]')).toHaveCount(
      workspace.documents.length,
    );

    // The corpus is still listed, under its own heading, and still openable from there.
    const notes = sidebar.locator('[data-testid="library-notes-list"]');
    await expect(sidebar.locator('[data-testid="notes-section-heading"]')).toBeVisible();
    await expect(notes.locator('[data-testid^="library-item-"]')).toHaveCount(
      workspace.corpusPageCount,
    );
    await expect(notes).toContainText(workspace.corpusPage.title);
  });
});
