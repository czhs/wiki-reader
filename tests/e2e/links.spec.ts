/**
 * Navigating typed links, against a real Electron process.
 *
 * The edges walked here are the ones the workspace fixture seeded through the repositories —
 * a note with two `document://` chips and the matching rows in `links` — so every hop is a
 * real query against SQLite rendered by the real panels. Nothing is stubbed, and no test-only
 * command is invoked: the specs press the keys the keybinding registry actually binds.
 */
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';

/** Open a document from the library sidebar and wait for its reader to appear. */
async function openDocument(window: Page, documentId: string): Promise<void> {
  const row = window.locator(`[data-testid="library-sidebar"] [data-testid="library-item-${documentId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${documentId}"]`);
  await expect(reader).toBeVisible();
  await expect(reader.locator('[data-testid="pdf-total-pages"]')).toHaveText(/^\d+ pages$/);
}

/**
 * Open the seeded note by walking to it from a document it mentions.
 *
 * There is no "open note" affordance in the milestone-1 shell, and there does not need to be:
 * finding the note that references what you are reading is the navigation the links exist
 * for, so the note is reached the way a reader would reach it.
 */
async function openSeededNote(window: Page, noteId: string): Promise<void> {
  await window.keyboard.press('Shift+F12');
  await expect(window.locator('[data-testid="bottom-panel"]')).toBeVisible();
  await window.locator('[data-testid="reference-row-0"]').click();
  await expect(window.locator(`[data-testid="note-editor"][data-note-id="${noteId}"]`)).toBeVisible();
}

test.describe('navigating links', () => {
  test('[L02] F12 opens the link under the cursor, and nothing when there is none', async ({
    window,
    workspace,
  }) => {
    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await openDocument(window, first.id);
    await openSeededNote(window, workspace.noteId);
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('2 panels');

    const note = window.locator(`[data-testid="note-editor"][data-note-id="${workspace.noteId}"]`);
    const target = window.locator(`[data-testid="pdf-reader"][data-document-id="${second.id}"]`);

    // Nothing is under the pointer yet. F12 is bound `when: linkUnderCursor`, so the
    // keystroke is inert rather than reopening whatever was last selected — which is the
    // difference between "go to the target under the cursor" and "go somewhere".
    await window.keyboard.press('F12');
    await expect(target).toHaveCount(0);
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('2 panels');

    // The note mentions both documents, and the pointer picks which one. Hovering the second
    // chip — the document that is *not* already open — is what makes the assertion
    // discriminating: only the chip under the cursor can account for what opens.
    const chip = note.locator(`a[data-internal-link="document://${second.id}"]`);
    await expect(chip).toBeVisible();
    await expect(note.locator(`a[data-internal-link="document://${first.id}"]`)).toBeVisible();
    await chip.hover();
    await window.keyboard.press('F12');

    await expect(target).toBeVisible();
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('3 panels');
    // Opened in place, not previewed: Alt+F12 is the peek, F12 is the navigation.
    await expect(window.locator('[data-testid="peek-overlay"]')).toHaveCount(0);
  });

  test('[L08] keeps the references panel open while its results are walked', async ({
    window,
    workspace,
  }) => {
    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await openDocument(window, first.id);

    const panel = window.locator('[data-testid="bottom-panel"]');
    await expect(panel).toBeHidden();

    // Shift+F12 on the open document: the one edge touching it is the note that mentions it.
    await window.keyboard.press('Shift+F12');
    await expect(panel).toBeVisible();

    const rows = window.locator('[data-testid="references-list"] [data-testid^="reference-row-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Reading list');

    // First hop: opening a result must leave the panel where it is.
    await rows.first().click();
    await expect(window.locator(`[data-testid="note-editor"][data-note-id="${workspace.noteId}"]`)).toBeVisible();
    await expect(panel).toBeVisible();

    // The note is now the active entity, and it references both documents. Walking the whole
    // result set is the criterion: the panel is a panel, not a modal that closes on use.
    await window.keyboard.press('Shift+F12');
    await expect(rows).toHaveCount(2);

    // Which row names which document is the panel's business, not this spec's: each hop is
    // checked against the title the row itself shows. Dockview mounts only the active tab of
    // a group, so asserting on both readers at the end would be asserting that navigation
    // *didn't* happen.
    // Only the two documents the note links are in play. The fixture library reuses a title
    // across other items, so a library-wide title map would be ambiguous.
    const byTitle = new Map(
      workspace.referencedDocumentIds.map((id) => [
        workspace.documents.find((item) => item.id === id)?.title ?? id,
        id,
      ]),
    );
    expect(byTitle.size, 'the two referenced documents must be tellable apart by title').toBe(2);

    const reached: string[] = [];
    for (const index of [0, 1]) {
      const row = window.locator(`[data-testid="reference-row-${String(index)}"]`);
      const title = ((await row.locator('.wr-row__primary').textContent()) ?? '').trim();
      const documentId = byTitle.get(title);
      expect(documentId, `reference row ${String(index)} named "${title}"`).toBeDefined();
      if (documentId === undefined) return;

      await row.click();
      // The document the row named is what opened…
      await expect(
        window.locator(`[data-testid="pdf-reader"][data-document-id="${documentId}"]`),
      ).toBeVisible();
      // …and the panel is still open, still showing the same result set. That is the criterion.
      await expect(panel).toBeVisible();
      await expect(rows).toHaveCount(2);
      reached.push(documentId);
    }

    // The walk covered both results, so the panel survived navigation rather than a no-op.
    expect([...reached].sort()).toEqual([first.id, second.id].sort());

    // And it closes when the user closes it: the panel stayed open because navigation leaves
    // it alone, not because nothing can close it.
    await window.locator('[data-testid="close-bottom-panel"]').click();
    await expect(panel).toBeHidden();
  });
});
