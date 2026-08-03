/**
 * The shell obeying the hand (criterion U09, re-anchored by `U14` and `U15`).
 *
 * `U09` was written against furniture the app no longer has. Two `<aside>`s and a `<section>`
 * sat outside Dockview's grid, sized in CSS, and the criterion asked for the three things
 * nobody could do to them: drag an edge, fold one to a rail, close the annotations column from
 * its own corner. `U15` retired all three surfaces into tabs and `U14` retired the fold, so two
 * of those promises are kept now by Dockview itself — every tab drags, splits and resizes —
 * and there is exactly one way to put a surface away.
 *
 * What survives is the half that was never about the sidebars: a **section of a long page**
 * folds, because the notebook is one long document (`P10`) and writing in the middle of it
 * means scrolling past the front matter and the claims every time. Beside it, the promise the
 * researcher made the report about: the annotations list can be got rid of from where they are
 * looking, and the activity bar agrees it is shut.
 */
import { expect, test } from './support/app.js';
import type { Page } from '@playwright/test';

async function openQueue(window: Page): Promise<void> {
  const queue = window.locator('[data-testid="queue-panel"]');
  await expect(async () => {
    if (!(await queue.isVisible())) {
      await window.locator('[data-testid="activity-questions"]').click();
    }
    await expect(queue).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('[U09] a page folds its own sections, and the annotations list is put away from the bar', async ({
  window,
  workspace,
}) => {
  const [paper] = workspace.pdfDocuments;
  expect(paper).toBeDefined();
  if (paper === undefined) return;

  // Something being read, because the room a fold gives back is only worth having if the work
  // is what gets it.
  await window
    .locator(`[data-testid="library-panel"] [data-testid="library-item-${paper.id}"]`)
    .click();
  const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${paper.id}"]`);
  await expect(reader).toBeVisible();

  // --- the annotations list closes, and the bar agrees ----------------------
  await window.locator('[data-testid="activity-annotations"]').click();
  const annotations = window.locator('[data-testid="annotation-list-panel"]');
  await expect(annotations).toBeVisible();
  await expect(window.locator('[data-testid="activity-annotations"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Put away by the same button that opened it — the one gesture there is now (`U14`).
  await window.locator('[data-testid="activity-annotations"]').click();
  await expect(annotations).toHaveCount(0);
  await expect(window.locator('[data-testid="activity-annotations"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // --- and a section of the page folds -------------------------------------
  await openQueue(window);
  await window.locator('[data-testid="queue-new-title"]').fill('Does folding help long pages?');
  await window.locator('[data-testid="queue-add"]').click();
  const row = window.locator('[data-testid="queue-list"] > li').last();
  const questionId = await row.getAttribute('data-question-id');
  expect(questionId).not.toBeNull();
  if (questionId === null) return;
  await window.locator(`[data-testid="queue-open-${questionId}"]`).click();

  const page = window.locator('[data-testid="notebook-panel"]');
  await expect(page).toBeVisible();
  const frontMatter = page.locator('[data-testid="notebook-section-front-matter"]');
  await expect(page.locator('[data-testid="notebook-description"]')).toBeVisible();

  await page.locator('[data-testid="notebook-fold-front-matter"]').click();
  await expect(frontMatter).toHaveAttribute('data-folded', 'true');
  await expect(page.locator('[data-testid="notebook-description"]')).toHaveCount(0);
  // The heading stays, so the section is somewhere rather than gone.
  await expect(page.locator('[data-testid="notebook-fold-front-matter"]')).toBeVisible();

  // And going to a folded section unfolds it, so nothing can be folded past finding again.
  await page.locator('[data-testid="notebook-jump-front-matter"]').click();
  await expect(frontMatter).toHaveAttribute('data-folded', 'false');
  await expect(page.locator('[data-testid="notebook-description"]')).toBeVisible();
});
