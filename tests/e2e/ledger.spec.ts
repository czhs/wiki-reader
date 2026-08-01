/**
 * The two link surfaces milestone 5 adds, against a real Electron process.
 *
 * `H03` is a file's ledger: the account of everything this paper is connected to, including
 * the connections that hang off the sentences marked in it — which is the half the references
 * panel structurally could not show, because it answers about one entity and a reader thinks
 * about one paper. And the ledger is where linking starts, because it is where you notice
 * what is missing.
 *
 * `H04` is the other end being *found by looking*. Nothing new is drawn for it: the map from
 * `F01` and the focused view from `F02` are the picker's second tab, with a click meaning
 * "link to this" instead of "open this". The criterion names both kinds of node, so both are
 * picked here — the file in the middle, and one of the sentences around it.
 *
 * Every assertion about what was written reads the database the app wrote, not the panel that
 * claims to have written it.
 */
import { openDatabase } from '@wr/database';
import {
  COMMAND_IDS,
  DEFAULT_KEYBINDINGS,
  parseKeystroke,
  type Keystroke,
} from '@wr/workbench';
import { test, expect, launchApp, type LaunchedApp } from './support/app.js';
import type { Page } from '@playwright/test';
import type { E2EWorkspace } from './support/workspace.js';
import { annotationIds, highlight, readGraph } from './support/corpus.js';

/** Every edge out of one entity, read straight out of SQLite. */
function edgesFrom(
  workspace: E2EWorkspace,
  sourceId: string,
): { type: string; targetType: string; targetId: string; origin: string }[] {
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    return (
      db.sqlite
        .prepare(
          `SELECT type, target_type, target_id, origin FROM links
            WHERE source_id = ? ORDER BY created_at, id`,
        )
        .all(sourceId) as Record<string, unknown>[]
    ).map((row) => ({
      type: String(row['type']),
      targetType: String(row['target_type']),
      targetId: String(row['target_id']),
      origin: String(row['origin']),
    }));
  } finally {
    db.close();
  }
}

