/**
 * Navigating typed links, against a real Electron process.
 *
 * The edges walked here are the ones the workspace fixture seeded through the repositories —
 * a note with two `document://` chips and the matching rows in `links` — so every hop is a
 * real query against SQLite rendered by the real panels. Nothing is stubbed, and no test-only
 * command is invoked: the specs press the keys the keybinding registry actually binds.
 */
import { openDatabase } from '@wr/database';
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';
import type { E2EWorkspace } from './support/workspace.js';

/** Every edge the database holds between two entities, read straight out of SQLite. */
function edgesBetween(
  workspace: E2EWorkspace,
  sourceId: string,
  targetId: string,
): { type: string; origin: string }[] {
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    return db.sqlite
      .prepare(
        `SELECT type, origin FROM links WHERE source_id = ? AND target_id = ? ORDER BY created_at`,
      )
      .all(sourceId, targetId) as { type: string; origin: string }[];
  } finally {
    db.close();
  }
}

/** Open a document from the library sidebar and wait for its reader to appear. */
async function openDocument(window: Page, documentId: string): Promise<void> {
  const row = window.locator(`[data-testid="library-panel"] [data-testid="library-item-${documentId}"]`);
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
  await expect(window.locator('[data-testid="references-panel"]')).toBeVisible();
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
    // Four: the library the app opened on, the paper, the references that were walked to the
    // note, and the note. Every surface is a panel now (`U15`).
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('4 panels');

    const note = window.locator(`[data-testid="note-editor"][data-note-id="${workspace.noteId}"]`);
    const target = window.locator(`[data-testid="pdf-reader"][data-document-id="${second.id}"]`);

    // Nothing is under the pointer yet. F12 is bound `when: linkUnderCursor`, so the
    // keystroke is inert rather than reopening whatever was last selected — which is the
    // difference between "go to the target under the cursor" and "go somewhere".
    await window.keyboard.press('F12');
    await expect(target).toHaveCount(0);
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('4 panels');

    // The note mentions both documents, and the pointer picks which one. Hovering the second
    // chip — the document that is *not* already open — is what makes the assertion
    // discriminating: only the chip under the cursor can account for what opens.
    const chip = note.locator(`a[data-internal-link="document://${second.id}"]`);
    await expect(chip).toBeVisible();
    await expect(note.locator(`a[data-internal-link="document://${first.id}"]`)).toBeVisible();
    await chip.hover();
    await window.keyboard.press('F12');

    await expect(target).toBeVisible();
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('5 panels');
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

    const panel = window.locator('[data-testid="references-panel"]');
    await expect(panel).toBeHidden();

    // Shift+F12 on the open document: the one edge touching it is the note that mentions it.
    await window.keyboard.press('Shift+F12');
    await expect(panel).toBeVisible();

    const rows = window.locator('[data-testid="references-panel"] [data-testid^="reference-row-"]');
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
    await window
      .locator('.dv-tab[data-panel-id="references"] .dv-default-tab-action')
      .click();
    await expect(panel).toBeHidden();
  });
});

