/**
 * Setting a notebook aside, and throwing it away (criterion I01).
 *
 * Two acts on the same row that must never be confusable. **Discarding** is what happens to a
 * line of work that stopped being the thing to do: it keeps the reason — the useful residue of
 * having asked it — the notebook goes to the shelf at the bottom of the queue, and `Restore`
 * brings it back with everything it had. **Deleting** is the researcher saying they were wrong
 * to open it at all, and it is irreversible.
 *
 * So what this spec pins down is the *difference*. A discarded notebook keeps its journal, its
 * desk and its claims and gets them all back. A deleted one takes them with it — the journal
 * days, the claims, and every edge those or the notebook were an end of, which is what takes
 * the desk, because a card *is* one of those edges. What it never takes is the reading: the
 * paper on the desk and the highlight cited under the claim are the library, and they are still
 * there afterwards, with their own annotations intact.
 *
 * And deleting is only reachable from the discarded shelf, in both directions: the button is
 * offered nowhere else, and the main process refuses a notebook that has not been discarded.
 * A test that only drove the button would pass against a panel that hid a control the channel
 * would happily have executed from anywhere.
 */
import { openDatabase } from '@wr/database';
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { seedNotebook } from './support/workspace.js';
import type { E2EWorkspace } from './support/workspace.js';
import type { Page } from '@playwright/test';

const DROPPED = 'Does attention sparsity predict downstream transfer?';
const KEPT = 'Does spacing beat massing in a 12-layer model?';

interface Remains {
  readonly notebooks: number;
  readonly journalDays: number;
  readonly hypotheses: number;
  readonly links: number;
  readonly cardPositions: number;
}

/** What is left in the database that belonged to one notebook. */
function remains(workspace: E2EWorkspace, notebookId: string): Remains {
  const { db } = openDatabase({ file: workspace.databasePath, readonly: true, migrate: false });
  const count = (sql: string, params: unknown): number =>
    (db.sqlite.prepare(sql).get(params) as { n: number } | undefined)?.n ?? 0;
  try {
    return {
      notebooks: count('SELECT COUNT(*) AS n FROM questions WHERE id = @id', { id: notebookId }),
      journalDays: count('SELECT COUNT(*) AS n FROM journal_entries WHERE notebook_id = @id', {
        id: notebookId,
      }),
      hypotheses: count('SELECT COUNT(*) AS n FROM hypotheses WHERE question_id = @id', {
        id: notebookId,
      }),
      links: count(
        `SELECT COUNT(*) AS n FROM links
          WHERE (source_type = 'question' AND source_id = @id)
             OR (target_type = 'question' AND target_id = @id)
             OR (source_type = 'journal' AND source_id LIKE @prefix)
             OR (source_type = 'hypothesis'
                 AND source_id IN (SELECT id FROM hypotheses WHERE question_id = @id))
             OR (target_type = 'hypothesis'
                 AND target_id IN (SELECT id FROM hypotheses WHERE question_id = @id))`,
        { id: notebookId, prefix: `${notebookId}:%` },
      ),
      cardPositions: count(
        `SELECT COUNT(*) AS n FROM card_positions p
           JOIN links l ON l.id = p.link_id
          WHERE l.source_type = 'question' AND l.source_id = @id`,
        { id: notebookId },
      ),
    };
  } finally {
    db.close();
  }
}

/**
 * The library, which neither act may touch.
 *
 * Counted separately from the notebook's own rows and only ever compared against itself,
 * because the application imports its corpus on launch — a library count taken before the
 * first process started is not the same number as one taken after, for reasons that have
 * nothing to do with notebooks.
 */
