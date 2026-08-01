/**
 * The directory of notebooks (criterion P01), and the word that retired with it.
 *
 * The notebook is the unit of work. Until milestone 5 the only place they were all listed was
 * a 260px sidebar whose job is *order* — what to do next — which is not the same thing as a
 * shelf, and which truncated every title to fit. `P01` is the shelf: a page, listing every
 * notebook, and opening one lands on its page.
 *
 * The second test is the rule the criteria table has no row for: milestone 3 made the unit a
 * "question" and the researcher does not know what one is. It is asserted by *reading the
 * screen* — every surface a researcher passes through, plus the command list, which is the
 * app's own index of everything it can do. A word retires when nothing says it, and the only
 * honest way to check that is to look.
 */
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { seedNotebook } from './support/workspace.js';
import type { Page } from '@playwright/test';

const FIRST = 'Do induction heads appear in VLAs?';
const SECOND = 'Does the J-space latent decode to language?';

async function openDirectory(window: Page): Promise<void> {
  const directory = window.locator('[data-testid="notebook-directory"]');
  await expect(async () => {
    if (!(await directory.isVisible())) {
      await window.locator('[data-testid="activity-notebooks"]').click();
    }
    await expect(directory).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('[P01] the directory lists every notebook, and opening one lands on its page', async ({
  workspace,
}) => {
  const first = seedNotebook(workspace, FIRST, [
    { date: '2026-07-20', markdown: 'Ran the sweep.' },
    { date: '2026-07-21', markdown: 'Read the second paper.' },
  ]);
  const second = seedNotebook(workspace, SECOND);

  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await openDirectory(window);

    // Every notebook, not a page of them and not the ones in front: both are listed, in the
    // hand-arranged order the queue keeps, and each says which it is.
    const rows = window.locator('[data-testid="directory-list"] > li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-notebook-id', first);
    await expect(rows.nth(1)).toHaveAttribute('data-notebook-id', second);
    await expect(window.locator(`[data-testid="directory-item-${first}"]`)).toContainText(FIRST);
    await expect(window.locator(`[data-testid="directory-item-${second}"]`)).toContainText(SECOND);

    // It is the directory of journals too (`P02` made a journal belong to its notebook), so a
    // row says what is in the log rather than making the researcher open it to find out.
    await expect(window.locator(`[data-testid="directory-journal-${first}"]`)).toContainText(
      '2 days',
    );
    await expect(window.locator(`[data-testid="directory-journal-${second}"]`)).toContainText(
      'nothing yet',
    );

    // Opening one lands on *its* page: the notebook panel, on that notebook, titled with it.
    await window.locator(`[data-testid="directory-open-${second}"]`).click();
    const panel = window.locator('[data-testid="notebook-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-question-id', second);
    await expect(window.locator('[data-testid="notebook-question-title"]')).toHaveText(SECOND);

    // And the other one lands on a different page rather than re-using the first.
    await openDirectory(window);
    await window.locator(`[data-testid="directory-open-${first}"]`).click();
    await expect(window.locator('[data-testid="notebook-panel"]')).toHaveAttribute(
      'data-question-id',
      first,
    );
    await expect(window.locator('.dv-tab', { hasText: FIRST })).toHaveCount(1);
    await expect(window.locator('.dv-tab', { hasText: SECOND })).toHaveCount(1);

    // The journal door on the same row opens that notebook's log, which is the other half of
    // what makes the directory a way in rather than a list.
    await openDirectory(window);
    await window.locator(`[data-testid="directory-journal-${first}"]`).click();
    await expect(window.locator('[data-testid="journal-page"]')).toHaveAttribute(
      'data-notebook-id',
      first,
    );
    // A sheet over the workspace since `P09`, so it is dismissed before the shelf is used again.
    await window.locator('[data-testid="journal-popup-close"]').click();

    // A notebook made here is on the shelf, and the shelf is re-read rather than remembered.
    await openDirectory(window);
    await window.locator('[data-testid="directory-new-title"]').fill('A third line of work');
    await window.locator('[data-testid="directory-add"]').click();
    await expect(window.locator('[data-testid="notebook-panel"]')).toBeVisible();
    await openDirectory(window);
    await expect(window.locator('[data-testid="directory-list"] > li')).toHaveCount(3);
    await expect(window.locator('[data-testid="directory-list"]')).toContainText(
      'A third line of work',
    );
  } finally {
    await launched.app.close();
  }

  // The directory is the shelf, so it shows what is on it in the next process too.
  const again: LaunchedApp = await launchApp(workspace);
  try {
    const window = again.window;
    await openDirectory(window);
    await expect(window.locator('[data-testid="directory-list"] > li')).toHaveCount(3);
    await expect(window.locator(`[data-testid="directory-journal-${first}"]`)).toContainText(
      '2 days',
    );
  } finally {
    await again.app.close();
  }
});

/**
 * The shelf a researcher comes back to is the shelf as it is now.
 *
 * Dockview hides a tab by detaching its content element, and React does not unmount a tree
 * whose host node was detached — so the directory's one load ran once, at mount, and never
 * again for the life of the session. Every number on the page is derived from the library, and
 * the thing most likely to change one happens on another page: writing today's entry in a
 * notebook's journal, which the directory is also the directory of.
 */
test('[P01] re-reads the shelf when you come back to it, rather than remembering it', async ({
  window,
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, FIRST);
  await openDirectory(window);

  const row = window.locator(`[data-testid="directory-journal-${notebookId}"]`);
  await expect(row).toContainText('nothing yet');
  await expect(row).toHaveAttribute('data-entries', '0');

  // Through the row's own door, which is how a journal is opened (`P02`).
  await row.click();
  const journal = window.locator(`[data-testid="journal-page"][data-notebook-id="${notebookId}"]`);
  await expect(journal).toBeVisible();

  // Write the day the way the notebook is used: a block, some words, click away to commit.
  await window.locator('[data-testid="journal-add-text"]').click();
  const editor = window.locator('[data-testid^="journal-block-editor-"]');
  await editor.fill('Ran the sweep, and the second head is not an induction head.');
  await editor.blur();
  await expect(window.locator('[data-testid="journal-block-0"]')).toContainText('Ran the sweep');

  // Away, then back to the shelf. The journal is a sheet over the workspace since `P09`, so
  // "away" means expanding it into a page of the workspace — which is what a day worth writing
  // in becomes anyway. The row is a fact about the log, and the log has changed.
  await window.locator('[data-testid="journal-expand"]').click();
  await expect(
    window.locator('[data-testid="dockview-container"] [data-testid="journal-page"]'),
  ).toBeVisible();
  await openDirectory(window);
  await expect(row).toHaveAttribute('data-entries', '1');
  await expect(row).toContainText('1 day');
});

test('[P01] no surface calls a notebook a question', async ({ window, workspace }) => {
  const notebookId = seedNotebook(workspace, FIRST, [
    { date: '2026-07-20', markdown: 'Ran the sweep.' },
  ]);

  /** Everything a researcher can read on screen right now, lowercased. */
  const readable = async (): Promise<string> =>
    (await window.locator('[data-testid="app-shell"]').innerText()).toLowerCase();

  // The shell as it opens: the activity bar, the library, the status bar.
  expect(await readable()).not.toContain('question');

  // The directory, the notebook page, the journal — the three surfaces `P01`–`P05` built.
  await openDirectory(window);
  expect(await readable()).not.toContain('question');

  await window.locator(`[data-testid="directory-open-${notebookId}"]`).click();
  await expect(window.locator('[data-testid="notebook-panel"]')).toBeVisible();
  expect(await readable()).not.toContain('question');

  await openDirectory(window);
  await window.locator(`[data-testid="directory-journal-${notebookId}"]`).click();
  await expect(window.locator('[data-testid="journal-page"]')).toBeVisible();
  expect(await readable()).not.toContain('question');
  // The sheet is dismissed before the next surface is reached (`P09`).
  await window.locator('[data-testid="journal-popup-close"]').click();

  // The list in front — what used to be called the queue of questions.
  await window.locator('[data-testid="activity-questions"]').click();
  await expect(window.locator('[data-testid="questions-sidebar"]')).toBeVisible();
  expect(await readable()).not.toContain('question');

  // The help page, which is every command the app has and every key that runs one, rendered
  // from the registries — the fullest inventory of its vocabulary there is (`D02`).
  await window.locator('[data-testid="status-help"]').click();
  const help = window.locator('[data-testid="help-panel"]');
  await expect(help).toBeVisible();
  expect((await help.innerText()).toLowerCase()).not.toContain('question');

  // And the command list, which is the app's own index of everything it can do: if the word
  // survived anywhere as vocabulary, it would survive as the name of an action.
  await window.locator('[data-testid="status-commands"]').click();
  const commands = window.locator('[data-testid="command-list"]');
  await expect(commands).toBeVisible();
  expect((await commands.innerText()).toLowerCase()).not.toContain('question');
  // …and the word it retired in favour of is the one the list actually uses.
  expect((await commands.innerText()).toLowerCase()).toContain('notebook');
});
