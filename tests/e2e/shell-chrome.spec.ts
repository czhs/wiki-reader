/**
 * The shell obeying the hand (criterion U09).
 *
 * Dockview owns the centre and everything in it has always been draggable, splittable and
 * resizable. The app's own furniture was not: the two sidebars and the strip below are an
 * `<aside>`, an `<aside>` and a `<section>` outside that grid, sized in CSS, so "make the
 * annotations column narrower" was the one arrangement in the workspace nobody could make. The
 * annotations column was worse than that — it had no close control at all, only the activity
 * bar somewhere else on screen, which is not the same gesture and is not where the researcher
 * is looking when they want it gone.
 *
 * Three separate promises, asserted separately:
 *
 * - a **drag** moves an edge and the panel is actually that wide afterwards, held inside bounds
 *   so the drag cannot leave a panel that cannot be grabbed again;
 * - **folding** gives the room back and keeps the panel — measured on the reader, because the
 *   room is only worth having if the work gets it;
 * - the annotations panel **closes from its own corner**, and the activity bar agrees it is
 *   shut, because a lit button over a panel that is not there is worse than either.
 *
 * And the page's own sections fold the same way, which is the other half of the criterion: the
 * notebook is one long document now (`P10`), so writing in the middle of it means scrolling
 * past the front matter and the claims every time.
 */
import { expect, test } from './support/app.js';
import type { Locator, Page } from '@playwright/test';

/** How wide something is drawn, right now. */
async function widthOf(target: Locator): Promise<number> {
  const box = await target.boundingBox();
  expect(box, 'the element is not on screen').not.toBeNull();
  return box?.width ?? 0;
}

/** Drag a resizer by hand, the way a pointer does: press, move, release. */
async function dragEdge(window: Page, testId: string, by: number): Promise<void> {
  const handle = window.locator(`[data-testid="${testId}"]`);
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  // Two moves, because a splitter that only reads the final position is a splitter that does
  // not follow the pointer — and following it is the whole gesture.
  await window.mouse.move(x + by / 2, y);
  await window.mouse.move(x + by, y);
  await window.mouse.up();
}

async function openQueue(window: Page): Promise<void> {
  const sidebar = window.locator('[data-testid="questions-sidebar"]');
  await expect(async () => {
    if (!(await sidebar.isVisible())) {
      await window.locator('[data-testid="activity-questions"]').click();
    }
    await expect(sidebar).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('[U09] panels drag-resize and fold, and the annotations panel closes from its own corner', async ({
  window,
  workspace,
}) => {
  const [paper] = workspace.pdfDocuments;
  expect(paper).toBeDefined();
  if (paper === undefined) return;

  // Something being read, because every promise here is about what the reading gets back.
  await window
    .locator(`[data-testid="library-sidebar"] [data-testid="library-item-${paper.id}"]`)
    .click();
  const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${paper.id}"]`);
  await expect(reader).toBeVisible();

  const sidebar = window.locator('[data-testid="library-sidebar"]');

  // --- an edge is dragged -------------------------------------------------
  const before = await widthOf(sidebar);
  await dragEdge(window, 'resize-left-sidebar', 120);
  await expect
    .poll(async () => Math.round(await widthOf(sidebar)), {
      message: 'the sidebar did not follow the edge that was dragged',
    })
    .toBeGreaterThan(before + 90);

  // Dragged past what a sidebar may be, it stops rather than writing a width nobody can grab
  // again. The bound is on the stored number, so this is the state a restart would come back to.
  await dragEdge(window, 'resize-left-sidebar', -4_000);
  await expect
    .poll(async () => Math.round(await widthOf(sidebar)))
    .toBe(180);

  // --- folding gives the room back and keeps the panel ---------------------
  const readerBeforeFold = await widthOf(reader);
  await window.locator('[data-testid="minimize-left-sidebar"]').click();
  await expect(sidebar).toHaveAttribute('data-minimized', 'true');
  // Still open — this is not close — and the list it holds is out of the way, not gone.
  await expect(sidebar).toBeVisible();
  await expect(window.locator('[data-testid="library-list"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="activity-library"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(async () => Math.round(await widthOf(reader)), {
      message: 'folding the sidebar gave nothing back to the reading',
    })
    .toBeGreaterThan(Math.round(readerBeforeFold) + 100);

  await window.locator('[data-testid="minimize-left-sidebar"]').click();
  await expect(sidebar).toHaveAttribute('data-minimized', 'false');
  await expect(window.locator('[data-testid="library-list"]')).toBeVisible();

  // --- the annotations panel closes ---------------------------------------
  await window.locator('[data-testid="activity-annotations"]').click();
  const annotations = window.locator('[data-testid="annotations-sidebar"]');
  await expect(annotations).toBeVisible();

  // It resizes too, which was the arrangement that could not be made at all.
  const annotationsBefore = await widthOf(annotations);
  await dragEdge(window, 'resize-annotations-sidebar', -100);
  await expect
    .poll(async () => Math.round(await widthOf(annotations)))
    .toBeGreaterThan(annotationsBefore + 70);

  // And it folds without closing: the activity button stays lit, because the panel is still open.
  await window.locator('[data-testid="minimize-annotations-sidebar"]').click();
  await expect(annotations).toHaveAttribute('data-minimized', 'true');
  await expect(window.locator('[data-testid="activity-annotations"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await window.locator('[data-testid="minimize-annotations-sidebar"]').click();

  // Closing is the other act, from the panel's own corner, and the bar agrees it is shut.
  await window.locator('[data-testid="close-annotations-sidebar"]').click();
  await expect(annotations).toHaveCount(0);
  await expect(window.locator('[data-testid="activity-annotations"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // --- the panel below --------------------------------------------------------
  await window.keyboard.press('Shift+F12');
  const bottom = window.locator('[data-testid="bottom-panel"]');
  await expect(bottom).toBeVisible();
  const bottomBefore = (await bottom.boundingBox())?.height ?? 0;
  await window.locator('[data-testid="minimize-bottom-panel"]').click();
  await expect(bottom).toHaveAttribute('data-minimized', 'true');
  await expect(window.locator('[data-testid="references-list"]')).toHaveCount(0);
  await expect
    .poll(async () => Math.round((await bottom.boundingBox())?.height ?? 0))
    .toBeLessThan(Math.round(bottomBefore));
  await window.locator('[data-testid="minimize-bottom-panel"]').click();
  await expect(bottom).toHaveAttribute('data-minimized', 'false');

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
