/**
 * The gestures a document you write in has to have (criteria P07, P11).
 *
 * Both surfaces the researcher writes on are one block editor over one markdown document, so
 * both criteria are about the same code and are asserted where each is actually used: the
 * notebook's page is the thing you rearrange, the journal is where a picture lands.
 *
 * `P07` — a page whose blocks can only be appended is an outline, not a draft. Order is the
 * one thing the document and the screen have to agree about, and a reorder is a *write*: the
 * assertion that matters is not that the boxes swapped on screen but that the markdown on disk
 * says what the screen says, which is why both tests read the stored body back out of the
 * database rather than trusting the DOM.
 *
 * `P11` — a figure arrives at whatever size it happens to be, and a paper needs it at the size
 * the author chose. The width has to live in the document like everything else here, or the
 * next process to open the page draws it wrong; so the test restarts the app.
 *
 * Neither gesture is HTML5 drag-and-drop, and both tests drive a real pointer for that reason:
 * the preload's file-drop listener is watching `drop` on these very elements, so a block drag
 * built on `dragstart` would be indistinguishable from a picture arriving.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@wr/database';
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { dropFileOn } from './support/drop.js';
import { seedNotebook, type E2EWorkspace } from './support/workspace.js';
import type { Locator, Page } from '@playwright/test';

const NOTEBOOK = 'Does spacing beat massing in a 12-layer model?';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_IMAGE = join(REPO_ROOT, 'tests', 'fixtures', 'node-icon.png');

/** Three blocks whose order can be read at a glance, and which nothing else could produce. */
const THREE = ['Alpha is the first paragraph.', 'Bravo is the second.', 'Charlie is the third.'];

function writeBody(workspace: E2EWorkspace, notebookId: string, body: string): void {
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    db.questions.writeBody(notebookId, body);
  } finally {
    db.close();
  }
}

function storedBody(workspace: E2EWorkspace, notebookId: string): string {
  const { db } = openDatabase({ file: workspace.databasePath, readonly: true, migrate: false });
  try {
    return db.questions.readBody(notebookId) ?? '';
  } finally {
    db.close();
  }
}

/** The one day this notebook has written, read straight out of the database. */
function storedDay(workspace: E2EWorkspace, notebookId: string): string {
  const { db } = openDatabase({ file: workspace.databasePath, readonly: true, migrate: false });
  try {
    return db.journal.list(notebookId).at(0)?.markdown ?? '';
  } finally {
    db.close();
  }
}

async function openNotebook(window: Page, notebookId: string): Promise<void> {
  const directory = window.locator('[data-testid="notebook-directory"]');
  await expect(async () => {
    if (!(await directory.isVisible())) {
      await window.locator('[data-testid="activity-notebooks"]').click();
    }
    await expect(directory).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await window.locator(`[data-testid="directory-open-${notebookId}"]`).click();
  await expect(window.locator('[data-testid="notebook-panel"]')).toHaveAttribute(
    'data-question-id',
    notebookId,
  );
}

/** Open a notebook's journal, or reveal the one already open on it. */
async function openJournal(window: Page, notebookId: string): Promise<void> {
  const page = window.locator(`[data-testid="journal-page"][data-notebook-id="${notebookId}"]`);
  await expect(async () => {
    if (!(await page.isVisible())) {
      const directory = window.locator('[data-testid="notebook-directory"]');
      if (!(await directory.isVisible())) {
        await window.locator('[data-testid="activity-notebooks"]').click();
      }
      await window.locator(`[data-testid="directory-journal-${notebookId}"]`).click();
    }
    await expect(page).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** The text of every block of a surface, top to bottom — the order the researcher sees. */
async function blockTexts(window: Page, prefix: string): Promise<string[]> {
  return window
    .locator(`[data-testid^="${prefix}-block-"]:not([data-testid*="editor"])`)
    .allTextContents();
}

/**
 * Drag one element onto another with a real pointer, passing its midpoint.
 *
 * Stepped rather than teleported: the surface reorders as the pointer crosses each midpoint,
 * so a single jump would test one `pointermove` and nothing about the gesture. The last move
 * lands past the target's midpoint, because that is what decides where the block goes.
 */
async function dragOnto(window: Page, grip: Locator, target: Locator, edge: 'top' | 'bottom') {
  const from = await grip.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error('the drag has nothing to hold on to');
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endY = edge === 'top' ? to.y + to.height * 0.25 : to.y + to.height * 0.75;

  await window.mouse.move(startX, startY);
  await window.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await window.mouse.move(startX, startY + ((endY - startY) * step) / 8);
  }
  await window.mouse.up();
}

test('[P07] a block is dragged into a new place and another is deleted, and the page says so', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  writeBody(workspace, notebookId, `${THREE.join('\n\n')}\n`);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, notebookId);
    expect(await blockTexts(window, 'notebook')).toEqual(THREE);

    // Charlie is dragged up past Alpha's midpoint. The grip is the only thing that starts a
    // drag: the block itself is text you click into, and a page where holding a paragraph
    // moved it would be unwritable.
    await dragOnto(
      window,
      window.locator('[data-testid="notebook-grip-2"]'),
      window.locator('[data-testid="notebook-row-0"]'),
      'top',
    );
    await expect
      .poll(async () => blockTexts(window, 'notebook'))
      .toEqual([THREE[2], THREE[0], THREE[1]]);

    // The order on screen is the order in the document. Not a view state, not a column in a
    // table beside the markdown — the same file anything else that reads this notebook reads.
    await expect
      .poll(() => storedBody(workspace, notebookId), { timeout: 15_000 })
      .toBe(`${[THREE[2], THREE[0], THREE[1]].join('\n\n')}\n`);

    // And a block is taken out altogether. Alpha is now in the middle; deleting it leaves the
    // two either side of it, in the order the drag left them.
    await window.locator('[data-testid="notebook-delete-1"]').click();
    await expect
      .poll(async () => blockTexts(window, 'notebook'))
      .toEqual([THREE[2], THREE[1]]);
    await expect
      .poll(() => storedBody(workspace, notebookId), { timeout: 15_000 })
      .toBe(`${[THREE[2], THREE[1]].join('\n\n')}\n`);
  } finally {
    await first.app.close();
  }

  // Both survive a restart, because both were edits of the document rather than of a view.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, notebookId);
    expect(await blockTexts(window, 'notebook')).toEqual([THREE[2], THREE[1]]);
  } finally {
    await second.app.close();
  }
});

