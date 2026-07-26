/**
 * Picking which Zotero collections an import covers, and finding the picks still there
 * afterwards (criterion C01).
 *
 * Scoping the import has been implemented and tested since `W12`, but only as an argument
 * nobody could supply: the button in the sidebar called `zotero:import` with no scope, so a
 * Zotero holding fifteen years of everything imported fifteen years of everything and there
 * was no way to say otherwise. What was missing was a way to *pick* and a place to keep the
 * picks — and neither is provable by anything that drives the channel directly.
 *
 * So this spec picks in the interface, closes the app, launches a second one over the same
 * library, and looks. The integration suite covers the other half: that an import naming no
 * scope of its own is actually narrowed by what was picked.
 */
import { launchApp, test, expect } from './support/app.js';

/** A collection in the recorded fixtures, and one that is filed under another. */
const PICKED = 'm26-sprint-wiki';
const NESTED_LABEL = 'Past Projects / CA-Evolution';

test('[C01] Zotero import is scoped by picking collections, and the picks stick', async ({
  workspace,
}) => {
  const first = await launchApp(workspace);
  try {
    const sidebar = first.window.locator('[data-testid="library-sidebar"]');
    const summary = sidebar.locator('[data-testid="zotero-scope-summary"]');

    // Unscoped is the default, and it says so: an empty picker must not read as "nothing
    // will be imported".
    await expect(summary).toHaveText('Importing the whole library');

    await sidebar.locator('[data-testid="zotero-scope-toggle"]').click();
    const picker = sidebar.locator('[data-testid="zotero-scope-picker"]');
    await expect(picker).toBeVisible();

    // Every collection the library knows about, shown as a tree rather than a flat list of
    // names — "Drafts" under three projects is three different collections.
    await expect(picker.locator('[data-testid="zotero-scope-option"]')).toHaveCount(8);
    await expect(picker).toContainText(NESTED_LABEL);

    await picker.locator(`[data-collection="${PICKED}"] input[type="checkbox"]`).check();
    await expect(summary).toHaveText('Importing 1 collection');
  } finally {
    await first.app.close();
  }

  // A second process over the same library. Anything held in renderer state, in a React ref
  // or on the importer object is gone by here.
  const second = await launchApp(workspace);
  try {
    const sidebar = second.window.locator('[data-testid="library-sidebar"]');

    // Visible before the picker is opened: the scope is a fact about the library, not a
    // detail hidden inside a control someone has to think to expand.
    await expect(sidebar.locator('[data-testid="zotero-scope-summary"]')).toHaveText(
      'Importing 1 collection',
    );

    await sidebar.locator('[data-testid="zotero-scope-toggle"]').click();
    const picker = sidebar.locator('[data-testid="zotero-scope-picker"]');
    await expect(picker.locator(`[data-collection="${PICKED}"] input[type="checkbox"]`)).toBeChecked();

    // And the rest are not: "remembered" has to mean these collections, not all of them.
    await expect(picker.locator('input[type="checkbox"]:checked')).toHaveCount(1);
  } finally {
    await second.app.close();
  }
});

test('[C01] unticking every collection goes back to the whole library', async ({ workspace }) => {
  const first = await launchApp(workspace);
  try {
    const sidebar = first.window.locator('[data-testid="library-sidebar"]');
    await sidebar.locator('[data-testid="zotero-scope-toggle"]').click();
    const box = sidebar.locator(`[data-collection="${PICKED}"] input[type="checkbox"]`);
    await box.check();
    await expect(sidebar.locator('[data-testid="zotero-scope-summary"]')).toHaveText(
      'Importing 1 collection',
    );
    await box.uncheck();
    // An empty pick list is "everything", not "nothing" — the one place where clearing a
    // filter could plausibly have meant an import that covers no documents at all.
    await expect(sidebar.locator('[data-testid="zotero-scope-summary"]')).toHaveText(
      'Importing the whole library',
    );
  } finally {
    await first.app.close();
  }

  const second = await launchApp(workspace);
  try {
    await expect(
      second.window.locator('[data-testid="library-sidebar"] [data-testid="zotero-scope-summary"]'),
    ).toHaveText('Importing the whole library');
  } finally {
    await second.app.close();
  }
});
