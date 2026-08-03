/**
 * A notebook's journal, driven the way it is used (J01, J03, N09–N11, P03–P05).
 *
 * J01 and J03 are integration-level and are asserted over the router in
 * `tests/integration/journal.test.ts`. This spec exists because the page itself is real code
 * that nothing else runs: a calendar that never marks a day, or a save that never fires, is
 * invisible to a test that calls the channel directly. So today's bubble is checked for the
 * fill that means "logged", the entry is read back in a second process, and clearing it puts
 * the day back to unlogged rather than leaving a blank entry behind.
 *
 * N09 is about where it lives, and it has moved once more. It was a 260px sidebar, which sizes
 * a day's thinking like a filter; it became a page in the workspace; and `P09` re-promised it
 * as a **pop-up that expands into that page**, because most visits to a journal are a glance
 * and a tab makes a glance cost the reading underneath it. The test measures both homes rather
 * than trusting the markup to have moved.
 *
 * `P08` is the other half of arriving on a day: a day you have come to is a day you came to
 * write in, so it opens with a block ready. Costless — a block nobody typed into serializes to
 * nothing, so looking at a day does not log it.
 *
 * N10 is about how far back it goes, and `P03` is about who decides: the calendar begins where
 * the researcher says, and every day from there to today is on it.
 *
 * `P04` and `P05` are about the two gestures a block notebook lives or dies by — putting a
 * figure in one, and clicking into one.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, test, expect, showLibrary, type LaunchedApp } from './support/app.js';
import { seedNotebook } from './support/workspace.js';
import { dropFileOn } from './support/drop.js';
import type { Page } from '@playwright/test';

const ENTRY = 'Ran the induction-head sweep. Layer 14 head 3 looks like a copier.';
const NOTEBOOK = 'Do induction heads appear in VLAs?';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_IMAGE = join(REPO_ROOT, 'tests', 'fixtures', 'node-icon.png');

/** An ISO day, `n` days before today, in local time — the days the calendar draws. */
function daysAgo(n: number): string {
  const at = new Date();
  at.setDate(at.getDate() - n);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${String(at.getFullYear())}-${month}-${day}`;
}

/** The app's own notion of today, taken from the running renderer rather than from Node. */
async function today(window: Page): Promise<string> {
  return window.evaluate(() => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${String(now.getFullYear())}-${month}-${day}`;
  });
}

