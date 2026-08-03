/**
 * Reading the corpus back out of the database the app is writing, and marking it up.
 *
 * Every id an assertion uses comes from here rather than from the DOM the app rendered: a view
 * checked against ids it produced itself is a view marking its own work. The connection is
 * read-only and `migrate: false`, so a second connection never touches a file the app owns.
 *
 * Shared by every spec that needs the markdown corpus — the graph, the wiki page, the focused
 * view and the ledger all start from the same two pages and the wikilink edge ingestion derives
 * between them — and by anything that has to get the library sidebar on screen first.
 */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openDatabase } from '@wr/database';

export interface CorpusRow {
  readonly id: string;
  readonly title: string;
  readonly slug: string | null;
}

export interface EdgeRow {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
}

export interface CorpusGraph {
  readonly documents: readonly CorpusRow[];
  readonly edges: readonly EdgeRow[];
}

export function readGraph(databasePath: string): CorpusGraph {
  const { db } = openDatabase({ file: databasePath, readonly: true, migrate: false });
  try {
    const documents = (
      db.sqlite
        .prepare(
          `SELECT id, title, slug FROM documents
            WHERE doc_type = 'markdown' AND deleted_at IS NULL
            ORDER BY slug`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row['id']),
      title: String(row['title']),
      slug: row['slug'] === null ? null : String(row['slug']),
    }));

    const edges = (
      db.sqlite
        .prepare(
          `SELECT id, type, source_id, target_id FROM links
            WHERE generator = 'wikilink' ORDER BY created_at, id`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row['id']),
      type: String(row['type']),
      sourceId: String(row['source_id']),
      targetId: String(row['target_id']),
    }));

    return { documents, edges };
  } finally {
    db.close();
  }
}

/**
 * The id of the markdown page the corpus import produces — the cheapest real reader to drive.
 *
 * Polled rather than read once: the corpus is imported by the application on launch, so its
 * rows do not exist until the process that is about to be driven has done the work. That is
 * also why it is not a fixture constant, and why every spec that wanted it had written the
 * same poll.
 */
export async function corpusPageId(workspace: {
  readonly databasePath: string;
  readonly corpusPage: { readonly slug: string };
}): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      () => {
        const { documents } = readGraph(workspace.databasePath);
        id = documents.find((row) => row.slug === workspace.corpusPage.slug)?.id;
        return id;
      },
      { timeout: 60_000, message: 'the corpus never produced its page' },
    )
    .toBeDefined();
  if (id === undefined) throw new Error('the corpus did not produce its page');
  return id;
}

/** Wait for the startup corpus scan to have derived the wikilink edge, then return the graph. */
export async function waitForWikilinkEdge(databasePath: string): Promise<CorpusGraph> {
  await expect
    .poll(() => readGraph(databasePath).edges.length, {
      timeout: 30_000,
      message: 'the corpus scan never derived a wikilink edge',
    })
    .toBeGreaterThan(0);
  return readGraph(databasePath);
}

