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
 */
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import type { Page } from '@playwright/test';

const QUESTION = 'Do induction heads appear in VLAs?';
const OTHER = 'Does SDFT preserve induction behaviour?';

async function openQueue(window: Page) {
  const sidebar = window.locator('[data-testid="questions-sidebar"]');
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
  const body = window.locator('[data-testid="notebook-body"]');
  // A blank page opens on the conventional sections rather than on nothing.
  await expect(body).toHaveValue(/## Experiment log/u);

  const written = `## The question\n\n${QUESTION}\n\n## Experiment log\n\nRan the sweep at width 4096.\n`;
  await body.fill(written);
  await body.blur();
  await expect(window.locator('[data-testid="notebook-saved"]')).toBeVisible();

  // Closing the tab throws away every bit of renderer state the page held. Reopening it from
  // the queue asks the main process again, so what comes back is what was actually stored.
  await window.locator('[data-testid="notebook-panel"]').press('Meta+w');
  await expect(window.locator('[data-testid="notebook-panel"]')).toHaveCount(0);

  await window.locator(`[data-testid="queue-open-${id}"]`).click();
  await expect(window.locator('[data-testid="notebook-body"]')).toHaveValue(written);
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
    const body = window.locator('[data-testid="notebook-body"]');
    await body.fill('## Experiment log\n\nThe sweep ran overnight.\n');
    await body.blur();
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
    await expect(window.locator('[data-testid="notebook-body"]')).toHaveValue(
      '## Experiment log\n\nThe sweep ran overnight.\n',
    );
  } finally {
    await second.app.close();
  }
});