/** Open the directory page, or reveal the one a restored workspace already has. */
async function openDirectory(window: Page): Promise<void> {
  const directory = window.locator('[data-testid="notebook-directory"]');
  await expect(async () => {
    if (!(await directory.isVisible())) {
      await window.locator('[data-testid="activity-notebooks"]').click();
    }
    await expect(directory).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Make a notebook the way a researcher does, and answer with its id. */
async function makeNotebook(window: Page, title: string): Promise<string> {
  await openDirectory(window);
  await window.locator('[data-testid="directory-new-title"]').fill(title);
  await window.locator('[data-testid="directory-add"]').click();
  const panel = window.locator('[data-testid="notebook-panel"]');
  await expect(panel).toBeVisible();
  const id = await panel.getAttribute('data-question-id');
  if (id === null) throw new Error('the new notebook has no id');
  return id;
}

/**
 * Open a notebook's journal, or reveal the one already open on it.
 *
 * Through the directory, which is the door: a journal belongs to its notebook (`P02`), and
 * the directory of notebooks is also the directory of journals.
 */
async function openJournal(window: Page, notebookId: string): Promise<void> {
  const page = window.locator(`[data-testid="journal-page"][data-notebook-id="${notebookId}"]`);
  await expect(async () => {
    if (!(await page.isVisible())) {
      await openDirectory(window);
      await window.locator(`[data-testid="directory-journal-${notebookId}"]`).click();
    }
    await expect(page).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Write the day the way the notebook is used: add a block, type into it, click away.
 *
 * Blurring is what commits — the same as everywhere else in the app — so the tests below
 * blur rather than pressing a button, and the button is only exercised where a person would
 * reach for it.
 */
async function addBlock(window: Page, kind: 'text' | 'code', source: string): Promise<void> {
  await window.locator(`[data-testid="journal-add-${kind}"]`).click();
  const editor = window.locator('[data-testid^="journal-block-editor-"]');
  await editor.fill(source);
  await editor.blur();
}

/** Edit a block that is already there, by clicking it and replacing its source. */
async function editBlock(window: Page, index: number, source: string): Promise<void> {
  await window.locator(`[data-testid="journal-block-${String(index)}"]`).click();
  const editor = window.locator(`[data-testid="journal-block-editor-${String(index)}"]`);
  await expect(editor).toBeVisible();
  await editor.fill(source);
  await editor.blur();
}

test('[J01] a day is written in the page, marked on the calendar, and still there next launch', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openJournal(window, notebookId);
    const date = await today(window);

    // Nothing written yet: today is on the calendar, and it is not marked.
    const bubble = window.locator(`[data-testid="journal-day-${date}"]`);
    await expect(bubble).toHaveAttribute('data-logged', 'false');

    await addBlock(window, 'text', ENTRY);
    await expect(bubble).toHaveAttribute('data-logged', 'true');
  } finally {
    await first.app.close();
  }

  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openJournal(window, notebookId);
    // Asked again rather than carried over: the page opens on today, and today is whatever
    // the second process thinks it is.
    const date = await today(window);
    await expect(window.locator('[data-testid="journal-block-0"]')).toContainText(ENTRY);
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );

    // Cleared to nothing, the day goes back to unlogged — there is no such thing as an
    // entry that says nothing.
    await editBlock(window, 0, '');
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'false',
    );
  } finally {
    await second.app.close();
  }
});

/**
 * The edge, without the margin that used to curate it (`J03`, superseded by `P13`).
 *
 * A day advancing another notebook is still a typed edge — `journal-entry-advances-question`,
 * made and read like every other one — and the repository half of that promise is asserted in
 * `tests/integration/journal.test.ts`. What is gone is the **Advances** section in the
 * journal's margin: the researcher does not want it, so `P13` takes it away, and this test
 * keeps the half that is about the app rather than about the section.
 */
test('[J03] an entry says which other notebook it advanced, without a margin section for it', async ({
  window,
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, 'Reading week');
  await makeNotebook(window, NOTEBOOK);

  await openJournal(window, notebookId);
  await addBlock(window, 'text', ENTRY);

  // The margin offers neither the list nor the picker any more.
  await expect(window.locator('[data-testid="journal-advances"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="journal-advance-picker"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="journal-side"]')).toBeVisible();
});

test('[N09] the journal comes up over the workspace and expands into a page of it', async ({
  window,
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  const [paper] = workspace.pdfDocuments;
  expect(paper).toBeDefined();
  if (paper === undefined) return;

  // A document open first, so there is a real reader on screen to measure the journal
  // against. "A reader's width" is not a number in the abstract — it is this.
  await showLibrary(window);
  await window
    .locator(`[data-testid="library-panel"] [data-testid="library-item-${paper.id}"]`)
    .click();
  const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${paper.id}"]`);
  await expect(reader).toBeVisible();
  const readerBox = await reader.boundingBox();
  expect(readerBox).not.toBeNull();
  if (readerBox === null) return;

  await openJournal(window, notebookId);

  // Not a sidebar, and — since `P09` — not a tab either at first. It stands over the
  // workspace, on the same sheet every other surface that interrupts uses, with the reading
  // it interrupted still underneath it.
  await expect(window.locator('[data-testid="journal-sidebar"]')).toHaveCount(0);
  // Nor is anything else: there are no side panels left in this app (`U15`).
  await expect(window.locator('.wr-sidebar')).toHaveCount(0);
  const popup = window.locator('[data-testid="journal-popup"]');
  await expect(popup).toBeVisible();
  await expect(window.locator('[data-testid="journal-scrim"]')).toBeVisible();
  // The workspace it interrupted is still under it, untouched: the page that was in the centre
  // when the journal was asked for is the page that is there behind the sheet.
  await expect(window.locator('[data-testid="notebook-directory"]')).toBeVisible();
  await expect(
    window.locator('[data-testid="dockview-container"] [data-testid="journal-page"]'),
  ).toHaveCount(0);
  await expect(window.locator('.dv-tab', { hasText: '— today' })).toHaveCount(0);

  // It is the whole journal up there, not a summary of one: the day, the calendar and the
  // blocks the day is written in.
  await expect(popup.locator('[data-testid="journal-selected-date"]')).toBeVisible();
  await expect(popup.locator('[data-testid="journal-calendar"]')).toBeVisible();
  await expect(popup.locator('[data-testid="journal-blocks"]')).toBeVisible();

  // Escape puts it away without touching what is behind it.
  await window.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(window.locator('[data-testid="notebook-directory"]')).toBeVisible();

  // And it expands. One command from the sheet, and the same view carries on as a page of the
  // workspace: inside the Dockview centre, with a tab named for the notebook and the day.
  await openJournal(window, notebookId);
  await window.locator('[data-testid="journal-expand"]').click();
  await expect(popup).toHaveCount(0);
  const page = window.locator('[data-testid="dockview-container"] [data-testid="journal-page"]');
  await expect(page).toBeVisible();
  await expect(window.locator('.dv-tab', { hasText: '— today' })).toHaveCount(1);

  const pageBox = await page.boundingBox();
  expect(pageBox).not.toBeNull();
  if (pageBox === null) return;
  // Expanded means *the full page*: a day's entry gets the width a paper gets, not the 260px
  // of the sidebar it used to live in nor the sheet it came from.
  expect(pageBox.width).toBeGreaterThan(600);
  expect(pageBox.width).toBeCloseTo(readerBox.width, 0);

  // And the day's entry — not the calendar — is what that width is spent on.
  const entryBox = await page.locator('[data-testid="journal-blocks"]').boundingBox();
  const calendarBox = await page.locator('[data-testid="journal-calendar"]').boundingBox();
  expect(entryBox).not.toBeNull();
  expect(calendarBox).not.toBeNull();
  if (entryBox === null || calendarBox === null) return;
  expect(entryBox.width).toBeGreaterThan(calendarBox.width);
  // Beside it, not above or below: the calendar starts to the right of where the entry ends.
  expect(calendarBox.x).toBeGreaterThan(entryBox.x + entryBox.width - 1);

  // One page per notebook, not one per click: expanding the same notebook's journal again
  // reveals the tab that is already there rather than growing a second one.
  await window.locator('[data-testid="activity-journal"]').click();
  await window.locator('[data-testid="journal-expand"]').click();
  await expect(window.locator('.dv-tab', { hasText: '— today' })).toHaveCount(1);
});

test('[P09] the journal is written in over the reading, and carries into the page it expands to', async ({
  window,
  workspace,
}) => {
  // A fortnight of work behind it, so the calendar covers a day that is not today. The day
  // matters: "carries into the page" was asserted only on today's blocks, which the expanded
  // page would have shown whether anything carried or not — a pop-up open on last Tuesday
  // expanded into a page showing today, and the test could not tell.
  const began = daysAgo(9);
  const earlier = daysAgo(4);
  const notebookId = seedNotebook(workspace, NOTEBOOK, [
    { date: began, markdown: 'Picked the direction.' },
  ]);
  const [paper] = workspace.pdfDocuments;
  expect(paper).toBeDefined();
  if (paper === undefined) return;

  // A paper open, being read. This is the state the criterion is about: the journal is asked
  // for *from inside the reading*, and the reading is what must not be taken away.
  await showLibrary(window);
  await window
    .locator(`[data-testid="library-panel"] [data-testid="library-item-${paper.id}"]`)
    .click();
  const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${paper.id}"]`);
  await expect(reader).toBeVisible();

  // The activity bar's journal, which is the journal of the notebook in hand (`P02`). No
  // second command for "as a pop-up": where it lands is the host's decision, so every door
  // into the journal — the bar, the directory row, the page's own header, a right-click —
  // arrives at the same place.
  await window.locator('[data-testid="activity-journal"]').click();
  const popup = window.locator('[data-testid="journal-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup).toHaveAttribute('data-notebook-id', notebookId);
  // The paper is still open behind it, in the same tab it was in: nothing was closed, nothing
  // was split, and the reading is one Escape away.
  await expect(reader).toBeVisible();
  // Two: the paper, and the library the app opened on — which is a tab now (`U15`).
  await expect(window.locator('.dv-tab')).toHaveCount(2);

  // Read back to an earlier day, up in the sheet. This is the ordinary use — what did I do on
  // Tuesday — and it is the state the expansion has to carry.
  await popup.locator(`[data-testid="journal-day-${earlier}"]`).click();
  await expect(popup.locator('[data-testid="journal-selected-date"]')).toHaveText(earlier);

  // It is written in up there — the same block editor, the same day, the same document.
  const note = 'Figure 3 is the one to reproduce first.';
  const editor = popup.locator('[data-testid="journal-block-editor-0"]');
  await expect(editor).toBeVisible();
  await editor.fill(note);
  await editor.blur();
  await expect(popup.locator('[data-testid="journal-block-0"]')).toContainText(note);

  // And it expands, carrying what was written into the page rather than starting again.
  await window.locator('[data-testid="journal-expand"]').click();
  await expect(popup).toHaveCount(0);
  const page = window.locator('[data-testid="dockview-container"] [data-testid="journal-page"]');
  await expect(page).toBeVisible();
  await expect(page).toHaveAttribute('data-notebook-id', notebookId);
  // The day came with it. Not today: the pop-up and the page are one journal in two places,
  // so the page opens where the sheet was left rather than where a fresh journal would start.
  await expect(page.locator('[data-testid="journal-selected-date"]')).toHaveText(earlier);
  await expect(page.locator('[data-testid="journal-block-0"]')).toContainText(note);
  // A page of the workspace now: a tab of its own beside the paper's, which is still there.
  await expect(window.locator('.dv-tab', { hasText: `— ${earlier}` })).toHaveCount(1);
  // Three: the library the app opened on, the paper, and the day it expanded into (`U15`).
  await expect(window.locator('.dv-tab')).toHaveCount(3);
});

test('[P08] a new day arrives with its first block ready, and is not logged by being looked at', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openJournal(window, notebookId);
    const date = await today(window);

    // The day nobody has written on opens with a block already open and the caret in it. Not
    // a sentence about how to begin, and not a `+ text` to press first: the researcher came
    // here to write, and the click between them and the thought is the thing `P08` removes.
    const editor = window.locator('[data-testid="journal-block-editor-0"]');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue('');
    await expect(editor).toBeFocused();
    await expect(window.locator('[data-testid="journal-blocks-empty"]')).toHaveCount(0);

    // Typing goes straight in — no click first, which is the whole claim.
    await window.keyboard.type('Sweep queued; nothing to say yet.');
    await expect(editor).toHaveValue('Sweep queued; nothing to say yet.');
    await editor.blur();
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );

    // Emptied again, the day goes back to unlogged — and comes back ready, rather than
    // collapsing into a page that has to be clicked before it can be written on.
    await editBlock(window, 0, '');
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'false',
    );
    await expect(window.locator('[data-testid="journal-block-editor-0"]')).toHaveValue('');
  } finally {
    await first.app.close();
  }

  // Restarted, the day is still unlogged: nothing was written to the database by opening it.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openJournal(window, notebookId);
    const date = await today(window);
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'false',
    );
    await expect(window.locator('[data-testid="journal-block-editor-0"]')).toHaveValue('');
  } finally {
    await second.app.close();
  }
});

