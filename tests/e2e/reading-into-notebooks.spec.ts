/**
 * Reading flows into a notebook (criteria E01, E02).
 *
 * Both of these are about the same rule the milestone puts above everything else: whatever the
 * librarian can do with links, the researcher can do by hand. Two typed edges existed in the
 * vocabulary and had no gesture anywhere in the app that could make one —
 * `question-references-…`, which is what a notebook collecting a paper *is*, and
 * `…-supports-hypothesis`,
 * which is what the two lines under a claim are drawn from. So the science could only collect
 * where an agent put it.
 *
 * What is asserted here is therefore not "a button exists" but that the gesture starts where
 * reading happens, takes a highlight as readily as a file, and ends as a row in `links` that
 * every other surface already reads. Every check on what was written reads the database the
 * app wrote, not the panel that claims to have written it.
 */
import { openDatabase } from '@wr/database';
import { test, expect, launchApp, type LaunchedApp } from './support/app.js';
import { corpusPageId, openFromLibrary, highlight } from './support/corpus.js';
import { seedNotebook } from './support/workspace.js';
import type { E2EWorkspace } from './support/workspace.js';
import type { Page } from '@playwright/test';

const NOTEBOOK = 'Does spacing beat massing in a 12-layer model?';

/** Every edge into an entity, straight out of SQLite. */
function edgesInto(
  workspace: E2EWorkspace,
  targetId: string,
): { type: string; sourceType: string; sourceId: string; origin: string }[] {
  const { db } = openDatabase({ file: workspace.databasePath, readonly: true, migrate: false });
  try {
    return (
      db.sqlite
        .prepare(
          `SELECT type, source_type, source_id, origin FROM links
            WHERE target_id = ? ORDER BY created_at, id`,
        )
        .all(targetId) as Record<string, unknown>[]
    ).map((row) => ({
      type: String(row['type']),
      sourceType: String(row['source_type']),
      sourceId: String(row['source_id']),
      origin: String(row['origin']),
    }));
  } finally {
    db.close();
  }
}

/** What the one highlight of a file says, read back from the database that stored it. */
function markedText(workspace: E2EWorkspace, documentId: string): string {
  const { db } = openDatabase({ file: workspace.databasePath, readonly: true, migrate: false });
  try {
    const row = db.sqlite
      .prepare('SELECT selected_text FROM annotations WHERE document_id = ? LIMIT 1')
      .get(documentId) as { selected_text: string } | undefined;
    if (row === undefined) throw new Error('nothing was marked in that file');
    return row.selected_text.trim();
  } finally {
    db.close();
  }
}

/** A claim on a notebook's page, put there before the app starts. */
function seedClaim(workspace: E2EWorkspace, questionId: string, statement: string): string {
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    return db.hypotheses.create({ questionId, statement }).id;
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

test('[E01] sends a file, and a highlight, from the reader into a notebook’s page', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);

  const first: LaunchedApp = await launchApp(workspace);
  // Outside the block below because the second half of this test needs it, and the corpus is
  // imported by the application — so it cannot be known until one has been started.
  const pageId = await corpusPageId(workspace).catch(async (failure: unknown) => {
    await first.app.close();
    throw failure;
  });
  try {
    const window = first.window;
    await openFromLibrary(window, pageId);

    // Beside link and note, in the strip, not behind a menu: the three things a reader can
    // make from what it is showing, in one row.
    const actions = window.locator(`[data-testid="reader-actions-${pageId}"] button`);
    await expect(actions).toHaveCount(4);
    expect(
      await actions.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('data-testid')),
      ),
    ).toEqual(['reader-link', 'reader-ledger', 'reader-new-note', 'reader-send-to-notebook']);

    // With nothing marked, what is sent is the file.
    const send = window.locator('[data-testid="reader-send-to-notebook"]');
    await expect(send).toHaveAttribute('data-send-source', 'document');
    await send.click();

    const picker = window.locator('[data-testid="notebook-picker"]');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute('data-source-type', 'document');
    await picker.locator(`[data-testid="notebook-picker-target-${notebookId}"]`).click();
    await expect(picker).toHaveCount(0);
    // Said out loud. A gesture whose only evidence is on another page is a gesture nobody
    // trusts the second time.
    await expect(window.locator('[data-testid="status-message"]')).toContainText(NOTEBOOK);

    // Now mark a sentence, and send *that* — the same button, the same one click.
    await highlight(window, pageId);
    await expect(send).toHaveAttribute('data-send-source', 'annotation');
    await expect(send).toContainText('Send highlight');
    await send.click();
    await expect(picker).toHaveAttribute('data-source-type', 'annotation');
    await picker.locator(`[data-testid="notebook-picker-target-${notebookId}"]`).click();
    await expect(picker).toHaveCount(0);
  } finally {
    await first.app.close();
  }

  // Two ordinary typed edges out of the notebook — the same relationship a file dropped on
  // the page makes, so there is no second mechanism holding this up.
  const written = edgesInto(workspace, pageId).filter((edge) => edge.sourceType === 'question');
  expect(written).toEqual([
    {
      type: 'question-references-document',
      sourceType: 'question',
      sourceId: notebookId,
      origin: 'manual',
    },
  ]);

  // And both are *in the page* when the notebook is opened, after a restart (`P06`). The desk
  // they used to land on is retired: a send writes a block into the notebook's own markdown,
  // so what the researcher collected is in the document they are writing rather than on a
  // board beside it.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, notebookId);
    const page = window.locator('[data-testid="notebook-panel"]');
    await expect(window.locator('[data-testid="notebook-board"]')).toHaveCount(0);
    // The file by its name, the highlight by the sentence it marks.
    await expect(page).toContainText(workspace.corpusPage.title);
    await expect(page).toContainText(markedText(workspace, pageId).slice(0, 24));
    // Each carrying the link back to what it came from, which is what makes it a reference.
    await expect(page.locator('[data-scheme="document"]')).not.toHaveCount(0);
    await expect(page.locator('[data-scheme="annotation"]')).not.toHaveCount(0);
  } finally {
    await second.app.close();
  }
});

