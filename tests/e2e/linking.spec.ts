/**
 * Making and unmaking links without ceremony, against a real Electron process.
 *
 * Milestone 7's verdict on linking was that the machinery was right and the asking was wrong.
 * `H05` took the kind chooser away (`links.spec.ts` carries that one, re-promised from `K01`);
 * the four here are the rest of the same thought:
 *
 * - `H06` — a file is not the only thing in a file. Choosing one in the picker opens it out
 *   into the sentences marked in it, searchable, and a file with none says so and stays the
 *   target rather than presenting an empty list as an error.
 * - `H07` — an edge is a row in `links`, and every surface that draws one can take it away.
 *   Three of them are driven here: the ledger, the references panel and a line on the map.
 * - `H08` — two papers open side by side, a marked sentence dragged from one onto the other.
 * - `H09` — two discs on the wiki, joined by dragging between them.
 *
 * The gestures are real pointer gestures at real coordinates, and every assertion about what
 * was written reads the database the app wrote rather than the panel that claims to have
 * written it.
 */
import { openDatabase } from '@wr/database';
import { test, expect } from './support/app.js';
import type { Locator, Page } from '@playwright/test';
import type { E2EWorkspace } from './support/workspace.js';
import { annotationIds, commitLink, corpusPageId, highlight } from './support/corpus.js';

interface EdgeRow {
  readonly id: string;
  readonly type: string;
  readonly targetId: string;
  readonly origin: string;
}

/** Every edge out of one entity, read straight out of SQLite. */
function edgesFrom(workspace: E2EWorkspace, sourceId: string): EdgeRow[] {
  const { db } = openDatabase({ file: workspace.databasePath, readonly: true, migrate: false });
  try {
    return (
      db.sqlite
        .prepare(
          `SELECT id, type, target_id, origin FROM links
            WHERE source_id = ? AND type <> 'annotation-belongs-to-document'
            ORDER BY created_at, id`,
        )
        .all(sourceId) as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row['id']),
      type: String(row['type']),
      targetId: String(row['target_id']),
      origin: String(row['origin']),
    }));
  } finally {
    db.close();
  }
}

/** Wait until the edges out of an entity are what the gesture should have made them. */
async function edgesSettle(
  workspace: E2EWorkspace,
  sourceId: string,
  shape: readonly { readonly type: string; readonly targetId: string }[],
): Promise<EdgeRow[]> {
  await expect
    .poll(
      () => edgesFrom(workspace, sourceId).map((edge) => ({ type: edge.type, targetId: edge.targetId })),
      { timeout: 15_000 },
    )
    .toEqual(shape);
  return edgesFrom(workspace, sourceId);
}

