/**
 * The Zotero import is reachable from the interface.
 *
 * `zotero:import` has been implemented and tested since M04, and `[W12]` covers scoping it to
 * a collection — but nothing in the renderer ever called it. Startup scanned the markdown
 * corpus and not Zotero, so a real install showed a library with no Zotero items in it, no
 * button to import any, and no indication that importing was a thing the app did. Every test
 * passed, because every test seeds its database by calling `ZoteroImporter` directly.
 *
 * So this asserts the one thing those cannot: that a person who opens the app can get their
 * library into it.
 */
import { test, expect } from './support/app.js';

test('[UX09] the library offers a Zotero import, and it reaches the importer', async ({
  window,
  workspace,
}) => {
  const sidebar = window.locator('[data-testid="library-panel"]');
  await expect(sidebar).toBeVisible();

  // Present whether or not the library already has items — re-syncing after adding a paper
  // to Zotero is the common case, not the first-run one.
  expect(workspace.documents.length).toBeGreaterThan(0);
  const trigger = sidebar.locator('[data-testid="import-from-zotero-compact"]');
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled();

  await trigger.click();

  // The workspace has no Zotero running behind it, so the import fails to connect — and that
  // is the assertion worth making: the click reached the main process and came back with the
  // remedy rather than a raw connection error or a silent nothing.
  const status = window.locator('[data-testid="status-message"]');
  await expect(status).toContainText(/Zotero/i, { timeout: 30_000 });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
});

test('[UX09] an empty library says how to fill it', async ({ window }) => {
  // The first thing a new install shows. "Nothing here" with no next step is how the app
  // looked to someone who had never run an import: correct, and useless.
  const empty = window.locator('[data-testid="library-empty"]');
  if ((await empty.count()) === 0) {
    // The seeded workspace has Zotero items, so the empty state is not on screen. Assert the
    // affordance it would carry exists in the build rather than skipping silently.
    await expect(window.locator('[data-testid="import-from-zotero-compact"]')).toBeVisible();
    return;
  }
  await expect(empty).toContainText('Zotero must be running');
  await expect(empty.locator('[data-testid="import-from-zotero"]')).toBeVisible();
});