test('[P07] the same two gestures are on the journal, because it is the same editor', async ({
  workspace,
}) => {
  // Not a copy of the test above: the point is that there is one block editor and not two, so
  // what is asserted here is that the handles exist on the other surface and act on its own
  // document. A journal that grew its own drag would be the second implementation this design
  // exists to prevent.
  const notebookId = seedNotebook(workspace, NOTEBOOK, [
    { date: localToday(), markdown: `${THREE.join('\n\n')}\n` },
  ]);

  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await openJournal(window, notebookId);
    expect(await blockTexts(window, 'journal')).toEqual(THREE);

    await dragOnto(
      window,
      window.locator('[data-testid="journal-grip-0"]'),
      window.locator('[data-testid="journal-row-2"]'),
      'bottom',
    );
    await expect
      .poll(async () => blockTexts(window, 'journal'))
      .toEqual([THREE[1], THREE[2], THREE[0]]);

    await window.locator('[data-testid="journal-delete-0"]').click();
    await expect.poll(async () => blockTexts(window, 'journal')).toEqual([THREE[2], THREE[0]]);
  } finally {
    await launched.app.close();
  }

  // Read back in a second process, from the day's own markdown.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openJournal(window, notebookId);
    expect(await blockTexts(window, 'journal')).toEqual([THREE[2], THREE[0]]);
  } finally {
    await second.app.close();
  }
});

test('[P11] a figure is dragged to the size it should be, and stays that size', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);

  // A picture where the researcher keeps it, dropped in the way the only way bytes can arrive.
  const inbox = join(workspace.dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const picture = join(inbox, 'attention-pattern.png');
  copyFileSync(FIXTURE_IMAGE, picture);

  let dragged: number;

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openJournal(window, notebookId);

    await dropFileOn(window, '[data-testid="journal-blocks"]', picture);
    const figure = window.locator('[data-block-type="image"]').first();
    await expect(figure).toBeVisible({ timeout: 30_000 });
    const image = figure.locator('img');
    await expect(image).toHaveAttribute('src', /^rrfile:\/\/dfl_/u);
    await expect
      .poll(async () => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
        timeout: 30_000,
        message: 'the dropped picture never loaded over rrfile://',
      })
      .toBeGreaterThan(0);

    // It arrives at its own size, with no width of its own in the document.
    await expect(image).toHaveAttribute('data-width', '');
    const before = await image.boundingBox();
    if (before === null) throw new Error('the figure did not lay out');

    // The corner is dragged out by 120 pixels. A real pointer, stepped, on the handle beside
    // the image — the image itself stays a block you can click into.
    const handle = figure.locator('[data-testid^="journal-resize-"]');
    const grip = await handle.boundingBox();
    if (grip === null) throw new Error('the figure has no corner to drag');
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    await window.mouse.move(x, y);
    await window.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await window.mouse.move(x + (120 * step) / 6, y);
    }
    await window.mouse.up();

    // The image really is wider on screen, and the width it landed on is a number the page
    // can be asked for rather than one a bounding box has to be measured for.
    await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(
      before.width + 80,
    );
    dragged = Number(await image.getAttribute('data-width'));
    expect(dragged).toBeGreaterThan(before.width + 80);
  } finally {
    await first.app.close();
  }

  // The width is in the day's own markdown — one word in the image's title slot — so it is a
  // fact about the document rather than about the panel that drew it once.
  const markdown = storedDay(workspace, notebookId);
  expect(markdown).toContain(`w=${String(dragged)}`);
  expect(markdown).toMatch(/^!\[[^\]]*\]\(rrfile:\/\/dfl_[^\s)]+ "w=\d+"\)$/mu);

  // And a second process draws it at that width, which is the whole of what "resized" means.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openJournal(window, notebookId);
    const image = window.locator('[data-block-type="image"] img').first();
    await expect(image).toHaveAttribute('data-width', String(dragged));
    const box = await image.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(Math.round(box?.width ?? 0)).toBe(dragged);
  } finally {
    await second.app.close();
  }
});

/** Today, the way the app's own calendar spells it. */
function localToday(): string {
  const at = new Date();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${String(at.getFullYear())}-${month}-${day}`;
}