/** Open a PDF from the library sidebar, in this group or beside it. */
async function openPaper(
  window: Page,
  documentId: string,
  options: { readonly toSide?: boolean } = {},
): Promise<void> {
  const row = window.locator(
    `[data-testid="library-sidebar"] [data-testid="library-item-${documentId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click(options.toSide === true ? { modifiers: ['Meta'] } : {});
  await expect(
    window.locator(`[data-testid="pdf-reader"][data-document-id="${documentId}"]`),
  ).toBeVisible();
  await window.waitForSelector('[data-testid="pdf-page-0"][data-rendered="true"]', {
    timeout: 60_000,
  });
}

/** One reader's own chrome. There can be several on screen, so nothing here is global. */
const readerPanel = (window: Page, documentId: string): Locator =>
  window.locator(`.wr-reader-panel[data-document-id="${documentId}"]`);

/** Start the picker from the strip above one reader. */
async function startLinkFrom(window: Page, documentId: string): Promise<Locator> {
  await readerPanel(window, documentId).locator('[data-testid="reader-link"]').click();
  const picker = window.locator('[data-testid="link-picker"]');
  await expect(picker).toBeVisible();
  return picker;
}

/** Where the middle of something drawn is, in client pixels. */
async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('nothing was drawn to aim at');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A point on the *text* of an inline element, rather than in the middle of its box.
 *
 * A highlight over a paragraph that wraps is several line boxes with gaps between them, and
 * the middle of the union is very often one of the gaps — where the press lands on the
 * paragraph and not on the mark. This is the same distinction the archive frame's trap is
 * about: aim at what was painted, not at the average of it.
 */
async function centreOfText(target: Locator): Promise<{ x: number; y: number }> {
  const point = await target.evaluate((element) => {
    const rect = element.getClientRects()[0];
    return rect === undefined ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (point === null) throw new Error('nothing was painted to aim at');
  return point;
}

/**
 * Drag from one point to another the way a hand does: press, several moves, release.
 *
 * Several moves and not one, because both gestures under test only begin once the pointer has
 * travelled — a press that jumps straight to its destination is indistinguishable from a click
 * with a teleport in it, and would prove nothing about a drag.
 */
async function dragBetween(
  window: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  midway?: () => Promise<void>,
): Promise<void> {
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(from.x + (to.x - from.x) / 3, from.y + (to.y - from.y) / 3, { steps: 4 });
  await window.mouse.move(from.x + ((to.x - from.x) * 2) / 3, from.y + ((to.y - from.y) * 2) / 3, {
    steps: 4,
  });
  if (midway !== undefined) await midway();
  await window.mouse.move(to.x, to.y, { steps: 4 });
  await window.mouse.up();
}

test.describe('the picker opens a file out into what is marked in it', () => {
  test('[H06] searches the chosen file’s highlights, or says there are none and links the file', async ({
    window,
    workspace,
  }) => {
    const [paper, other] = workspace.pdfDocuments;
    if (paper === undefined || other === undefined) {
      throw new Error('e2e: the fixture library needs two papers');
    }
    const pageId = await corpusPageId(workspace);

    // Two sentences marked in the page, so the file being opened out has something in it.
    const firstQuote = await highlight(window, pageId, 0);
    const secondQuote = await highlight(window, pageId, 1);
    const [firstMark, secondMark] = annotationIds(workspace.databasePath, pageId);
    expect(firstMark).toBeDefined();
    expect(secondMark).toBeDefined();
    if (firstMark === undefined || secondMark === undefined) return;

    // --- a file with sentences marked in it ---
    await openPaper(window, paper.id);
    const picker = await startLinkFrom(window, paper.id);

    // Choosing the file in the list opens it out. The file is the target already — a
    // researcher who meant the paper is done — and the stage is what is *in* it.
    await picker.locator(`[data-testid="link-picker-target-${pageId}"]`).click();
    const stage = picker.locator('[data-testid="link-picker-marks"]');
    await expect(stage).toBeVisible();
    await expect(stage).toHaveAttribute('data-document-id', pageId);
    await expect(stage).toHaveAttribute('data-mark-count', '2');
    await expect(picker.locator('[data-testid="link-picker-create"]')).toBeEnabled();

    // Both sentences are on offer, as their own words rather than as ids.
    await expect(stage.locator(`[data-testid="link-picker-highlight-${firstMark}"]`)).toContainText(
      firstQuote.trim().slice(0, 24),
    );
    await expect(stage.locator(`[data-testid="link-picker-highlight-${secondMark}"]`)).toBeVisible();
    // And each says how much has already been said about it, which is the ledger's own signal.
    await expect(stage.locator(`[data-testid="link-picker-highlight-${firstMark}"]`)).toContainText(
      'nothing said yet',
    );

    // Searched, not scrolled: the words of the second sentence leave only the second.
    const needle = secondQuote.trim().split(/\s+/u).slice(0, 3).join(' ');
    expect(needle.length).toBeGreaterThan(6);
    await stage.locator('[data-testid="link-picker-mark-filter"]').fill(needle);
    await expect(stage.locator('[data-testid="link-picker-highlights"]')).toHaveAttribute(
      'data-shown',
      '1',
    );
    await expect(stage.locator(`[data-testid="link-picker-highlight-${firstMark}"]`)).toHaveCount(0);

    // Picking one aims the link at the sentence rather than at the paper it is in.
    await stage.locator(`[data-testid="link-picker-highlight-${secondMark}"]`).click();
    await expect(picker.locator('[data-testid="link-picker-chosen"]')).toContainText('highlight');
    await commitLink(window);

    const toSentence = await edgesSettle(workspace, paper.id, [
      { type: 'related-to', targetId: secondMark },
    ]);
    expect(toSentence[0]?.origin).toBe('manual');

    // --- a file with nothing marked in it ---
    const second = await startLinkFrom(window, paper.id);
    await second.locator(`[data-testid="link-picker-target-${other.id}"]`).click();
    const bare = second.locator('[data-testid="link-picker-marks"]');
    await expect(bare).toHaveAttribute('data-mark-count', '0');
    // Said in words, and the words say what happens instead — not an error, not a dead end.
    await expect(second.locator('[data-testid="link-picker-no-highlights"]')).toHaveText(
      'No sentences are marked in this file — linking the file itself.',
    );
    await expect(second.locator('[data-testid="link-picker-highlights"]')).toHaveCount(0);
    await expect(second.locator('[data-testid="link-picker-chosen"]')).toContainText(other.title);
    await commitLink(window);

    await edgesSettle(workspace, paper.id, [
      { type: 'related-to', targetId: secondMark },
      { type: 'related-to', targetId: other.id },
    ]);

    // And the way back out is there: the stage is a place, not a trap.
    const third = await startLinkFrom(window, paper.id);
    await third.locator(`[data-testid="link-picker-target-${pageId}"]`).click();
    await expect(third.locator('[data-testid="link-picker-marks"]')).toBeVisible();
    await third.locator('[data-testid="link-picker-back"]').click();
    await expect(third.locator('[data-testid="link-picker-marks"]')).toHaveCount(0);
    await expect(third.locator('[data-testid="link-picker-targets"]')).toBeVisible();
    await third.locator('[data-testid="link-picker-cancel"]').click();
  });
});

test.describe('a link is deleted wherever it is seen', () => {
  test('[H07] takes a link away from the ledger, from the references panel and from the map', async ({
    window,
    workspace,
  }) => {
    const [paper, other] = workspace.pdfDocuments;
    if (paper === undefined || other === undefined) {
      throw new Error('e2e: the fixture library needs two papers');
    }
    const pageId = await corpusPageId(workspace);

    await openPaper(window, paper.id);

    /** Link the paper to something, the way every surface does: through the picker. */
    const linkTo = async (targetId: string): Promise<void> => {
      const picker = await startLinkFrom(window, paper.id);
      await picker.locator(`[data-testid="link-picker-target-${targetId}"]`).click();
      await commitLink(window);
    };

    await linkTo(pageId);
    await linkTo(other.id);
    const [toPage, toOther] = await edgesSettle(workspace, paper.id, [
      { type: 'related-to', targetId: pageId },
      { type: 'related-to', targetId: other.id },
    ]);
    expect(toPage).toBeDefined();
    expect(toOther).toBeDefined();
    if (toPage === undefined || toOther === undefined) return;

    // --- from the ledger ---
    await readerPanel(window, paper.id).locator('[data-testid="reader-ledger"]').click();
    const ledger = window.locator('[data-testid="ledger-panel"]');
    await expect(ledger).toBeVisible();
    // Counted relative to what the ledger already held: the fixture's seeded note points at
    // this paper too, and an absolute number here would be asserting about the fixture.
    const held = Number(await ledger.getAttribute('data-entry-count'));
    expect(held).toBeGreaterThanOrEqual(2);
    await expect(ledger.locator(`[data-testid="ledger-row-${toPage.id}"]`)).toHaveCount(1);
    await ledger.locator(`[data-testid="ledger-unlink-${toPage.id}"]`).click();

    // The row is gone from the page that was already open — the channel announces, so nothing
    // had to be reopened — and the edge is gone from the table.
    await expect(ledger.locator(`[data-testid="ledger-row-${toPage.id}"]`)).toHaveCount(0);
    await expect(ledger).toHaveAttribute('data-entry-count', String(held - 1));
    await edgesSettle(workspace, paper.id, [{ type: 'related-to', targetId: other.id }]);

    // --- from the references panel ---
    await readerPanel(window, paper.id).click();
    await window.keyboard.press('Shift+F12');
    const references = window.locator('[data-testid="references-list"]');
    await expect(references).toBeVisible();
    const referenceRow = references.locator(`[data-testid="reference-unlink-${toOther.id}"]`);
    await expect(referenceRow).toBeVisible();
    await referenceRow.click();
    await edgesSettle(workspace, paper.id, []);
    // The ledger behind it lost the row too: one deletion, every surface.
    await expect(ledger.locator(`[data-testid="ledger-row-${toOther.id}"]`)).toHaveCount(0);
    await expect(ledger).toHaveAttribute('data-entry-count', String(held - 2));

    // --- from the line on the map ---
    await linkTo(other.id);
    const [drawn] = await edgesSettle(workspace, paper.id, [
      { type: 'related-to', targetId: other.id },
    ]);
    expect(drawn).toBeDefined();
    if (drawn === undefined) return;

    await window.locator('[data-testid="activity-wiki"]').click();
    const wiki = window.locator('[data-testid="wiki-panel"]');
    await expect(wiki).toBeVisible();
    const edge = wiki.locator(`[data-testid="wiki-edge-${drawn.id}"]`);
    await expect(edge).toHaveCount(1);
    await expect(edge).toHaveAttribute('data-chosen', 'false');

    // A line is 1.5px wide and nothing on this canvas could be pressed before now, so the
    // gesture is a press on the band beside it — at the middle of the line, which for a
    // straight segment is the middle of its own box.
    const band = wiki.locator(`[data-testid="wiki-edge-${drawn.id}-hit"]`);
    const at = await centreOf(band);
    await window.mouse.click(at.x, at.y);
    await expect(edge).toHaveAttribute('data-chosen', 'true');

    // Two presses, not one: a line crosses the map and a single click that deleted would be a
    // link lost to a misplaced pointer.
    const remove = wiki.locator(`[data-testid="wiki-edge-${drawn.id}-delete"]`);
    await expect(remove).toBeVisible();
    const on = await centreOf(remove);
    await window.mouse.click(on.x, on.y);

    await edgesSettle(workspace, paper.id, []);
    // The map redrew itself: the line is not merely unchosen, it is not there.
    await expect(wiki.locator(`[data-testid="wiki-edge-${drawn.id}"]`)).toHaveCount(0);
  });
});

test.describe('linking by dragging', () => {
  test('[H08] drags a marked sentence onto the paper open beside it', async ({
    window,
    workspace,
  }) => {
    const paper = workspace.pdfDocuments[0];
    if (paper === undefined) throw new Error('e2e: the fixture library needs a paper');
    const pageId = await corpusPageId(workspace);

    // A sentence marked in the page, and the paper opened *beside* it rather than over it:
    // "the reader beside it" is the whole shape of this gesture.
    await highlight(window, pageId, 0);
    const [markId] = annotationIds(workspace.databasePath, pageId);
    expect(markId).toBeDefined();
    if (markId === undefined) return;

    await openPaper(window, paper.id, { toSide: true });
    const page = readerPanel(window, pageId);
    const beside = readerPanel(window, paper.id);
    await expect(page).toBeVisible();
    await expect(beside).toBeVisible();
    expect(edgesFrom(workspace, markId)).toEqual([]);

    const mark = page.locator(`[data-testid="markdown-highlight-${markId}"]`).first();
    await expect(mark).toBeVisible();

    // Press the sentence, drag it across, let go on the other paper. Nothing is written until
    // the release, and the reader under the pointer says it will take it.
    await dragBetween(window, await centreOfText(mark), await centreOf(beside), async () => {
      await expect(beside).toHaveAttribute('data-taking-link', 'true');
      // …and the reader it came from does not offer to link a sentence to its own file.
      await expect(page).toHaveAttribute('data-taking-link', 'false');
    });

    // One edge, from the sentence to the paper it was dropped on, the researcher's own.
    const made = await edgesSettle(workspace, markId, [
      { type: 'related-to', targetId: paper.id },
    ]);
    expect(made[0]?.origin).toBe('manual');
    // The gesture ended: nothing is left in flight.
    await expect(beside).toHaveAttribute('data-taking-link', 'false');

    // And a drag that ends back on the paper the sentence was marked in writes nothing — the
    // containment edge already says everything that gesture could mean.
    await dragBetween(window, await centreOfText(mark), await centreOf(page));
    await expect
      .poll(() => edgesFrom(workspace, markId).length, { timeout: 5_000 })
      .toBe(1);
  });

  test('[H09] draws a link between two discs on the wiki', async ({ window, workspace }) => {
    const [paper, other] = workspace.pdfDocuments;
    if (paper === undefined || other === undefined) {
      throw new Error('e2e: the fixture library needs two papers');
    }

    await window.locator('[data-testid="activity-wiki"]').click();
    const wiki = window.locator('[data-testid="wiki-panel"]');
    await expect(wiki).toBeVisible();
    const canvas = wiki.locator('[data-testid="wiki-canvas"]');
    await expect(canvas).toHaveAttribute('data-linking', 'false');

    const from = wiki.locator(`[data-testid="wiki-node-${paper.id}"] .wr-graph__disc`);
    const to = wiki.locator(`[data-testid="wiki-node-${other.id}"] .wr-graph__disc`);
    await expect(from).toBeVisible();
    await expect(to).toBeVisible();
    expect(edgesFrom(workspace, paper.id)).toEqual([]);

    // Press one disc, drag to the other. A line follows the pointer while it travels, and it
    // knows which disc it is over — which is what makes this a gesture rather than a guess.
    await dragBetween(window, await centreOf(from), await centreOf(to), async () => {
      await expect(canvas).toHaveAttribute('data-linking', 'true');
      const rubber = wiki.locator('[data-testid="wiki-link-drag"]');
      await expect(rubber).toHaveCount(1);
      await expect(rubber).toHaveAttribute('data-from', `document ${paper.id}`);
    });

    // The edge is the researcher's own, and is the plain one — the same edge the picker
    // makes, because the drag runs the same command (`H05`).
    const made = await edgesSettle(workspace, paper.id, [
      { type: 'related-to', targetId: other.id },
    ]);
    expect(made[0]?.origin).toBe('manual');

    // The map has the line on it, drawn between the two discs that were joined, and the
    // gesture has ended.
    await expect(wiki.locator(`[data-testid="wiki-edge-${made[0]?.id ?? ''}"]`)).toHaveCount(1);
    await expect(canvas).toHaveAttribute('data-linking', 'false');
    await expect(wiki.locator('[data-testid="wiki-link-drag"]')).toHaveCount(0);

    // A press that goes nowhere is still a click: dragging is an addition to the node, not a
    // replacement for what it did.
    const at = await centreOf(from);
    await window.mouse.click(at.x, at.y);
    await expect(
      window.locator(`[data-testid="pdf-reader"][data-document-id="${paper.id}"]`),
    ).toBeVisible();
    expect(edgesFrom(workspace, paper.id)).toHaveLength(1);
  });
});