/** Everything the library holds that the wiki page draws as a place: files and notes. */
export function placeCount(databasePath: string): number {
  const { db } = openDatabase({ file: databasePath, readonly: true, migrate: false });
  try {
    const row = db.sqlite
      .prepare(
        `SELECT (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL)
              + (SELECT COUNT(*) FROM notes     WHERE deleted_at IS NULL) AS n`,
      )
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** The highlights a document actually carries, in the order they were made. */
export function annotationIds(databasePath: string, documentId: string): readonly string[] {
  const { db } = openDatabase({ file: databasePath, readonly: true, migrate: false });
  try {
    return (
      db.sqlite
        .prepare(
          `SELECT id FROM annotations WHERE document_id = ? AND deleted_at IS NULL
            ORDER BY created_at, id`,
        )
        .all(documentId) as Record<string, unknown>[]
    ).map((row) => String(row['id']));
  } finally {
    db.close();
  }
}

export async function openLibrary(window: Page): Promise<void> {
  const sidebar = window.locator('[data-testid="library-panel"]');
  await expect(async () => {
    if (!(await sidebar.isVisible())) {
      await window.locator('[data-testid="activity-library"]').click();
    }
    await expect(sidebar).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

export async function openFromLibrary(window: Page, documentId: string): Promise<void> {
  await openLibrary(window);
  const row = window.locator(
    `[data-testid="library-panel"] [data-testid="library-item-${documentId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(
    window.locator(`[data-testid="markdown-reader"][data-document-id="${documentId}"]`),
  ).toBeVisible();
}

/**
 * Highlight one paragraph of an open markdown page, the way a reader would.
 *
 * The selection is a DOM Range over the rendered prose and the `mouseup` is dispatched on the
 * reader's own scroll element, so the application sees a genuine `window.getSelection()`.
 */
export async function highlight(
  window: Page,
  documentId: string,
  which = 0,
): Promise<string> {
  await openFromLibrary(window, documentId);
  const reader = `[data-testid="markdown-reader"][data-document-id="${documentId}"]`;
  await expect(window.locator(`${reader} [data-testid="markdown-body"] p`).first()).toBeVisible();

  const selected = await window.evaluate(
    ({ selector, index }) => {
      const view = document.querySelector(selector);
      const paragraphs = [...(view?.querySelectorAll('[data-testid="markdown-body"] p') ?? [])]
        .filter((element) => (element.textContent ?? '').trim().length > 12);
      const paragraph = paragraphs[Math.min(index, paragraphs.length - 1)];
      const scroll = view?.querySelector('[data-testid="markdown-scroll"]');
      if (paragraph === undefined || scroll === null || scroll === undefined) return '';
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      scroll.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      return selection?.toString() ?? '';
    },
    { selector: reader, index: which },
  );
  expect(selected.trim().length).toBeGreaterThan(12);

  const panel = window.locator(`.wr-reader-panel:has(${reader})`);
  await panel.locator('[data-testid="create-highlight"]').click();
  await expect(panel.locator('[data-testid="selection-toolbar"]')).toHaveCount(0);
  return selected;
}

/**
 * Commit, from a picker that is already showing a chosen target.
 *
 * One press since `H05`. This used to choose a relationship first, because the picker refused
 * to make a link until one was named; the researcher's verdict was that they never wanted to be
 * asked, so the button is armed by the target alone and every spec that links something got
 * shorter by a click. The target is chosen differently on every surface that opens the picker —
 * a row, a disc, a sentence — and that difference is what those specs are about.
 *
 * `stance` is the exception and the only one: a claim as the other end still asks which way the
 * evidence cuts, because a hypothesis is weighed rather than merely connected (`E02`).
 */
export async function commitLink(window: Page, stance?: string): Promise<void> {
  const picker = window.locator('[data-testid="link-picker"]');
  if (stance !== undefined) {
    await picker.locator(`[data-testid="link-picker-type-${stance}"]`).click();
  }
  const create = picker.locator('[data-testid="link-picker-create"]');
  await expect(create).toBeEnabled();
  await create.click();
  await expect(picker).toBeHidden();
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a surface drew something, in its own graph coordinates rather than in pixels. */
export async function drawnAt(target: {
  getAttribute(name: string): Promise<string | null>;
}): Promise<Box> {
  const read = async (name: string): Promise<number> =>
    Number((await target.getAttribute(`data-${name}`)) ?? Number.NaN);
  return {
    x: await read('x'),
    y: await read('y'),
    width: await read('width'),
    height: await read('height'),
  };
}

export const encloses = (box: Box, point: Box): boolean =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

/** How far a drawn point is from the centre of the 1000×700 scene the surfaces lay out in. */
export const awayFromCentre = (point: Box): number => Math.hypot(point.x - 500, point.y - 350);