/** Open a PDF from the library sidebar and wait for its first page to have rendered. */
async function openPaper(window: Page, documentId: string): Promise<void> {
  const row = window.locator(
    `[data-testid="library-sidebar"] [data-testid="library-item-${documentId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(
    window.locator(`[data-testid="pdf-reader"][data-document-id="${documentId}"]`),
  ).toBeVisible();
  await window.waitForSelector('[data-testid="pdf-page-0"][data-rendered="true"]', {
    timeout: 60_000,
  });
}

/** Mark a passage of the open PDF, the way `M11` and `K02` do it. */
async function markAPassage(window: Page): Promise<void> {
  await window.evaluate(() => {
    const spans = [...document.querySelectorAll('.wr-pdf-page__text-layer span')]
      .filter((span) => (span.textContent ?? '').trim().length > 3)
      .slice(0, 4);
    const range = document.createRange();
    const first = spans[0];
    const last = spans[spans.length - 1];
    if (first === undefined || last === undefined) throw new Error('no text layer to select');
    range.setStart(first.firstChild ?? first, 0);
    range.setEnd(last.firstChild ?? last, (last.textContent ?? '').length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document
      .querySelector('[data-testid="pdf-scroll"]')
      ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await window.locator('[data-testid="create-highlight"]').click();
  await expect(window.locator('[data-testid="selection-toolbar"]')).toHaveCount(0);
}

/** Choose a relationship and commit, from a picker that is already showing a chosen target. */
async function commitLink(window: Page, linkType: string): Promise<void> {
  const picker = window.locator('[data-testid="link-picker"]');
  await picker.locator(`[data-testid="link-picker-type-${linkType}"]`).click();
  const create = picker.locator('[data-testid="link-picker-create"]');
  await expect(create).toBeEnabled();
  await create.click();
  await expect(picker).toBeHidden();
}

test.describe('a file’s ledger', () => {
  test('[H03] gathers the links on a file and on its highlights, and links the file itself', async ({
    workspace,
  }) => {
    const [paper, other] = workspace.pdfDocuments;
    if (paper === undefined || other === undefined) {
      throw new Error('e2e: the fixture library needs two papers');
    }

    const app: LaunchedApp = await launchApp(workspace);
    try {
      const window = app.window;
      await openPaper(window, paper.id);
      await markAPassage(window);
      const [annotationId] = annotationIds(workspace.databasePath, paper.id);
      expect(annotationId).toBeDefined();
      if (annotationId === undefined) return;

      // With the new highlight selected the reader's link gesture is about the *sentence*,
      // which is what `H02` widened and what puts an entry under the highlight below.
      const link = window.locator('[data-testid="reader-link"]');
      await expect(link).toHaveAttribute('data-link-source', 'annotation');
      await link.click();
      await window.locator(`[data-testid="link-picker-target-${other.id}"]`).click();
      await commitLink(window, 'annotation-references-document');

      // The ledger, opened from the reader.
      await window.locator('[data-testid="reader-ledger"]').click();
      const ledger = window.locator('[data-testid="ledger-panel"]');
      await expect(ledger).toBeVisible();
      await expect(ledger).toHaveAttribute('data-document-id', paper.id);

      // The new edge is filed under the highlight it hangs off rather than under the paper —
      // which is the distinction a references panel structurally cannot make.
      const underHighlight = ledger.locator(
        `[data-testid="ledger-on-highlight-${annotationId}"]`,
      );
      await expect(underHighlight).toBeVisible();
      await expect(underHighlight).toContainText(other.title);
      await expect(underHighlight).toContainText('bears on');

      // Exactly one row under it, so the containment edge every highlight is born with — it
      // is in the table, and the assertions at the end of this test read it there — is not
      // being listed back as a connection to the file whose ledger this is.
      await expect(underHighlight.locator('[data-testid^="ledger-row-"]')).toHaveCount(1);

      // What the file's own account held before anything was linked from this page.
      const onFileBefore = Number(await ledger.getAttribute('data-on-file'));

      // The file itself is linkable from here: the page that shows what a paper is already
      // connected to is where you notice what it should be connected to.
      await ledger.locator('[data-testid="ledger-link-file"]').click();
      const picker = window.locator('[data-testid="link-picker"]');
      await expect(picker).toBeVisible();
      await expect(window.locator('[data-testid="link-picker-source"]')).toContainText(
        paper.title,
      );
      await window.locator(`[data-testid="link-picker-target-${other.id}"]`).click();
      await commitLink(window, 'related-to');

      // Both accounts now, side by side and still distinguished: one edge on the paper, one
      // on the sentence, each under its own heading.
      await expect(ledger).toHaveAttribute('data-on-file', String(onFileBefore + 1));
      await expect(ledger.locator('[data-testid="ledger-on-file"]')).toContainText(other.title);
      await expect(ledger.locator('[data-testid="ledger-on-file"]')).toContainText('related to');
      await expect(underHighlight).toBeVisible();

      // And the rows are the database's, not the panel's.
      expect(edgesFrom(workspace, paper.id)).toContainEqual({
        type: 'related-to',
        targetType: 'document',
        targetId: other.id,
        origin: 'manual',
      });
      expect(edgesFrom(workspace, annotationId)).toEqual([
        {
          type: 'annotation-belongs-to-document',
          targetType: 'document',
          targetId: paper.id,
          origin: 'derived',
        },
        {
          type: 'annotation-references-document',
          targetType: 'document',
          targetId: other.id,
          origin: 'manual',
        },
      ]);
    } finally {
      await app.app.close();
    }
  });
});

/** The chord the running app resolves for a command, spelled the way Playwright presses one. */
function pressable(commandId: string): string {
  const rule = DEFAULT_KEYBINDINGS.find((candidate) => candidate.commandId === commandId);
  if (rule === undefined) throw new Error(`no default keybinding for ${commandId}`);
  const keystroke: Keystroke = parseKeystroke(
    process.platform === 'darwin' ? (rule.mac ?? rule.key) : rule.key,
  );
  const parts: string[] = [];
  if (keystroke.ctrl) parts.push('Control');
  if (keystroke.alt) parts.push('Alt');
  if (keystroke.shift) parts.push('Shift');
  if (keystroke.meta) parts.push('Meta');
  parts.push(keystroke.key);
  return parts.join('+');
}

/**
 * The file in front is the file the page commands are about.
 *
 * `getActiveEntity` pairs the selected highlight with the selected *file*, and those are two
 * independently written fields: the file was only re-pointed when the newly active tab was a
 * `pdf-reader`. So marking a sentence in a markdown page, opening a paper, and clicking back to
 * the page left the pair straddling two files — and the ledger chord, the focused view and the
 * link picker all take it at face value. The paper's ledger opens over the page you are reading.
 */
test('[H03] opens the ledger of the tab in front, whatever kind of reader it is', async ({
  workspace,
}) => {
  const paper = workspace.pdfDocuments[0];
  if (paper === undefined) throw new Error('e2e: the fixture library needs a paper');

  const app: LaunchedApp = await launchApp(workspace);
  try {
    const window = app.window;
    const { documents } = readGraph(workspace.databasePath);
    const page = documents.find((row) => row.slug === workspace.corpusPage.slug);
    if (page === undefined) throw new Error('the corpus did not produce its page');

    // A sentence marked in the markdown page: the highlight is now the selection, and the file
    // it belongs to is the page.
    await highlight(window, page.id);

    // The paper on top of it, so what was last recorded as "the file" is the PDF.
    await openPaper(window, paper.id);

    // Back to the page by clicking its tab — how a reader changes what they are reading, and
    // the one route that went through nothing but Dockview.
    await window.locator('.dv-tab', { hasText: page.title }).click();
    await expect(
      window.locator(`[data-testid="markdown-reader"][data-document-id="${page.id}"]`),
    ).toBeVisible();

    await window.keyboard.press(pressable(COMMAND_IDS.openLedger));
    const ledger = window.locator('[data-testid="ledger-panel"]');
    await expect(ledger).toBeVisible();
    await expect(ledger).toHaveAttribute('data-document-id', page.id);
  } finally {
    await app.app.close();
  }
});

test.describe('picking a link target from the graph', () => {
  test('[H04] picks the other end from the graph — a file node, and one of its annotations', async ({
    workspace,
  }) => {
    const [paper, other] = workspace.pdfDocuments;
    if (paper === undefined || other === undefined) {
      throw new Error('e2e: the fixture library needs two papers');
    }

    const app: LaunchedApp = await launchApp(workspace);
    try {
      const window = app.window;

      // A sentence marked in the *other* paper, so the graph has an annotation node to offer.
      await openPaper(window, other.id);
      await markAPassage(window);
      const [targetAnnotationId] = annotationIds(workspace.databasePath, other.id);
      expect(targetAnnotationId).toBeDefined();
      if (targetAnnotationId === undefined) return;

      const picker = window.locator('[data-testid="link-picker"]');

      /** Open the picker on `paper`, switch to the graph, and bring `other` into the middle. */
      const graphOnOther = async (): Promise<void> => {
        await openPaper(window, paper.id);
        const link = window.locator('[data-testid="reader-link"]');
        await expect(link).toHaveAttribute('data-link-source', 'document');
        await link.click();
        await expect(picker).toBeVisible();

        await picker.locator('[data-testid="link-picker-tab-graph"]').click();
        // It opens on the file being linked from — the paper you are reading — so the way to
        // anywhere else is the map, exactly as the wiki page is the way into the library.
        await expect(picker.locator('[data-testid="focus-panel"]')).toHaveAttribute(
          'data-focus-id',
          paper.id,
        );
        await picker.locator('[data-testid="link-picker-graph-back"]').click();
        await picker.locator(`[data-testid="wiki-node-${other.id}"]`).click();
        await expect(picker.locator('[data-testid="focus-panel"]')).toHaveAttribute(
          'data-focus-id',
          other.id,
        );
      };

      // --- a file node ---
      await graphOnOther();
      const fileNode = picker.locator(`[data-testid="focus-node-${other.id}"]`);
      // The node says what clicking it will do, and here it is neither "open" nor "refocus".
      await expect(fileNode).toHaveAttribute('data-action', 'pick');
      await fileNode.click();
      await expect(picker.locator('[data-testid="link-picker-chosen"]')).toContainText(
        other.title,
      );
      await commitLink(window, 'related-to');

      // --- one of its annotations ---
      await graphOnOther();
      const highlightNode = picker.locator(`[data-testid="focus-node-${targetAnnotationId}"]`);
      await expect(highlightNode).toHaveAttribute('data-action', 'pick');
      await expect(highlightNode).toHaveAttribute('data-entity-type', 'annotation');
      await highlightNode.click();
      await expect(picker.locator('[data-testid="link-picker-chosen"]')).toContainText(
        'highlight',
      );
      await commitLink(window, 'related-to');

      // Two edges out of the paper, aimed at two different kinds of thing — and the second
      // one is a sentence, which is the half of the criterion a file-only picker cannot do.
      expect(edgesFrom(workspace, paper.id)).toEqual([
        { type: 'related-to', targetType: 'document', targetId: other.id, origin: 'manual' },
        {
          type: 'related-to',
          targetType: 'annotation',
          targetId: targetAnnotationId,
          origin: 'manual',
        },
      ]);
    } finally {
      await app.app.close();
    }
  });
});
