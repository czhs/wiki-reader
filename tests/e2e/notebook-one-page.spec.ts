/**
 * The notebook is one page (criteria P10, P12).
 *
 * The researcher's verdict on the milestone-6 page was that it was a quarter of its own panel:
 * a 240px margin held the front matter, the outline and the claims, a board held the cards, and
 * the writing surface — the thing the page exists for — got what was left. So `P10` folds the
 * margin into the document. Front matter, the outline and the hypotheses are *sections you
 * scroll to*, in the order a paper is read, and the writing takes the room.
 *
 * `P12` is the other half of writing in one long document: once the page is something you
 * scroll through rather than a box you click out of, blurring is no longer a natural way to
 * save. `Cmd+S` has to work **while you are typing**, which is the one condition that makes it
 * worth having and the one an implementation is most likely to get wrong — the binding is
 * deliberately not guarded by `!textInputFocus`, and saving deliberately does not close the
 * block. A test that blurred first would pass against an implementation that is useless.
 */
import { openDatabase } from '@wr/database';
import { COMMAND_IDS } from '@wr/workbench';
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { press } from './support/keys.js';
import { seedNotebook } from './support/workspace.js';
import type { E2EWorkspace } from './support/workspace.js';
import type { Page } from '@playwright/test';

const NOTEBOOK = 'Does spacing beat massing in a 12-layer model?';

/**
 * A page long enough that its parts cannot all be on screen at once.
 *
 * Load-bearing: "scroll to a section" is not a claim you can make about a document that fits.
 */
const LONG_BODY = [
  '= Question',
  'Does spacing beat massing in a 12-layer model?',
  ...Array.from({ length: 24 }, (_, index) => `Paragraph ${String(index + 1)} of the working notes.`),
  '= Method',
  'Two schedules, massed and spaced, over the same token budget.',
  ...Array.from({ length: 24 }, (_, index) => `Method note ${String(index + 1)}.`),
  '= Results',
  'Spaced wins by 4.1 points at 12 layers.',
].join('\n\n');

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

/** How far the page has been scrolled, which is the only honest measure of "went there". */
const scrolledBy = (window: Page): Promise<number> =>
  window.locator('[data-testid="notebook-page"]').evaluate((element) => element.scrollTop);

/** Whether a section's top edge is inside the page's own viewport. */
async function isInView(window: Page, testId: string): Promise<boolean> {
  return window.evaluate((id) => {
    const scroller = document.querySelector('[data-testid="notebook-page"]');
    const section = document.querySelector(`[data-testid="${id}"]`);
    if (scroller === null || section === null) return false;
    const outer = scroller.getBoundingClientRect();
    const inner = section.getBoundingClientRect();
    return inner.top >= outer.top - 2 && inner.top < outer.bottom;
  }, testId);
}

test('[P10] front matter, sections and hypotheses are parts of the page, scrolled to rather than beside it', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  writeBody(workspace, notebookId, LONG_BODY);

  const opened: LaunchedApp = await launchApp(workspace);
  try {
    const window = opened.window;
    await openNotebook(window, notebookId);

    // The margin is gone. Asserted by the element it was, so a margin that had merely been
    // restyled narrow could not pass.
    await expect(window.locator('[data-testid="notebook-side"]')).toHaveCount(0);

    // All three are sections of the one scrolling document, in the order a paper is read, and
    // each of them is *inside* the scroller rather than a sibling of it.
    const scroller = window.locator('[data-testid="notebook-page"]');
    for (const part of ['front-matter', 'sections', 'writing', 'hypotheses']) {
      await expect(scroller.locator(`[data-testid="notebook-section-${part}"]`)).toHaveCount(1);
    }
    // The front matter is still the front matter: the same three fields, on the page now.
    for (const field of ['notebook-description', 'notebook-next-action', 'notebook-tags']) {
      await expect(
        scroller.locator(`[data-testid="notebook-section-front-matter"] [data-testid="${field}"]`),
      ).toHaveCount(1);
    }

    // It opens at the top, on the front matter.
    expect(await scrolledBy(window)).toBe(0);
    expect(await isInView(window, 'notebook-section-front-matter')).toBe(true);

    // And the claims are somewhere below the paper, reached by scrolling to them.
    await window.locator('[data-testid="notebook-jump-hypotheses"]').click();
    await expect
      .poll(() => scrolledBy(window), {
        timeout: 10_000,
        message: 'the page never scrolled to the hypotheses',
      })
      .toBeGreaterThan(0);
    expect(await isInView(window, 'notebook-section-hypotheses')).toBe(true);

    // Back up to the top, the same way.
    await window.locator('[data-testid="notebook-jump-front-matter"]').click();
    await expect
      .poll(() => scrolledBy(window), { timeout: 10_000, message: 'the page never came back' })
      .toBe(0);

    // The outline is a section of the page too, and it still does what it did in the margin:
    // it goes to a heading of the paper (`S01`). `Results` is the last of three, and it is a
    // long way down a document this size.
    await window.locator('[data-testid="notebook-outline-2"]').click();
    await expect
      .poll(() => scrolledBy(window), {
        timeout: 10_000,
        message: 'the outline did not scroll the page',
      })
      .toBeGreaterThan(0);
    // Typst's HTML export keeps `<h1>` for the document itself, so a `=` heading is an `<h2>`;
    // `Results` is the third and last of them.
    await expect(
      window.locator('[data-testid="notebook-blocks"] h2').nth(2),
    ).toBeInViewport();

    // Front matter still writes from where it now lives — a section that only *looks* like the
    // margin would pass everything above this line.
    const description = window.locator('[data-testid="notebook-description"]');
    await description.fill('Whether spacing survives depth.');
    await description.blur();
    await expect
      .poll(
        () => {
          const { db } = openDatabase({
            file: workspace.databasePath,
            readonly: true,
            migrate: false,
          });
          try {
            return db.questions.get(notebookId)?.description ?? null;
          } finally {
            db.close();
          }
        },
        { timeout: 10_000, message: 'the front matter never reached the database' },
      )
      .toBe('Whether spacing survives depth.');
  } finally {
    await opened.app.close();
  }
});

