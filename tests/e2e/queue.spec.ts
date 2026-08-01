/**
 * The queue is arranged by hand, and the arrangement is what survives (criterion Q02).
 *
 * The arrangement is the whole criterion, so the test is careful about what would pass
 * without it. Three questions are typed in one order and dragged into another that no field
 * sorts into — not creation order, not reverse creation order, not alphabetical — so a queue
 * that quietly re-sorted by anything at all would come back wrong. Then the app is closed and
 * a second process is launched over the same library, because an order held in React state,
 * in a ref, or in the renderer's memory is gone by then.
 *
 * The drag is a real pointer drag through CDP rather than a call to the channel: what is
 * being tested is that a person can put the queue in an order, and a spec that invoked
 * `question:reorder` directly would pass with no grip on the screen at all.
 */
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import type { Page } from '@playwright/test';

const FIRST = 'Do induction heads appear in VLAs?';
const SECOND = 'Does SDFT preserve induction behaviour?';
const THIRD = 'Does the J-space latent decode to language?';

/**
 * Open the questions sidebar and hand back its locator.
 *
 * Toggled rather than clicked blind, because a workspace restored from the last session may
 * already have it open — the sidebar you left open is open next time — and a second click
 * would close it again.
 */
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

/** The titles in the order they are on screen, top to bottom. */
function queuedTitles(window: Page) {
  return window.locator('[data-testid="queue-list"] .wr-queue__title');
}

/**
 * Drag one row's grip onto another row, the way a hand does it.
 *
 * The move is stepped rather than a single jump: the list reorders as the pointer crosses
 * each row's midpoint, so one instantaneous move would skip every midpoint between the two.
 */
async function dragOnto(window: Page, grip: string, target: string): Promise<void> {
  const handle = window.locator(`[data-testid="queue-grip-${grip}"]`);
  const destination = window.locator(`[data-testid="queue-item-${target}"]`);
  const from = await handle.boundingBox();
  const to = await destination.boundingBox();
  if (from === null || to === null) throw new Error('queue drag: a row has no box');

  await window.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await window.mouse.down();
  const startY = from.y + from.height / 2;
  // Past the target's midpoint, not onto its edge: a row swaps when the pointer crosses the
  // middle of it, so aiming at the near quarter of a row below would stop just short.
  const endY = to.y > from.y ? to.y + (to.height * 3) / 4 : to.y + to.height / 4;
  for (let step = 1; step <= 12; step++) {
    await window.mouse.move(from.x + from.width / 2, startY + ((endY - startY) * step) / 12);
  }
  await window.mouse.up();
}

/** The question ids on screen, in order. */
async function queuedIds(window: Page): Promise<string[]> {
  return window.locator('[data-testid="queue-list"] > li').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-question-id') ?? ''),
  );
}

test('[Q02] the queue is hand-ordered, and the order survives restart', async ({ workspace }) => {
  // Filled in the first process and compared in the second; the ids themselves are minted
  // at creation and cannot be predicted from outside.
  const arranged: string[] = [];

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openQueue(window);

    await addQuestion(window, FIRST);
    await addQuestion(window, SECOND);
    await addQuestion(window, THIRD);

    // A new question joins at the end: nothing here guesses at a priority.
    await expect(queuedTitles(window)).toHaveText([FIRST, SECOND, THIRD]);
    const created = await queuedIds(window);
    const [one, two, three] = created;
    if (one === undefined || two === undefined || three === undefined) {
      throw new Error('queue: expected three rows');
    }

    // Third to the top, then the first one down past the second. The result is an order that
    // is neither the order they were typed nor its reverse, and that nothing sorts into.
    await dragOnto(window, three, one);
    await expect(queuedTitles(window)).toHaveText([THIRD, FIRST, SECOND]);

    await dragOnto(window, one, two);
    await expect(queuedTitles(window)).toHaveText([THIRD, SECOND, FIRST]);

    arranged.push(...(await queuedIds(window)));
    expect(arranged).toEqual([three, two, one]);
  } finally {
    await first.app.close();
  }

  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openQueue(window);
    await expect(queuedTitles(window)).toHaveText([THIRD, SECOND, FIRST]);
    expect(await queuedIds(window)).toEqual(arranged);

    // The position codes are read down the list, so they have to renumber with it rather
    // than travel with the notebook they were first given to.
    await expect(window.locator('[data-testid="queue-list"] .wr-queue__code')).toHaveText([
      'N·01',
      'N·02',
      'N·03',
    ]);
  } finally {
    await second.app.close();
  }
});

test('[Q02] the grip reorders from the keyboard, and that lands in the library too', async ({
  window,
}) => {
  await openQueue(window);
  await addQuestion(window, FIRST);
  await addQuestion(window, SECOND);
  await expect(queuedTitles(window)).toHaveText([FIRST, SECOND]);

  const ids = await queuedIds(window);
  const last = ids[1];
  if (last === undefined) throw new Error('queue: expected two rows');

  // A grip you can only drag is a grip some people cannot use.
  await window.locator(`[data-testid="queue-grip-${last}"]`).focus();
  await window.keyboard.press('ArrowUp');
  await expect(queuedTitles(window)).toHaveText([SECOND, FIRST]);

  // Closing the panel throws away every bit of renderer state it held; reopening asks the
  // main process again. What comes back is what was actually stored.
  await window.locator('[data-testid="activity-questions"]').click();
  await expect(window.locator('[data-testid="questions-sidebar"]')).toBeHidden();
  await openQueue(window);
  await expect(queuedTitles(window)).toHaveText([SECOND, FIRST]);
});
