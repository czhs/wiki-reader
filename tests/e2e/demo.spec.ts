/**
 * A demo library fills every surface, and one action clears it (criterion `B07`).
 *
 * The complaint this answers is about *building* the application rather than using it: every
 * page here draws something the researcher made, so an empty library is fourteen empty panels
 * and there is nothing to lay any of them out against. In practice they were being designed
 * against whatever a test happened to leave behind, which is how a panel comes to be laid out
 * for one row.
 *
 * "Every surface" is the load-bearing clause, so this spec walks them: the library list, a
 * reader with a marked sentence in it, the wiki, the notebooks shelf with its discarded shelf,
 * a notebook page with claims, the journal, and search. Then one command takes all of it away
 * and the library the workspace was seeded with is still exactly there — which is the assertion
 * that matters, because a convenience that can destroy a library is not a convenience.
 *
 * The suite runs unpackaged, which is what makes the demo available at all. That is not a
 * test-only branch: `app.isPackaged` is the same fact in front of a researcher.
 */
import { COMMAND_IDS } from '@wr/workbench';
import type { Page } from '@playwright/test';
import { test, expect } from './support/app.js';
import { openLibrary } from './support/corpus.js';

/** Run a command from the palette — the way a command with no chord is reached. */
async function runCommand(window: Page, commandId: string): Promise<void> {
  await window.locator('[data-testid="status-commands"]').click();
  const list = window.locator('[data-testid="command-list"]');
  await expect(list).toBeVisible();
  const row = window.locator(`[data-testid="command-row-${commandId}"]`);
  await expect(row, `the palette has no row for ${commandId}`).toBeVisible();
  await row.click();
  await expect(list).toBeHidden();
}

/** How many rows the notes half of the library sidebar is showing. */
async function noteRows(window: Page): Promise<number> {
  return window.locator('[data-testid="library-sidebar"] [data-testid^="library-item-"]').count();
}

test('[B07] one command fills every surface, and one clears it', async ({ window, workspace }) => {
  await openLibrary(window);
  const before = await noteRows(window);
  expect(before).toBeGreaterThan(0);

  await runCommand(window, COMMAND_IDS.fillDemoLibrary);
  // The action accounts for itself: six panels changed at once, so it says what arrived.
  const status = window.locator('[data-testid="status-message"]');
  await expect(status).toContainText('Demo content added');
  await expect(status).toContainText('papers');

  // --- the library ---------------------------------------------------------
  // More rows than before, and the demo's own papers among them by name. Read off the sidebar
  // rather than the database, because the criterion is about what is on the surfaces.
  await expect
    .poll(() => noteRows(window), { timeout: 20_000, message: 'the library never grew' })
    .toBeGreaterThan(before);
  const sidebar = window.locator('[data-testid="library-sidebar"]');
  await expect(sidebar).toContainText('Attention and memory in extended reading');
  await expect(sidebar).toContainText('Spacing effects outside the laboratory');

  // --- a reader, with something marked in it -------------------------------
  await sidebar
    .locator('[data-testid^="library-item-"]', { hasText: 'Spacing effects outside' })
    .click();
  const reader = window.locator('[data-testid="markdown-reader"]');
  await expect(reader).toBeVisible();
  await expect(reader).toContainText('Spacing wins on every interval');
  // The highlight is a real anchor over the file's own text, so it resolves and paints — an
  // anchor with invented offsets would leave the reader looking broken rather than full.
  await expect(reader.locator('.wr-highlight').first()).toBeVisible();

  // --- the notebooks shelf, including the discarded one ---------------------
  await window.locator('[data-testid="activity-questions"]').click();
  const queue = window.locator('[data-testid="questions-sidebar"]');
  await expect(queue).toBeVisible();
  await expect(queue).toContainText('Does marking a sentence do anything');
  await expect(queue).toContainText('Can a reading tool infer');

  // --- a notebook page: prose, and claims with evidence on both sides -------
  // Through the directory, which is the way in that does not depend on which shelf a notebook
  // is on — the demo puts one on each, and the point here is the page rather than the route.
  await window.locator('[data-testid="activity-notebooks"]').click();
  const directory = window.locator('[data-testid="notebook-directory"]');
  await expect(directory).toBeVisible({ timeout: 20_000 });
  await directory
    .locator('[data-testid^="directory-open-"]', { hasText: 'Does marking a sentence' })
    .click();
  const notebook = window.locator('[data-testid="notebook-panel"]');
  await expect(notebook).toBeVisible({ timeout: 20_000 });
  await expect(notebook).toContainText('Marking is cheap and writing is expensive');
  await expect(notebook).toContainText('The recall effect comes from the writing');

  // --- the journal ---------------------------------------------------------
  // Days that were actually written, marked on the calendar. A demo with a journal nobody has
  // written in would leave the calendar looking exactly like a calendar that failed to load.
  await runCommand(window, COMMAND_IDS.openJournal);
  const journal = window.locator('[data-testid="journal-page"]');
  await expect(journal).toBeVisible({ timeout: 20_000 });
  await expect(
    journal.locator('[data-testid="journal-calendar"] [data-logged="true"]').first(),
  ).toBeVisible();
  await window.keyboard.press('Escape');

  // --- the wiki ------------------------------------------------------------
  await runCommand(window, COMMAND_IDS.openWiki);
  const wiki = window.locator('[data-testid="wiki-panel"]');
  await expect(wiki).toBeVisible({ timeout: 20_000 });
  const nodes = wiki.locator('[data-testid^="wiki-node-"]');
  await expect.poll(() => nodes.count(), { timeout: 20_000 }).toBeGreaterThan(5);
  // Edges too: the wikilinks between the demo's own pages, parsed by real ingestion rather
  // than written as rows — which is what makes this a demo of a library the app can produce.
  await expect(wiki.locator('.wr-graph__edge').first()).toBeAttached();

  // --- search --------------------------------------------------------------
  await runCommand(window, COMMAND_IDS.openSearch);
  const search = window.locator('[data-testid="search-panel"]');
  await expect(search).toBeVisible();
  await search.locator('[data-testid="search-input"]').fill('spacing');
  await search.locator('[data-testid="search-submit"]').click();
  await expect
    .poll(() => search.locator('[data-testid="search-results"] .wr-row').count(), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  // --- and one action takes all of it away ---------------------------------
  await runCommand(window, COMMAND_IDS.clearDemoLibrary);
  await expect(status).toContainText('Demo content cleared');

  await openLibrary(window);
  await expect
    .poll(() => noteRows(window), { timeout: 20_000, message: 'the demo papers stayed' })
    .toBe(before);
  await expect(sidebar).not.toContainText('Attention and memory in extended reading');

  // The workspace's own seeded library is exactly as it was — the corpus page it was built
  // with is still on the shelf, and so is the paper that came over from Zotero.
  await expect(sidebar).toContainText(workspace.corpusPage.title);
  const zoteroTitle = workspace.pdfDocuments[0]?.title ?? '';
  expect(zoteroTitle.length).toBeGreaterThan(0);
  await expect(window.locator('[data-testid="library-sidebar"]')).toContainText(zoteroTitle);

  // And the notebooks the demo opened have gone with it, discarded shelf and all.
  await window.locator('[data-testid="activity-questions"]').click();
  await expect(queue).not.toContainText('Does marking a sentence do anything');
  await expect(queue).not.toContainText('Can a reading tool infer');
});
