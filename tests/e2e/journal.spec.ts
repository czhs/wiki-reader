/**
 * The journal, driven the way it is used (criteria J01, J03, N09).
 *
 * J01 and J03 are integration-level and are asserted over the router in
 * `tests/integration/journal.test.ts`. This spec exists because the page itself is real code
 * that nothing else runs: a calendar that never marks a day, or a save that never fires, is
 * invisible to a test that calls the channel directly. So today's bubble is checked for the
 * fill that means "logged", the entry is read back in a second process, and clearing it puts
 * the day back to unlogged rather than leaving a blank entry behind.
 *
 * N09 is about where it lives. The journal was a 260px sidebar, which sizes a day's thinking
 * like a filter; it is a page in the workspace now, and the test measures that rather than
 * trusting the markup to have moved.
 *
 * N10 is about how far back it goes: every day since the project began, not since the first
 * day anyone wrote on. That needs a library with a past, which is seeded into the database
 * before the app starts — the calendar offers no way to reach a day before its own start.
 */
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { seedJournalEntry } from './support/workspace.js';
import type { Page } from '@playwright/test';

const ENTRY = 'Ran the induction-head sweep. Layer 14 head 3 looks like a copier.';

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

/**
 * Open the journal page, or reveal the one a restored workspace already has.
 *
 * Polled rather than clicked once because the activity bar's command needs Dockview to be
 * ready, and a restored layout brings the page back without anyone clicking anything.
 */
async function openJournal(window: Page): Promise<void> {
  const page = window.locator('[data-testid="journal-page"]');
  await expect(async () => {
    if (!(await page.isVisible())) {
      await window.locator('[data-testid="activity-journal"]').click();
    }
    await expect(page).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('[J01] a day is written in the panel, marked on the calendar, and still there next launch', async ({
  workspace,
}) => {
  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openJournal(window);
    const date = await today(window);

    // Nothing written yet: today is on the calendar, and it is not marked.
    const bubble = window.locator(`[data-testid="journal-day-${date}"]`);
    await expect(bubble).toHaveAttribute('data-logged', 'false');

    await window.locator('[data-testid="journal-entry-text"]').fill(ENTRY);
    await window.locator('[data-testid="journal-save"]').click();
    await expect(bubble).toHaveAttribute('data-logged', 'true');
  } finally {
    await first.app.close();
  }

  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openJournal(window);
    // Asked again rather than carried over: the panel opens on today, and today is whatever
    // the second process thinks it is.
    const date = await today(window);
    await expect(window.locator('[data-testid="journal-entry-text"]')).toHaveValue(ENTRY);
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );

    // Cleared to nothing, the day goes back to unlogged — there is no such thing as an
    // entry that says nothing.
    await window.locator('[data-testid="journal-entry-text"]').fill('');
    await window.locator('[data-testid="journal-save"]').click();
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'false',
    );
  } finally {
    await second.app.close();
  }
});

test('[J03] an entry says which question it advanced', async ({ window }) => {
  // A question first: the journal can only advance something that exists.
  await window.locator('[data-testid="activity-questions"]').click();
  await window.locator('[data-testid="queue-new-title"]').fill('Do induction heads appear in VLAs?');
  await window.locator('[data-testid="queue-add"]').click();
  await expect(window.locator('[data-testid="queue-list"]')).toContainText('induction heads');
  await window.locator('[data-testid="activity-questions"]').click();

  await openJournal(window);
  await window.locator('[data-testid="journal-entry-text"]').fill(ENTRY);
  await window.locator('[data-testid="journal-save"]').click();

  const picker = window.locator('[data-testid="journal-advance-picker"]');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: 'Do induction heads appear in VLAs?' });

  await expect(window.locator('[data-testid="journal-advances"]')).toContainText(
    'Do induction heads appear in VLAs?',
  );
});