function library(workspace: E2EWorkspace): { documents: number; annotations: number } {
  const { db } = openDatabase({ file: workspace.databasePath, readonly: true, migrate: false });
  const count = (sql: string): number =>
    (db.sqlite.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  try {
    return {
      documents: count('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL'),
      annotations: count('SELECT COUNT(*) AS n FROM annotations WHERE deleted_at IS NULL'),
    };
  } finally {
    db.close();
  }
}

/**
 * A notebook with everything a notebook accumulates: a day of journal, a claim, a card on the
 * desk that has been dragged somewhere, and a citation for the claim.
 *
 * Seeded rather than driven, because what is under test is what deletion *takes*, and building
 * four kinds of thing through the UI would make the spec a test of four other criteria.
 */
function seedWorkedNotebook(
  workspace: E2EWorkspace,
  title: string,
): { notebookId: string; documentId: string; annotationId: string } {
  const notebookId = seedNotebook(workspace, title, [
    { date: '2026-07-20', markdown: 'Ran the sweep. Nothing separates the two schedules yet.' },
  ]);
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    const document = db.documents.create({
      title: 'Spacing effects in deep networks',
      docType: 'pdf',
      source: 'zotero',
      authors: [],
    });
    const quote = 'Review spread across days beats review massed into one.';
    const annotation = db.annotations.create({
      documentId: document.id,
      kind: 'highlight',
      color: 'yellow',
      selectedText: quote,
      anchor: {
        kind: 'pdf',
        version: 1,
        pageIndex: 0,
        rects: [{ x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.24 }],
        quote: { exact: quote, prefix: '', suffix: '' },
        position: { start: 0, end: quote.length },
        pageTextHash: 'e2e-page-text-hash',
        contentHash: 'e2e-content-hash',
      },
    });
    // The desk: a card, dragged, so a position row exists to go with the edge.
    const card = db.links.create({
      type: 'question-references-document',
      sourceType: 'question',
      sourceId: notebookId,
      targetType: 'document',
      targetId: document.id,
      origin: 'manual',
    });
    db.board.place(card.id, { x: 120, y: 80 });
    // The claim, and the sentence that bears it out.
    const claim = db.hypotheses.create({
      questionId: notebookId,
      statement: 'Spacing wins because retrieval is harder.',
    });
    db.links.create({
      type: 'annotation-supports-hypothesis',
      sourceType: 'annotation',
      sourceId: annotation.id,
      targetType: 'hypothesis',
      targetId: claim.id,
      origin: 'manual',
    });
    return { notebookId, documentId: document.id, annotationId: annotation.id };
  } finally {
    db.close();
  }
}

/** Open the queue, whichever sidebar the restored workspace happened to leave showing. */
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

