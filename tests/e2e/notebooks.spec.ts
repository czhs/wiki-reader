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
