/**
 * The door to a question's page (criterion N08), and writing on it (`N01`).
 *
 * `N08` exists because the first question asked about notebooks was *how are they accessed?*
 * A page reachable only by knowing a channel name is a page nobody has, so the assertion is
 * the whole path a hand takes: open the queue, click the question, land on its page — and the
 * page says which question it is, because a notebook that could be any of them is worse than
 * no title at all.
 *
 * The prose is typed into the panel rather than sent down the channel. A spec that called
 * `question:writeNotebook` would pass with no editor on the screen, which is exactly the
 * failure `N08` is about.
 *
 * The page is written in blocks since `S01`, so what a hand does here is add a block, type
 * into it and click away. What these two assert has not moved: the prose is written *in the
 * app*, and it is still there when the page is opened again.
 */
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import type { Page } from '@playwright/test';

const QUESTION = 'Do induction heads appear in VLAs?';
const OTHER = 'Does SDFT preserve induction behaviour?';

async function openQueue(window: Page) {
  const sidebar = window.locator('[data-testid="queue-panel"]');
  await expect(async () => {
    if (!(await sidebar.isVisible())) {
      await window.locator('[data-testid="activity-questions"]').click();
    }
    await expect(sidebar).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return sidebar;
}

async function addQuestion(window: Page, title: string): Promise<void> {
  await window.locator('[data-testid="queue-new-title"]').fill(title);
  await window.locator('[data-testid="queue-add"]').click();
  await expect(window.locator('[data-testid="queue-list"]')).toContainText(title);
}

/** The question ids on screen, in order. */
async function queuedIds(window: Page): Promise<string[]> {
  return window
    .locator('[data-testid="queue-list"] > li')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-question-id') ?? ''));
}


/** Write a block on the page the way a hand does: add it, type into it, click away. */
async function writeBlock(window: Page, source: string): Promise<void> {
  await window.locator('[data-testid="notebook-add-text"]').click();
  const editor = window.locator('[data-testid^="notebook-block-editor-"]');
  await editor.fill(source);
  await editor.blur();
}

/** The page as markdown, read back off the blocks the way a reader sees them. */
function pageBlocks(window: Page) {
  return window.locator('[data-testid^="notebook-block-"]:not([data-testid*="editor"])');
}

test('[N08] a question’s notebook is reached from the queue, and the page names its question', async ({
  window,
}) => {
  await openQueue(window);
  await addQuestion(window, QUESTION);
  await addQuestion(window, OTHER);
  const [first, second] = await queuedIds(window);
  if (first === undefined || second === undefined) throw new Error('queue: expected two rows');

  // The door: the question in the queue is what you press.
  await window.locator(`[data-testid="queue-open-${first}"]`).click();

  const page = window.locator('[data-testid="notebook-panel"]');
  await expect(page).toBeVisible();
  // Naming the question is the point: two questions were added, and the page has to say
  // which one this is rather than being a page that could be either.
  await expect(page.locator('[data-testid="notebook-question-title"]')).toHaveText(QUESTION);
  await expect(page).not.toContainText(OTHER);
  // And the tab it opened in says so too, so a second page is distinguishable from the first.
  await expect(window.locator('.dv-tab', { hasText: QUESTION })).toHaveCount(1);

  // Back to the queue first: it is a tab now (`U15`), and the page just opened is in front of
  // it — the same gesture the researcher makes, on the same button.
  await openQueue(window);
  await window.locator(`[data-testid="queue-open-${second}"]`).click();
  await expect(page.locator('[data-testid="notebook-question-title"]')).toHaveText(OTHER);
});

test('[N01] the page is written in the app, and the prose is still there when it is reopened', async ({
  window,
}) => {
  await openQueue(window);
  await addQuestion(window, QUESTION);
  const [id] = await queuedIds(window);
  if (id === undefined) throw new Error('queue: expected one row');

  await window.locator(`[data-testid="queue-open-${id}"]`).click();
  // A blank page opens on the conventional sections rather than on nothing — as blocks, one
  // per heading, which is what makes them editable one at a time.
  await expect(window.locator('[data-testid="notebook-panel"]')).toContainText('Experiment log');

  await writeBlock(window, '= The question\n\n' + QUESTION);
  await writeBlock(window, 'Ran the sweep at width 4096.');
  await expect(window.locator('[data-testid="notebook-saved"]')).toBeVisible();

  // Closing the tab throws away every bit of renderer state the page held. Reopening it from
  // the queue asks the main process again, so what comes back is what was actually stored.
  await window.locator('[data-testid="notebook-panel"]').press('Meta+w');
  await expect(window.locator('[data-testid="notebook-panel"]')).toHaveCount(0);

  await window.locator(`[data-testid="queue-open-${id}"]`).click();
  const page = window.locator('[data-testid="notebook-panel"]');
  await expect(page).toContainText(QUESTION);
  await expect(page).toContainText('Ran the sweep at width 4096.');
  // Written as source and compiled, so the heading is a heading rather than an equals sign on
  // screen. Typst's HTML export keeps `<h1>` for the document, so a `=` heading is an `<h2>`.
  await expect(page.locator('[data-testid="notebook-blocks"] h2').last()).toHaveText(
    'The question',
  );
});

test('[N08] the page survives a restart and is still reached the same way', async ({
  workspace,
}) => {
  // Minted in the first process; the second one has to reach the same page by the same door.
  let questionId: string;

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openQueue(window);
    await addQuestion(window, QUESTION);
    const [id] = await queuedIds(window);
    if (id === undefined) throw new Error('queue: expected one row');
    questionId = id;

    await window.locator(`[data-testid="queue-open-${id}"]`).click();
    await writeBlock(window, 'The sweep ran overnight.');
    await expect(window.locator('[data-testid="notebook-saved"]')).toBeVisible();
  } finally {
    await first.app.close();
  }

  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openQueue(window);
    await window.locator(`[data-testid="queue-open-${questionId}"]`).click();
    await expect(window.locator('[data-testid="notebook-question-title"]')).toHaveText(QUESTION);
    await expect(pageBlocks(window).last()).toContainText('The sweep ran overnight.');
  } finally {
    await second.app.close();
  }
});