test.describe('making links and notes from the reader', () => {
  /**
   * Linking asks one question: what is the other end? (`K01`, re-promised as `H05`.)
   *
   * This test used to prove the opposite half of the same gesture — that the picker refused to
   * make a link until a relationship had been named, because a type nobody chose is decoration.
   * The researcher's verdict on using it was that they never once wanted to be asked: the kinds
   * all draw the same line, the ledger reads fine either way, and the toll was paid on every
   * connection they ever made. So the criterion moves rather than being weakened — the link is
   * still typed in the table, and what is gone is the interrogation. The assertions below are
   * the old ones inverted: Create is armed by the target alone, and the section that asked is
   * not on screen at all.
   */
  test('[K01] [H05] links the open document to another one, and never asks what kind of link it is', async ({
    window,
    workspace,
  }) => {
    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await openDocument(window, first.id);

    // Nothing links these two yet, in either direction.
    expect(edgesBetween(workspace, first.id, second.id)).toEqual([]);

    await window.locator('[data-testid="reader-link"]').click();
    const picker = window.locator('[data-testid="link-picker"]');
    await expect(picker).toBeVisible();
    // The picker knows which document the link comes from, and says so.
    await expect(window.locator('[data-testid="link-picker-source"]')).toContainText(first.title);
    // And it cannot offer the document to itself as the other end.
    await expect(window.locator(`[data-testid="link-picker-target-${first.id}"]`)).toHaveCount(0);

    const create = window.locator('[data-testid="link-picker-create"]');

    // Nothing is armed before an other end is chosen: the one question is still a question.
    await expect(create).toBeDisabled();

    // And with it chosen, that is the whole of it. No second section, no relationship to
    // name — the button is live the moment the picker knows what the link is to.
    await window.locator(`[data-testid="link-picker-target-${second.id}"]`).click();
    await expect(create).toBeEnabled();

    // The chooser is not merely pre-answered or tucked away — it is not on screen. A default
    // selection would be the same interrogation with a guess in it.
    await expect(window.locator('[data-testid="link-picker-types"]')).toHaveCount(0);
    await expect(picker).not.toContainText('What is the relationship?');

    await create.click();
    await expect(picker).toBeHidden();

    // One edge, from A to B, marked as the researcher's own rather than something an importer
    // derived — and *typed*, quietly, which is the half of `K01` that survives: the links table
    // keeps its typed directed edges and only the UI stopped asking.
    await expect
      .poll(() => edgesBetween(workspace, first.id, second.id), { timeout: 10_000 })
      .toEqual([{ type: 'related-to', origin: 'manual' }]);

    // And it is a link the app can find: the references panel for the document being read
    // now names the other paper, and says how the two are related.
    await window.keyboard.press('Shift+F12');
    const rows = window.locator('[data-testid="references-panel"] [data-testid^="reference-row-"]');
    const linked = rows.filter({ hasText: second.title });
    await expect(linked).toHaveCount(1);
    await expect(linked.first()).toContainText('related to');
  });

  test('[K02] makes a note from the highlight under the reader, linked to it', async ({
    window,
    workspace,
  }) => {
    const [first] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    if (first === undefined) return;

    await openDocument(window, first.id);
    await window.waitForSelector('[data-testid="pdf-page-0"][data-rendered="true"]', {
      timeout: 60_000,
    });

    // With nothing highlighted, the note the reader offers is a note on the document.
    const newNote = window.locator('[data-testid="reader-new-note"]');
    await expect(newNote).toHaveAttribute('data-note-source', 'document');

    // Select a passage and keep it, the way the reader's own criteria do it.
    await window.evaluate(() => {
      const spans = [...document.querySelectorAll('.wr-pdf-page__text-layer span')]
        .filter((span) => (span.textContent ?? '').trim().length > 3)
        .slice(0, 4);
      const range = document.createRange();
      range.setStart(spans[0]!.firstChild ?? spans[0]!, 0);
      const last = spans[spans.length - 1]!;
      range.setEnd(last.firstChild ?? last, (last.textContent ?? '').length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document
        .querySelector('[data-testid="pdf-scroll"]')!
        .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await window.locator('[data-testid="create-highlight"]').click();

    // The highlight is now what the reader is on, and the note offered changes to match:
    // "from here" means the passage, not the paper it happens to be in.
    await expect(newNote).toHaveAttribute('data-note-source', 'annotation', { timeout: 10_000 });

    await newNote.click();

    // The note opened beside the reader…
    const editor = window.locator('[data-testid="note-editor"]');
    await expect(editor).toBeVisible({ timeout: 15_000 });
    const noteId = await editor.getAttribute('data-note-id');
    expect(noteId).not.toBeNull();
    if (noteId === null) return;

    // …and it landed attached to the highlight it was made from, in the same action. A note
    // that opened with no edge would be a note nothing can reach from the passage.
    const { db } = openDatabase({ file: workspace.databasePath });
    try {
      const annotations = db.sqlite
        .prepare(`SELECT id FROM annotations WHERE document_id = ?`)
        .all(first.id) as { id: string }[];
      expect(annotations).toHaveLength(1);
      const annotationId = annotations[0]?.id;
      expect(annotationId).toBeDefined();
      if (annotationId === undefined) return;

      const edges = db.sqlite
        .prepare(`SELECT type, target_id AS targetId, origin FROM links WHERE source_id = ?`)
        .all(noteId) as { type: string; targetId: string; origin: string }[];
      expect(edges).toEqual([
        { type: 'note-references-annotation', targetId: annotationId, origin: 'manual' },
      ]);
    } finally {
      db.close();
    }

    // And the app can walk back: the highlight's references name the note. Two edges touch it
    // — the document it was made in, and the note just made from it — and the note's row says
    // which of the two it is rather than leaving the reader to infer it.
    await window.keyboard.press('Shift+F12');
    const rows = window.locator('[data-testid="references-panel"] [data-testid^="reference-row-"]');
    await expect(rows).toHaveCount(2);
    const noteRow = rows.filter({ hasText: 'Note on' });
    await expect(noteRow).toHaveCount(1);
    await expect(noteRow.first()).toContainText('references this');
    await expect(rows.filter({ hasText: first.title })).toContainText('highlighted in');
  });
});
