/**
 * The journal, driven the way it is used (criteria J01, J03).
 *
 * Both criteria are integration-level and are asserted over the router in
 * `tests/integration/journal.test.ts`. This spec exists because the panel itself is real code
 * that nothing else runs: a calendar that never marks a day, or a save that never fires, is
 * invisible to a test that calls the channel directly. So today's bubble is checked for the
 * fill that means "logged", the entry is read back in a second process, and clearing it puts
 * the day back to unlogged rather than leaving a blank entry behind.
 */
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import type { Page } from '@playwright/test';

const ENTRY = 'Ran the induction-head sweep. Layer 14 head 3 looks like a copier.';

/** The app's own notion of today, taken from the running renderer rather than from Node. */
async function today(window: Page): Promise<string> {
  return window.evaluate(() => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${String(now.getFullYear())}-${month}-${day}`;
  });
}

async function openJournal(window: Page): Promise<void> {
  const sidebar = window.locator('[data-testid="journal-sidebar"]');
  await expect(async () => {
    if (!(await sidebar.isVisible())) {
      await window.locator('[data-testid="activity-journal"]').click();
    }
    await expect(sidebar).toBeVisible({ timeout: 2_000 });
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