test('[P12] Cmd+S saves the page mid-sentence, without taking the caret away', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  const SENTENCE = 'Spacing wins by 4.1 points, and the gap widens with depth.';

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, notebookId);

    // Nothing has been written yet, so nothing has been saved yet — which is what makes the
    // chip appearing below evidence of this keystroke rather than of an earlier blur.
    await expect(window.locator('[data-testid="notebook-saved"]')).toHaveCount(0);
    expect(storedBody(workspace, notebookId)).toBe('');

    await window.locator('[data-testid="notebook-add-text"]').click();
    const editor = window.locator('[data-testid^="notebook-block-editor-"]');
    await expect(editor).toBeVisible();
    await editor.fill(SENTENCE);

    // Still typing: the block is open, the textarea has focus, nothing has been blurred. This
    // is the only state `P12` is about.
    await expect(editor).toBeFocused();
    await press(window, COMMAND_IDS.saveWriting);

    await expect(window.locator('[data-testid="status-message"]')).toContainText('Saved');
    await expect(window.locator('[data-testid="notebook-saved"]')).toBeVisible();

    // …and the researcher is still in the sentence they were writing. A save that closed the
    // block would satisfy every assertion above and be the wrong feature.
    await expect(editor).toBeFocused();
    expect(await editor.inputValue()).toBe(SENTENCE);

    // It really reached the database, while the block is still open and unblurred.
    expect(storedBody(workspace, notebookId)).toContain(SENTENCE);

    // And it still means this page after a second writing surface has been over it and gone.
    // `P09` puts the journal up as a pop-up with a block editor of its own, which takes the
    // hand while it is there; closing it used to leave the hand empty, so `Cmd+S` answered
    // "open a notebook page or a journal day first" over the open page it was pressed on and
    // wrote nothing. Reachable in one gesture from inside this milestone's own layout.
    await window.locator('[data-testid="activity-journal"]').click();
    await expect(window.locator('[data-testid="journal-popup"]')).toBeVisible();
    await window.locator('[data-testid="journal-popup-close"]').click();
    await expect(window.locator('[data-testid="journal-popup"]')).toHaveCount(0);

    const AFTER = 'The moderator is depth, not the treatment.';
    await window.locator('[data-testid="notebook-add-text"]').click();
    const reopened = window.locator('[data-testid^="notebook-block-editor-"]');
    await expect(reopened).toBeVisible();
    await reopened.fill(AFTER);
    await press(window, COMMAND_IDS.saveWriting);

    await expect(window.locator('[data-testid="status-message"]')).not.toContainText(
      'Open a notebook page',
    );
    await expect
      .poll(() => storedBody(workspace, notebookId), {
        timeout: 10_000,
        message: 'Cmd+S wrote nothing after the journal pop-up closed',
      })
      .toContain(AFTER);
  } finally {
    await first.app.close();
  }

  // And it is there in a process that never saw the keystroke.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, notebookId);
    await expect(window.locator('[data-testid="notebook-panel"]')).toContainText(SENTENCE);
  } finally {
    await second.app.close();
  }
});