test('[I01] discarding sets a notebook aside and it comes back; deleting is confirmed, and gone', async ({
  workspace,
}) => {
  const dropped = seedWorkedNotebook(workspace, DROPPED);
  const kept = seedNotebook(workspace, KEPT);
  const before = remains(workspace, dropped.notebookId);
  const held: { library: { documents: number; annotations: number } } = {
    library: { documents: 0, annotations: 0 },
  };
  expect(before).toMatchObject({ notebooks: 1, journalDays: 1, hypotheses: 1, cardPositions: 1 });
  expect(before.links).toBe(2);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openQueue(window);

    // --- discarding, which keeps everything ---------------------------------
    // The reason is not optional, and the button says so by staying disabled: a line of work
    // dropped for no recorded reason is the one you start again in six months.
    await window.locator(`[data-testid="queue-discard-${dropped.notebookId}"]`).click();
    const confirmDiscard = window.locator(
      `[data-testid="queue-discard-confirm-${dropped.notebookId}"]`,
    );
    await expect(confirmDiscard).toBeDisabled();
    await window
      .locator(`[data-testid="queue-discard-reason-${dropped.notebookId}"]`)
      .fill('The sparsity measure turned out to be a proxy for depth.');
    await confirmDiscard.click();

    // Set aside: off the working list, onto the shelf, with the reason showing.
    await expect(window.locator('[data-testid="queue-discarded-list"]')).toContainText(DROPPED);
    await expect(
      window.locator(`[data-testid="queue-reason-${dropped.notebookId}"]`),
    ).toContainText('proxy for depth');
    await expect(window.locator('[data-testid="queue-list"]')).not.toContainText(DROPPED);

    // And nothing was destroyed by setting it aside — this is the half of the criterion that
    // says discard is not a weaker delete.
    expect(remains(workspace, dropped.notebookId)).toEqual(before);

    // --- and it comes back --------------------------------------------------
    await window.locator(`[data-testid="queue-restore-${dropped.notebookId}"]`).click();
    await expect(window.locator('[data-testid="queue-list"]')).toContainText(DROPPED);
    expect(remains(workspace, dropped.notebookId)).toEqual(before);

    // --- deleting is a different act ----------------------------------------
    // Not offered on a working notebook: the destructive control is not one click from the
    // reversible one on the same row.
    await expect(
      window.locator(`[data-testid="queue-delete-${dropped.notebookId}"]`),
    ).toHaveCount(0);

    // Nor is it only hidden. Asked over the application's own bridge — the one door the
    // renderer has — the channel refuses too, so no other surface, menu or future caller can
    // reach past the panel and take a notebook that was never set aside.
    const refused = await window.evaluate(async (questionId) => {
      const bridge = (window as unknown as {
        rr: {
          invoke(
            channel: string,
            request: unknown,
          ): Promise<{ ok: boolean; error?: { message: string } }>;
        };
      }).rr;
      const result = await bridge.invoke('question:delete', { questionId });
      return result.ok
        ? 'the channel deleted a notebook that was never discarded'
        : (result.error?.message ?? 'refused without saying why');
    }, dropped.notebookId);
    expect(refused).toContain('discarded before it is deleted');
    expect(remains(workspace, dropped.notebookId).notebooks).toBe(1);

    // Set it aside again, and now the shelf offers both things that can happen to it.
    await window.locator(`[data-testid="queue-discard-${dropped.notebookId}"]`).click();
    await window
      .locator(`[data-testid="queue-discard-reason-${dropped.notebookId}"]`)
      .fill('Still a proxy for depth.');
    await window.locator(`[data-testid="queue-discard-confirm-${dropped.notebookId}"]`).click();
    await expect(window.locator(`[data-testid="queue-restore-${dropped.notebookId}"]`)).toBeVisible();

    // Confirmed, and the confirmation says what goes and what stays — "are you sure?" asks a
    // question nobody can answer without that.
    await window.locator(`[data-testid="queue-delete-${dropped.notebookId}"]`).click();
    const form = window.locator(`[data-testid="queue-delete-form-${dropped.notebookId}"]`);
    await expect(form).toContainText('journal');
    await expect(form).toContainText('desk');
    await expect(form).toContainText('stay in the library');

    // Backing out leaves it exactly as it was: a confirmation that destroys on cancel is not
    // a confirmation.
    await window.locator(`[data-testid="queue-delete-cancel-${dropped.notebookId}"]`).click();
    await expect(form).toHaveCount(0);
    expect(remains(workspace, dropped.notebookId).notebooks).toBe(1);

    // Now mean it. The library is counted here rather than before the app started, because
    // the corpus arrives with the first launch.
    held.library = library(workspace);
    await window.locator(`[data-testid="queue-delete-${dropped.notebookId}"]`).click();
    await window.locator(`[data-testid="queue-delete-confirm-${dropped.notebookId}"]`).click();

    await expect(window.locator(`[data-testid="queue-item-${dropped.notebookId}"]`)).toHaveCount(0);
    // Reported in what was lost, at the one moment the numbers can still be useful.
    await expect(window.locator('[data-testid="status-message"]')).toContainText(
      '1 day of journal',
    );
  } finally {
    await first.app.close();
  }

  // Gone, and everything that was only ever about it went too: the notebook row, its day of
  // journal, its claim, both edges — and the desk, because a card *is* one of those edges and
  // its position hangs off the edge rather than off a table of its own.
  const after = remains(workspace, dropped.notebookId);
  expect(after).toMatchObject({
    notebooks: 0,
    journalDays: 0,
    hypotheses: 0,
    links: 0,
    cardPositions: 0,
  });

  // And the reading is untouched. Deleting a line of work must never delete the papers it was
  // done on, or the sentences marked in them.
  expect(library(workspace)).toEqual(held.library);

  // It does not come back, and the notebook beside it never noticed.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openQueue(window);
    await expect(window.locator('[data-testid="queue-list"]')).toContainText(KEPT);
    await expect(window.locator('[data-testid="questions-sidebar"]')).not.toContainText(DROPPED);
    expect(remains(workspace, dropped.notebookId).notebooks).toBe(0);
    expect(remains(workspace, kept).notebooks).toBe(1);

    // The shelf of notebooks agrees, which is the other list a deleted row could have
    // survived in.
    await window.locator('[data-testid="activity-notebooks"]').click();
    const directory = window.locator('[data-testid="notebook-directory"]');
    await expect(directory).toBeVisible();
    await expect(directory).toContainText(KEPT);
    await expect(directory).not.toContainText(DROPPED);
  } finally {
    await second.app.close();
  }
});