test('[N10] every day since this notebook began is there, and opening one edits that day', async ({
  workspace,
}) => {
  // Work a fortnight old, with one day written at the start of it and nothing since. The gap
  // is what the criterion is about: those eleven days happened, and a calendar that starts at
  // the first entry can show them while one that starts at the first *entry it knows about*
  // would begin here and claim the work is a day old.
  const began = daysAgo(12);
  const middle = daysAgo(6);
  const notebookId = seedNotebook(workspace, NOTEBOOK, [
    { date: began, markdown: 'Picked the direction. Read two papers, understood one.' },
  ]);

  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await openJournal(window, notebookId);
    const date = await today(window);

    // The far end of the range is on the calendar, and marked.
    await expect(window.locator(`[data-testid="journal-day-${began}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );

    // The days between are drawn, not folded (`V03`): nothing on this calendar stands for a
    // stretch of days, so there is nothing to open before the range can be read.
    await expect(window.locator('[data-testid^="journal-run-"]')).toHaveCount(0);

    // Every day from the beginning to today, with nothing missing and nothing clicked open.
    for (let back = 12; back >= 0; back -= 1) {
      await expect(
        window.locator(`[data-testid="journal-day-${daysAgo(back)}"]`),
        `${daysAgo(back)} is not on the calendar`,
      ).toHaveCount(1);
    }

    // Opening a day edits *that* day. It starts empty — nothing was logged then — and what
    // is typed marks it, without touching today.
    //
    // "Empty" is read as the day's first block being open and blank rather than as the empty
    // message, because `P08` retired that message on this surface: a day you have arrived on
    // is a day you came to write in, so it opens with a block ready instead of a sentence
    // about how to start. The assertion is the stronger one either way — a day showing a
    // *blank* editor is a day with nothing in it.
    const firstBlock = window.locator('[data-testid="journal-block-editor-0"]');
    await window.locator(`[data-testid="journal-day-${middle}"]`).click();
    await expect(window.locator('[data-testid="journal-selected-date"]')).toContainText(middle);
    await expect(firstBlock).toHaveValue('');
    await addBlock(window, 'text', ENTRY);
    await expect(window.locator(`[data-testid="journal-day-${middle}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );

    await window.locator(`[data-testid="journal-day-${date}"]`).click();
    await expect(firstBlock).toHaveValue('');
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'false',
    );

    // And back: the day kept what was written on it, rather than the page keeping one entry
    // and re-dating it.
    await window.locator(`[data-testid="journal-day-${middle}"]`).click();
    await expect(window.locator('[data-testid="journal-block-0"]')).toContainText(ENTRY);
    await expect(window.locator(`[data-testid="journal-day-${began}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );
  } finally {
    await launched.app.close();
  }
});

test('[P03] the calendar begins where the researcher says, and stays there', async ({
  workspace,
}) => {
  // A notebook made today, for work that started three weeks ago. Nothing in the database
  // could know that — which is the whole reason the date is the researcher's to set.
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  const began = daysAgo(21);
  const middle = daysAgo(10);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openJournal(window, notebookId);
    const date = await today(window);

    // Cold, the calendar starts at the notebook's own beginning: today, and nothing before —
    // and the control says so itself, rather than showing an empty field with the answer
    // printed underneath it.
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveCount(1);
    await expect(window.locator(`[data-testid="journal-day-${middle}"]`)).toHaveCount(0);
    await expect(window.locator('[data-testid="journal-start-date"]')).toHaveValue(date);
    await expect(window.locator('[data-testid="journal-start-resolved"]')).toContainText(
      'Worked out from the notebook itself',
    );

    // The researcher moves it back three weeks.
    await window.locator('[data-testid="journal-start-date"]').fill(began);

    // The calendar now begins there, and every day from the start to today is on it — nothing
    // before the start, and nothing folded away to be clicked open first (`V03`).
    await expect(window.locator('[data-testid="journal-start-date"]')).toHaveValue(began);
    await expect(window.locator('[data-testid="journal-start-resolved"]')).toContainText(
      'Your choice',
    );
    await expect(window.locator('[data-testid^="journal-run-"]')).toHaveCount(0);
    await expect(window.locator(`[data-testid="journal-day-${began}"]`)).toHaveCount(1);
    await expect(window.locator(`[data-testid="journal-day-${middle}"]`)).toHaveCount(1);
    await expect(window.locator(`[data-testid="journal-day-${daysAgo(22)}"]`)).toHaveCount(0);

    // A day that only exists because the start moved is a day that can be written on.
    await window.locator(`[data-testid="journal-day-${middle}"]`).click();
    await expect(window.locator('[data-testid="journal-selected-date"]')).toContainText(middle);
    await addBlock(window, 'text', 'Where this actually started.');
    await expect(window.locator(`[data-testid="journal-day-${middle}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );
  } finally {
    await first.app.close();
  }

  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openJournal(window, notebookId);
    // The start belongs to the notebook, not to the panel that set it. The day written on it
    // is marked, so the run around it is broken and both are on the calendar without anyone
    // opening anything.
    await expect(window.locator('[data-testid="journal-start-date"]')).toHaveValue(began);
    await expect(window.locator('[data-testid="journal-start-resolved"]')).toContainText(
      'Your choice',
    );
    await expect(window.locator(`[data-testid="journal-day-${middle}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );
    await window.locator(`[data-testid="journal-day-${middle}"]`).click();
    await expect(window.locator('[data-testid="journal-block-0"]')).toContainText(
      'Where this actually started',
    );
  } finally {
    await second.app.close();
  }
});

test('[V03] the calendar renders every day of the range, none of them elided', async ({
  workspace,
}) => {
  // Ten weeks, one day written near the start. The old strip folded every unlogged stretch
  // of four days or more into a marker, so a range this long arrived as three bubbles and two
  // elisions; the researcher asked for all of them.
  const span = 70;
  const began = daysAgo(span);
  const written = daysAgo(span - 3);
  // The start is stated rather than inferred, so the range under test is exactly ten weeks
  // however the notebook's own beginning would have resolved (`P03`).
  const notebookId = seedNotebook(
    workspace,
    NOTEBOOK,
    [{ date: written, markdown: 'Read the sweep results. Nothing yet.' }],
    began,
  );

  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await openJournal(window, notebookId);
    const date = await today(window);

    const calendar = window.locator('[data-testid="journal-calendar"]');
    await expect(calendar).toBeVisible();

    // Nothing stands for a stretch of days, and nothing has to be clicked open first.
    await expect(window.locator('[data-testid^="journal-run-"]')).toHaveCount(0);

    // Every day from the beginning to today is its own bubble — counted by the page, and
    // counted again here, because a page that drew the right number of the wrong days would
    // satisfy either assertion alone.
    await expect(calendar).toHaveAttribute('data-day-count', String(span + 1));
    await expect(calendar.locator('[data-testid^="journal-day-"]')).toHaveCount(span + 1);
    for (let back = span; back >= 0; back -= 1) {
      await expect(
        window.locator(`[data-testid="journal-day-${daysAgo(back)}"]`),
        `${daysAgo(back)} is not on the calendar`,
      ).toHaveCount(1);
    }

    // Laid out as months, so ten weeks of days can be read rather than only counted: each
    // month the range touches has its own labelled grid.
    const months = new Set<string>();
    for (let back = span; back >= 0; back -= 1) months.add(daysAgo(back).slice(0, 7));
    await expect(calendar.locator('[data-testid^="journal-month-"]')).toHaveCount(months.size);
    for (const month of months) {
      await expect(calendar.locator(`[data-testid="journal-month-${month}"]`)).toHaveCount(1);
    }

    // The one written day is still marked among all the empty ones, today is still there,
    // and a day ten weeks back opens to its own entry rather than to today's.
    await expect(window.locator(`[data-testid="journal-day-${written}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'false',
    );
    await window.locator(`[data-testid="journal-day-${written}"]`).click();
    await expect(window.locator('[data-testid="journal-selected-date"]')).toContainText(written);
    await expect(window.locator('[data-testid="journal-block-0"]')).toContainText(
      'Read the sweep results',
    );

    // And the day's entry still owns the page: a calendar that renders ten weeks must not
    // take the room the writing surface is there for (`N09`).
    const entryBox = await window.locator('[data-testid="journal-blocks"]').boundingBox();
    const calendarBox = await calendar.boundingBox();
    expect(entryBox).not.toBeNull();
    expect(calendarBox).not.toBeNull();
    if (entryBox === null || calendarBox === null) return;
    expect(entryBox.width).toBeGreaterThan(calendarBox.width);
  } finally {
    await launched.app.close();
  }
});

/** Every file under `dir` with this name, however deep. Used to prove nothing was copied. */
function findByName(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findByName(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

test('[P04] a picture dropped on a day becomes a block, and its bytes stay where they were', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);

  // A figure where the researcher keeps it: outside the Zotero directory, outside the wiki,
  // outside every root this app was configured with.
  const inbox = join(workspace.dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const picture = join(inbox, 'attention-pattern.png');
  copyFileSync(FIXTURE_IMAGE, picture);
  const before = statSync(picture);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openJournal(window, notebookId);
    await addBlock(window, 'text', ENTRY);

    await dropFileOn(window, '[data-testid="journal-blocks"]', picture);

    // The picture is a block in the day, drawn from the library over `rrfile://` — the only
    // way bytes reach this window at all.
    const block = window.locator('[data-testid="journal-block-1"]');
    await expect(block).toHaveAttribute('data-block-type', 'image', { timeout: 30_000 });
    const image = block.locator('img');
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute('src', /^rrfile:\/\/dfl_/u);
    // And the bytes actually arrived: the element reports a natural size only once Chromium
    // fetched it, which means the handler resolved the id through the database, checked the
    // path against the allowed roots and streamed the file.
    await expect
      .poll(async () => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
        timeout: 30_000,
        message: 'the dropped picture never loaded over rrfile://',
      })
      .toBeGreaterThan(0);

    // Nothing on the page says where that picture is. The renderer addressed it by id and
    // was never told the rest.
    const markup = await window.locator('[data-testid="journal-page"]').evaluate(
      (element) => element.outerHTML,
    );
    expect(markup).not.toContain('attention-pattern.png');
    expect(markup).not.toContain(workspace.dir);
    expect(markup).not.toContain('/inbox');
  } finally {
    await first.app.close();
  }

  // The file is still exactly where it was: same inode, same bytes, not moved and not
  // rewritten — and nothing copied it anywhere else in the workspace.
  const after = statSync(picture);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  expect(findByName(workspace.dir, 'attention-pattern.png')).toEqual([picture]);

  // The figure is in the day's markdown, so it comes back the way every other block does.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openJournal(window, notebookId);
    await expect(window.locator('[data-testid="journal-block-1"]')).toHaveAttribute(
      'data-block-type',
      'image',
    );
    await expect(window.locator('[data-testid="journal-block-1"] img')).toHaveCount(1);
  } finally {
    await second.app.close();
  }
});

test('[P05] clicking into a block puts the caret where the click was', async ({
  window,
  workspace,
}) => {
  // A line with a distinctive word at the end, and a heading in front of it: the heading is
  // what makes the rendered text differ from the source, which is the case that gets this
  // wrong quietly.
  const source = '## Sweep notes\n\nLayer fourteen head three copies the previous occurrence';
  const notebookId = seedNotebook(workspace, NOTEBOOK, [
    { date: daysAgo(0), markdown: source },
  ]);
  await openJournal(window, notebookId);

  const block = window.locator('[data-testid="journal-block-1"]');
  await expect(block).toBeVisible();

  // Click on the middle of the word "previous", found from the rendered text rather than
  // guessed from the box, so the assertion is about a real position rather than a pixel.
  const spot = await block.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (node === null || node.textContent === null) return null;
    const at = node.textContent.indexOf('previous');
    if (at === -1) return null;
    const range = document.createRange();
    range.setStart(node, at + 4);
    range.setEnd(node, at + 5);
    const box = range.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  expect(spot).not.toBeNull();
  if (spot === null) return;
  await window.mouse.click(spot.x, spot.y);

  const editor = window.locator('[data-testid="journal-block-editor-1"]');
  await expect(editor).toBeVisible();

  // The caret is inside the word that was clicked — not at the start of the box, which is
  // where it always landed before, and not at the end.
  const caret = await editor.evaluate((element: HTMLTextAreaElement) => element.selectionStart);
  const word = 'Layer fourteen head three copies the previous occurrence'.indexOf('previous');
  expect(caret).toBeGreaterThan(word);
  expect(caret).toBeLessThan(word + 'previous'.length);

  // And typing goes in there, which is the only thing a caret is for.
  await editor.type('!');
  await expect(editor).toHaveValue(
    'Layer fourteen head three copies the prev!ious occurrence',
  );
});

/**
 * A day, written the way one actually is: a note, a command, a figure.
 *
 * Seeded rather than typed because the point of the test is the *view* — that a markdown
 * document already on disk comes back as blocks of the right kinds. What is typed afterwards
 * is what proves the view writes back to that same document.
 */
const SEEDED_DAY = [
  '## Induction heads',
  '',
  'Layer 14 head 3 attends to the previous occurrence, then copies.',
  '',
  '```bash',
  'python sweep.py --layers 12-16',
  '```',
  '',
  '![Attention pattern](rrfile://file_missing)',
  '',
].join('\n');

/**
 * The margin holds the calendar and nothing else (`P13`).
 *
 * It had grown two more sections. **Commands** listed the day's code blocks a second time,
 * beside the day they were already written in — the same fact twice, with whichever copy got
 * edited winning by accident — and **Advances** was a picker for naming another notebook the
 * day moved forward. The researcher does not want either, so both retire.
 *
 * The advances *edge* is not what retires. `journal-entry-advances-question` is a typed edge
 * like any other: `tests/integration/journal.test.ts` makes one and reads it back, and the
 * ledger and the references panel show it wherever it is. What is gone is a strip of margin
 * that had to be curated to have one.
 */
test('[P13] the journal margin has no Commands and no Advances section', async ({
  window,
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK, [
    { date: daysAgo(0), markdown: SEEDED_DAY },
  ]);
  // A second notebook, because Advances was only ever drawn when there was another one to
  // name — its absence has to be asserted in the state that used to draw it.
  await makeNotebook(window, 'Reading week');

  await openJournal(window, notebookId);

  // The day itself is untouched: the command the researcher jotted is still a block of it.
  await expect(window.locator('[data-testid="journal-block-2"] code')).toHaveText(
    'python sweep.py --layers 12-16',
  );

  // The margin is still a margin, and what it holds is the calendar.
  const side = window.locator('[data-testid="journal-side"]');
  await expect(side).toBeVisible();
  await expect(side.locator('[data-testid="journal-calendar"]')).toBeVisible();
  await expect(side.locator('[data-testid="journal-start-date"]')).toBeVisible();

  // Neither retired section is anywhere on the page — not the lists, not the controls that
  // fed them, not the headings they sat under.
  for (const gone of [
    'journal-commands',
    'journal-commands-empty',
    'journal-command-2',
    'journal-command-copy-2',
    'journal-advances',
    'journal-advances-empty',
    'journal-advance-picker',
  ]) {
    await expect(
      window.locator(`[data-testid="${gone}"]`),
      `${gone} is still drawn`,
    ).toHaveCount(0);
  }
  await expect(side).not.toContainText('Commands');
  await expect(side).not.toContainText('Advances');
});

test('[N11] the day is a block notebook, with the calendar beside it', async ({
  workspace,
}) => {
  const date = daysAgo(0);
  const notebookId = seedNotebook(workspace, NOTEBOOK, [{ date, markdown: SEEDED_DAY }]);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openJournal(window, notebookId);

    // One document, four blocks, each the kind its markdown makes it. The image block is
    // asserted as a block rather than as pixels: its bytes would come over `rrfile://` like
    // every other byte, and the window's `img-src` allows nothing else — which is exactly
    // why a day can carry a figure without the app reaching the network.
    const blocks = window.locator('[data-testid^="journal-block-"]');
    await expect(blocks).toHaveCount(4);
    await expect(window.locator('[data-testid="journal-block-0"]')).toHaveAttribute(
      'data-block-type',
      'text',
    );
    await expect(window.locator('[data-testid="journal-block-0"] h2')).toHaveText(
      'Induction heads',
    );
    await expect(window.locator('[data-testid="journal-block-2"]')).toHaveAttribute(
      'data-block-type',
      'code',
    );
    await expect(window.locator('[data-testid="journal-block-2"] code')).toHaveText(
      'python sweep.py --layers 12-16',
    );
    await expect(window.locator('[data-testid="journal-block-3"]')).toHaveAttribute(
      'data-block-type',
      'image',
    );
    await expect(window.locator('[data-testid="journal-block-3"] img')).toHaveCount(1);

    // The notebook is the page's main surface and the calendar is the margin: it is to the
    // right of where the blocks end, and it is not as wide.
    const blocksBox = await window.locator('[data-testid="journal-blocks"]').boundingBox();
    const sideBox = await window.locator('[data-testid="journal-side"]').boundingBox();
    expect(blocksBox).not.toBeNull();
    expect(sideBox).not.toBeNull();
    if (blocksBox === null || sideBox === null) return;
    expect(blocksBox.width).toBeGreaterThan(sideBox.width);
    expect(sideBox.x).toBeGreaterThan(blocksBox.x + blocksBox.width - 1);
    await expect(
      window.locator('[data-testid="journal-side"] [data-testid="journal-calendar"]'),
    ).toBeVisible();

    // Editing one block edits the one document. The prose changes; nothing else does.
    await editBlock(window, 1, 'Layer 14 head 3 is a copier. Layer 9 head 6 might be too.');
    await expect(window.locator('[data-testid="journal-block-1"]')).toContainText('Layer 9 head 6');

    // A command jotted now is a block of the day and nothing else — there is no second list
    // of them in the margin to keep in step (`P13`).
    await addBlock(window, 'code', '```bash\npytest tests/test_heads.py -k copier\n```');
    await expect(window.locator('[data-testid="journal-block-4"]')).toHaveAttribute(
      'data-block-type',
      'code',
    );
    await expect(window.locator('[data-testid="journal-commands"]')).toHaveCount(0);
  } finally {
    await first.app.close();
  }

  // Restarted: the blocks are re-read from the day's markdown, which carries both the edit
  // and everything that was not edited. One document — a block store would have had to be
  // written twice for this to hold.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openJournal(window, notebookId);
    await expect(window.locator('[data-testid^="journal-block-"]')).toHaveCount(5);
    await expect(window.locator('[data-testid="journal-block-0"] h2')).toHaveText(
      'Induction heads',
    );
    await expect(window.locator('[data-testid="journal-block-1"]')).toContainText('Layer 9 head 6');
    await expect(window.locator('[data-testid="journal-block-2"] code')).toHaveText(
      'python sweep.py --layers 12-16',
    );
    await expect(window.locator('[data-testid="journal-block-3"]')).toHaveAttribute(
      'data-block-type',
      'image',
    );
    await expect(window.locator('[data-testid="journal-block-4"] code')).toHaveText(
      'pytest tests/test_heads.py -k copier',
    );
  } finally {
    await second.app.close();
  }
});
