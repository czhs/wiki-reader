/**
 * Clicking a search result (criterion U10).
 *
 * The row has always been a button and has always called `navigate`, which is why nothing here
 * was ever reported as broken: it *looks* right, and for a paper it *is* right. What it did was
 * build one document reference for every hit and return early when there was no document — so
 * a note, which has no document by construction, was a row that highlighted under the pointer,
 * accepted the click, and did nothing. No panel, no message, nothing to distinguish a dead
 * control from a slow one.
 *
 * So this spec searches once and clicks three rows, because a search hit is not one kind of
 * thing. One query reaches all three: the passage in the file, the sentence marked in it, and
 * a note made from that sentence. Each has to arrive somewhere different — the file at the
 * passage, the file with the highlight *selected*, and the note itself — and "goes there" is
 * asserted on what appeared, never on the click having been accepted.
 */
import { openDatabase } from '@wr/database';
import { expect, test } from './support/app.js';
import { annotationIds, corpusPageId, highlight } from './support/corpus.js';
import type { Page } from '@playwright/test';

/**
 * The note the app just made, read back out of the database it wrote it to.
 *
 * Read rather than typed in, for the reason every other spec reads its ids: a row located by
 * an id the view produced itself proves only that the view is self-consistent.
 */
function newestNoteId(databasePath: string): string | null {
  const { db } = openDatabase({ file: databasePath, readonly: true, migrate: false });
  try {
    const row = db.sqlite
      .prepare('SELECT id FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1')
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

/** Open the search page and run one query, whatever else the workspace is showing. */
async function search(window: Page, query: string) {
  await window.locator('[data-testid="activity-search"]').click();
  const panel = window.locator('[data-testid="search-panel"]');
  await expect(panel).toBeVisible();
  await panel.locator('[data-testid="search-input"]').fill(query);
  await panel.locator('[data-testid="search-submit"]').click();
  await expect(panel.locator('[data-testid="search-results"] .wr-row').first()).toBeVisible();
  return panel;
}

test('[U10] a search result is clicked and goes there, whatever kind of thing it found', async ({
  window,
  workspace,
}) => {
  const pageId = await corpusPageId(workspace);

  // A marked sentence, and a note made from that sentence — so one query has a passage, a
  // highlight and a note under it, which is the whole point: they are three different arrivals.
  const quote = await highlight(window, pageId, 0);
  expect(quote).toContain('Recall');
  const [annotationId] = annotationIds(workspace.databasePath, pageId);
  expect(annotationId).toBeDefined();
  if (annotationId === undefined) return;

  await window
    .locator(`[data-testid="reader-actions-${pageId}"] [data-testid="reader-new-note"]`)
    .click();
  await expect(window.locator('[data-testid="note-editor"]')).toBeVisible();
  let noteId: string | null = null;
  await expect
    .poll(() => (noteId = newestNoteId(workspace.databasePath)), {
      message: 'the note the reader made never reached the database',
    })
    .not.toBeNull();
  if (noteId === null) return;

  // --- the passage --------------------------------------------------------
  // A chunk hit is the ordinary case and the one that already worked; it is here because the
  // fix has to leave it alone. It opens the file it was found in.
  let panel = await search(window, 'recall');
  const chunkRow = panel.locator('[data-testid^="search-result-chk_"]').first();
  await expect(chunkRow).toBeVisible();
  await expect(chunkRow).toHaveAttribute('title', 'Opens the file at this passage');
  await chunkRow.click();
  await expect(
    window.locator(`[data-testid="markdown-reader"][data-document-id="${pageId}"]`),
  ).toBeVisible();

  // --- the marked sentence ------------------------------------------------
  // Not "the page the highlight is on": arriving at a highlight means the highlight is the one
  // selected, which is what the ledger, the focused view and the link picker all read.
  panel = await search(window, 'recall');
  const annotationRow = panel.locator(`[data-testid="search-result-${annotationId}"]`);
  await expect(annotationRow).toHaveAttribute('title', 'Opens the file at this highlight');
  await annotationRow.click();
  await expect(
    window.locator(
      `[data-testid="markdown-reader"][data-document-id="${pageId}"] .wr-highlight--selected[data-annotation-id="${annotationId}"]`,
    ),
  ).toBeVisible();

  // --- the note -----------------------------------------------------------
  // The row that used to do nothing at all. A note has no document, which is exactly why the
  // old guard swallowed it.
  panel = await search(window, 'recall');
  const noteRow = panel.locator(`[data-testid="search-result-${noteId}"]`);
  await expect(noteRow).toHaveAttribute('title', 'Opens this note');
  await noteRow.click();
  await expect(
    window.locator(`[data-testid="note-editor"][data-note-id="${noteId}"]`),
  ).toBeVisible();
});