/**
 * The panel object identity, so a test can tell "it updated" from "it was rebuilt".
 *
 * An expando on the DOM node rather than an attribute: React would happily re-apply an
 * attribute to a fresh element, and a fresh element is exactly what a remount produces. If the
 * property is still there, this is the same mounted panel that was on screen before the link
 * was made — which is the whole difference between the workflow the criterion describes and
 * opening the notebook afterwards.
 */
async function stampNotebookPanel(window: Page): Promise<void> {
  await window.evaluate(() => {
    const panel = document.querySelector('[data-testid="notebook-panel"]');
    if (panel === null) throw new Error('no notebook panel to stamp');
    (panel as unknown as { __wrMountToken?: number }).__wrMountToken = Date.now();
  });
}

async function notebookPanelIsTheSameMount(window: Page): Promise<boolean> {
  return window.evaluate(() => {
    const panel = document.querySelector('[data-testid="notebook-panel"]');
    return (
      panel !== null && (panel as unknown as { __wrMountToken?: number }).__wrMountToken !== undefined
    );
  });
}

test('[E02] gives a claim evidence by hand, from the sentence that settles it', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  const claimId = seedClaim(workspace, notebookId, 'Spacing wins because retrieval is harder.');

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    const pageId = await corpusPageId(workspace);

    // The milestone's own layout: the notebook is open *before* the reading is done, because
    // that is the shape the researcher works in — a reader beside the page the claim is on.
    // Everything below therefore happens to a panel that is already mounted.
    await openNotebook(window, notebookId);
    await expect(window.locator(`[data-testid="notebook-supporting-${claimId}"] button`)).toHaveCount(
      0,
    );
    await stampNotebookPanel(window);

    // The sentence the researcher has just decided settles it. The highlight is the selection,
    // so the reader's link gesture is about the sentence rather than the paper (`H02`).
    await highlight(window, pageId);
    const link = window.locator('[data-testid="reader-link"]');
    await expect(link).toHaveAttribute('data-link-source', 'annotation');
    await link.click();

    const picker = window.locator('[data-testid="link-picker"]');
    await expect(picker).toBeVisible();

    // The claim is a target. This is the whole of what was missing: the vocabulary and both
    // reader lines existed, and a hypothesis has no row in `documents` or `notes`, so every
    // list of "the library" was structurally unable to offer one.
    await expect(picker.locator('[data-testid="link-picker-claims-heading"]')).toBeVisible();
    const claim = picker.locator(`[data-testid="link-picker-target-${claimId}"]`);
    await expect(claim).toContainText('Spacing wins because retrieval is harder.');
    // Which notebook claimed it, because two lines of work can claim about the same thing.
    await expect(claim).toContainText(NOTEBOOK);
    await claim.click();
    await expect(picker.locator('[data-testid="link-picker-chosen"]')).toContainText(
      'Spacing wins',
    );

    // And with a claim chosen, what can be said is which way the evidence cuts. Not "related
    // to": an untyped edge to a claim appears on neither of the two lines it is drawn under
    // and would count for nothing.
    const types = picker.locator('[data-testid="link-picker-types"] button');
    expect(
      await types.evaluateAll((buttons) => buttons.map((button) => button.textContent)),
    ).toEqual(['supports', 'opposes']);

    await picker.locator('[data-testid="link-picker-type-annotation-supports-hypothesis"]').click();
    const create = picker.locator('[data-testid="link-picker-create"]');
    await expect(create).toBeEnabled();
    await create.click();
    await expect(picker).toBeHidden();

    // The notebook page draws it under *For* — the line that until now only the librarian
    // could fill — on the page that was already open, without being asked again. `link:create`
    // used to publish `library:changed` alone, which this panel does not listen to, and its
    // reload kept `cards` out of the fresh answer and dropped `hypotheses` with the rest, so
    // the *For* line stayed empty until the panel was remounted.
    await openNotebook(window, notebookId);
    expect(
      await notebookPanelIsTheSameMount(window),
      'the notebook panel was remounted, so this proves nothing about an open page',
    ).toBe(true);
    const supporting = window.locator(`[data-testid="notebook-supporting-${claimId}"]`);
    await expect(supporting.locator('button')).toHaveCount(1);
    await expect(window.locator(`[data-testid="notebook-opposing-${claimId}"] button`)).toHaveCount(
      0,
    );

    // And the citation goes back to the sentence it was made from, which is what makes it a
    // citation rather than a tally.
    await supporting.locator('button').first().click();
    await expect(
      window.locator(`[data-testid="markdown-reader"][data-document-id="${pageId}"]`),
    ).toBeVisible();
  } finally {
    await first.app.close();
  }

  // One manual edge in the table, typed, pointed the way the notebook page reads it: from the
  // evidence to the claim.
  expect(edgesInto(workspace, claimId)).toEqual([
    {
      type: 'annotation-supports-hypothesis',
      sourceType: 'annotation',
      sourceId: expect.stringMatching(/^ann_/u),
      origin: 'manual',
    },
  ]);
});