test('[N09] the journal opens as a page in the workspace, at a reader’s width', async ({
  window,
  workspace,
}) => {
  const [paper] = workspace.pdfDocuments;
  expect(paper).toBeDefined();
  if (paper === undefined) return;

  // A document open first, so there is a real reader on screen to measure the journal
  // against. "A reader's width" is not a number in the abstract — it is this.
  await window
    .locator(`[data-testid="library-sidebar"] [data-testid="library-item-${paper.id}"]`)
    .click();
  const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${paper.id}"]`);
  await expect(reader).toBeVisible();
  const readerBox = await reader.boundingBox();
  expect(readerBox).not.toBeNull();
  if (readerBox === null) return;

  await openJournal(window);

  // Not a sidebar: nothing named one is on screen, and the left slot still holds whatever
  // was there before — opening the journal did not take the library's place either.
  await expect(window.locator('[data-testid="journal-sidebar"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="library-sidebar"]')).toBeVisible();

  // A page in the workspace: it is inside the Dockview centre, and it is a tab there.
  const page = window.locator('[data-testid="journal-page"]');
  await expect(window.locator('[data-testid="dockview-container"] [data-testid="journal-page"]')).toBeVisible();
  await expect(window.locator('.dv-tab', { hasText: 'Journal' })).toHaveCount(1);

  const pageBox = await page.boundingBox();
  expect(pageBox).not.toBeNull();
  if (pageBox === null) return;
  // The whole point of the move: a day's entry gets the width a paper gets, not the 260px
  // of the sidebar it used to live in.
  expect(pageBox.width).toBeGreaterThan(600);
  expect(pageBox.width).toBeCloseTo(readerBox.width, 0);

  // And the day's entry — not the calendar — is what that width is spent on.
  const entryBox = await window.locator('[data-testid="journal-entry-text"]').boundingBox();
  const calendarBox = await window.locator('[data-testid="journal-calendar"]').boundingBox();
  expect(entryBox).not.toBeNull();
  expect(calendarBox).not.toBeNull();
  if (entryBox === null || calendarBox === null) return;
  expect(entryBox.width).toBeGreaterThan(calendarBox.width);
  // Beside it, not above or below: the calendar starts to the right of where the entry ends.
  expect(calendarBox.x).toBeGreaterThan(entryBox.x + entryBox.width - 1);

  // One journal, not one per click: pressing the button again reveals the page it opened.
  await window.locator('[data-testid="activity-journal"]').click();
  await expect(window.locator('.dv-tab', { hasText: 'Journal' })).toHaveCount(1);
});

test('[N10] every day since the project began is there, and opening one edits that day', async ({
  workspace,
}) => {
  // A project a fortnight old, with one day written at the start of it and nothing since.
  // The gap is what the criterion is about: those eleven days happened, and a calendar that
  // starts at the first entry can show them while one that starts at the first *entry it
  // knows about* would begin here and claim the project is a day old.
  const began = daysAgo(12);
  const middle = daysAgo(6);
  seedJournalEntry(workspace, began, 'Picked the question. Read two papers, understood one.');

  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await openJournal(window);
    const date = await today(window);

    // The far end of the range is on the calendar, and marked.
    await expect(window.locator(`[data-testid="journal-day-${began}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );

    // The days between are folded into one marker rather than dropped — it says how many it
    // stands for, and opening it shows them.
    const run = window.locator('[data-testid^="journal-run-"]');
    await expect(run).toHaveCount(1);
    await expect(run).toContainText('11 days');
    await run.click();

    // Every day from the beginning of the project to today, with nothing missing.
    for (let back = 12; back >= 0; back -= 1) {
      await expect(
        window.locator(`[data-testid="journal-day-${daysAgo(back)}"]`),
        `${daysAgo(back)} is not on the calendar`,
      ).toHaveCount(1);
    }

    // Opening a day edits *that* day. It starts empty — nothing was logged then — and what
    // is typed marks it, without touching today.
    const entry = window.locator('[data-testid="journal-entry-text"]');
    await window.locator(`[data-testid="journal-day-${middle}"]`).click();
    await expect(window.locator('[data-testid="journal-selected-date"]')).toContainText(middle);
    await expect(entry).toHaveValue('');
    await entry.fill(ENTRY);
    await window.locator('[data-testid="journal-save"]').click();
    await expect(window.locator(`[data-testid="journal-day-${middle}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );

    await window.locator(`[data-testid="journal-day-${date}"]`).click();
    await expect(entry).toHaveValue('');
    await expect(window.locator(`[data-testid="journal-day-${date}"]`)).toHaveAttribute(
      'data-logged',
      'false',
    );

    // And back: the day kept what was written on it, rather than the page keeping one entry
    // and re-dating it.
    await window.locator(`[data-testid="journal-day-${middle}"]`).click();
    await expect(entry).toHaveValue(ENTRY);
    await expect(window.locator(`[data-testid="journal-day-${began}"]`)).toHaveAttribute(
      'data-logged',
      'true',
    );
  } finally {
    await launched.app.close();
  }
});
