/**
 * The desk board behind a question (criteria N06, N07).
 *
 * `N06` is about a judgement surviving: where the researcher put a card is a claim about how
 * the material relates, and an app that re-flows the board on every open has thrown it away.
 * So the assertion is not "a card is on the board" but "this card is at these coordinates,
 * in a second process, having been dragged there in the first".
 *
 * The other half is what is *not* stored. A card nobody has moved has no position at all —
 * `data-placed` says so — because a default the layout happened to produce is not a decision,
 * and recording one would make it impossible ever to improve the default without moving cards
 * somebody thinks they placed. The spec asserts both halves in the same restart.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@wr/database';
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { dropFileOn } from './support/drop.js';
import type { Locator, Page } from '@playwright/test';

const QUESTION = 'Which papers actually show the copying circuit?';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_PDF = join(REPO_ROOT, 'tests', 'fixtures', 'sample-paper.pdf');

async function openQueue(window: Page): Promise<void> {
  const sidebar = window.locator('[data-testid="questions-sidebar"]');
  await expect(async () => {
    if (!(await sidebar.isVisible())) {
      await window.locator('[data-testid="activity-questions"]').click();
    }
    await expect(sidebar).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Add a question and open its page. Returns the question's id. */
async function openNewNotebook(window: Page, title: string): Promise<string> {
  await openQueue(window);
  await window.locator('[data-testid="queue-new-title"]').fill(title);
  await window.locator('[data-testid="queue-add"]').click();
  await expect(window.locator('[data-testid="queue-list"]')).toContainText(title);
  const id = await window
    .locator('[data-testid="queue-list"] > li')
    .last()
    .getAttribute('data-question-id');
  if (id === null) throw new Error('queue: the new question has no id');
  await window.locator(`[data-testid="queue-open-${id}"]`).click();
  await expect(window.locator('[data-testid="notebook-panel"]')).toBeVisible();
  return id;
}

async function openNotebook(window: Page, questionId: string): Promise<void> {
  await openQueue(window);
  await window.locator(`[data-testid="queue-open-${questionId}"]`).click();
  await expect(window.locator('[data-testid="notebook-panel"]')).toBeVisible();
}

const cardFor = (window: Page, entityId: string): Locator =>
  window.locator(`[data-testid="notebook-board"] [data-entity-id="${entityId}"]`);

/** Put a library document on the board, the way a hand does it. */
async function putOnBoard(window: Page, documentId: string): Promise<void> {
  await window.locator('[data-testid="board-pick"]').selectOption(documentId);
  await window.locator('[data-testid="board-add"]').click();
  await expect(cardFor(window, documentId)).toBeVisible();
}

/** Drag a card by `dx`/`dy` and wait for the placement to be acknowledged. */
async function dragCard(
  window: Page,
  card: Locator,
  dx: number,
  dy: number,
): Promise<{ x: number; y: number }> {
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (box === null) throw new Error('board: the card has no box to drag');
  const fromX = box.x + 24;
  const fromY = box.y + 12;

  await window.mouse.move(fromX, fromY);
  await window.mouse.down();
  // In steps, so the board sees a stream of moves rather than a teleport — the same shape a
  // hand produces, and the only one that exercises the live position at all.
  await window.mouse.move(fromX + dx, fromY + dy, { steps: 8 });
  await window.mouse.up();

  await expect(card).toHaveAttribute('data-placed', 'true');
  const x = await card.getAttribute('data-x');
  const y = await card.getAttribute('data-y');
  if (x === null || y === null) throw new Error('board: a placed card has no coordinates');
  return { x: Number(x), y: Number(y) };
}

/** Drop a real file on the board. The mechanism is `dropFileOn`; the target is the board. */
async function dropFile(window: Page, path: string): Promise<void> {
  await dropFileOn(window, '[data-testid="notebook-board"]', path);
}

/** Every path under `dir` whose name matches, so "was it copied?" is answerable. */
function findByName(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findByName(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

test('[N06] a question’s desk board holds hand-placed cards, and the arrangement survives restart', async ({
  workspace,
}) => {
  const [dragged, untouched] = workspace.pdfDocuments;
  if (dragged === undefined || untouched === undefined) {
    throw new Error('e2e: the fixture library needs two papers');
  }

  let questionId: string;
  let placed: { x: number; y: number };

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    questionId = await openNewNotebook(window, QUESTION);

    await expect(window.locator('[data-testid="notebook-board-empty"]')).toBeVisible();
    await putOnBoard(window, dragged.id);
    await putOnBoard(window, untouched.id);

    // A card that has only been *added* has no position: the board laid it out, nobody
    // placed it, and the difference is the point.
    await expect(cardFor(window, dragged.id)).toHaveAttribute('data-placed', 'false');
    await expect(cardFor(window, untouched.id)).toHaveAttribute('data-placed', 'false');

    placed = await dragCard(window, cardFor(window, dragged.id), 96, 84);
    // The drag moved it somewhere it was not: an implementation that committed the position
    // it already had would pass every other assertion here.
    expect(placed.x + placed.y).toBeGreaterThan(0);
  } finally {
    await first.app.close();
  }

  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, questionId);

    const moved = cardFor(window, dragged.id);
    await expect(moved).toBeVisible();
    await expect(moved).toHaveAttribute('data-placed', 'true');
    // The same coordinates, in a process that has never seen the drag.
    await expect(moved).toHaveAttribute('data-x', String(placed.x));
    await expect(moved).toHaveAttribute('data-y', String(placed.y));
    // And the card that was never dragged is still unplaced, rather than pinned to wherever
    // the first session's layout happened to put it.
    await expect(cardFor(window, untouched.id)).toHaveAttribute('data-placed', 'false');
    // The card names what it stands for, so a board is readable without opening anything.
    await expect(moved).toContainText(dragged.title);
  } finally {
    await second.app.close();
  }
});

test('[N07] a dropped file becomes a card on the board without leaving the researcher’s disk', async ({
  workspace,
  window,
}) => {
  // A paper sitting where the researcher keeps it: outside the Zotero directory, outside the
  // notes folder, outside every root this app was configured with.
  const inbox = join(workspace.dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const dropped = join(inbox, 'induction-heads.pdf');
  copyFileSync(FIXTURE_PDF, dropped);
  const before = statSync(dropped);

  await openNewNotebook(window, QUESTION);
  await expect(window.locator('[data-testid="notebook-board-empty"]')).toBeVisible();

  await dropFile(window, dropped);

  const card = window.locator('[data-testid="notebook-board"] article');
  await expect(card).toHaveCount(1);
  // Titled by the file, so a board of dropped papers is readable.
  await expect(card).toContainText('induction-heads');
  // And it arrived unplaced, like anything else nobody has dragged yet.
  await expect(card).toHaveAttribute('data-placed', 'false');

  // The file is still exactly where it was: same inode, same bytes, not moved and not
  // rewritten.
  const after = statSync(dropped);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  // …and nothing copied it anywhere else in the workspace. A notebook that quietly duplicated
  // gigabytes of PDFs into a store of its own would pass every assertion above this one.
  expect(findByName(workspace.dir, 'induction-heads.pdf')).toEqual([dropped]);
});

test('[N07] the dropped paper opens from the board, and still opens after a restart', async ({
  workspace,
}) => {
  const inbox = join(workspace.dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const dropped = join(inbox, 'copying-circuit.pdf');
  copyFileSync(FIXTURE_PDF, dropped);

  let questionId: string;

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    questionId = await openNewNotebook(window, QUESTION);
    await dropFile(window, dropped);
    const card = window.locator('[data-testid="notebook-board"] article');
    await expect(card).toHaveCount(1);

    // The bytes are served over `rrfile://` like every other document's, which they can only
    // be because the drop admitted this one path to the allow-list.
    await card.locator('button').first().click();
    await expect(window.locator('[data-testid="pdf-reader"]')).toBeVisible();
    await expect(window.locator('[data-testid="pdf-page-0"] canvas')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await first.app.close();
  }

  // The library row names the file where it lies. Read straight out of the database, because
  // this is the fact the criterion is about and the renderer is never allowed to see it.
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    const row = db.sqlite
      .prepare('SELECT path FROM document_files WHERE path = ?')
      .get(dropped) as { path: string } | undefined;
    expect(row?.path).toBe(dropped);
  } finally {
    db.close();
  }

  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, questionId);
    const card = window.locator('[data-testid="notebook-board"] article');
    await expect(card).toHaveCount(1);
    // An admission that were not remembered would leave this card opening as 403 Forbidden —
    // the stranded-corpus failure, arrived at from the other side.
    await card.locator('button').first().click();
    await expect(window.locator('[data-testid="pdf-page-0"] canvas')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await second.app.close();
  }
});

test('[N07] the renderer cannot name a file itself', async ({ workspace, window }) => {
  // The bridge is still exactly two functions. A third — anything that took a path, or handed
  // one over — is the whole hole this design exists to avoid.
  const exposed = await window.evaluate(() =>
    Object.keys(globalThis as unknown as Record<string, unknown>).includes('rr')
      ? Object.keys((globalThis as unknown as { rr: object }).rr).sort()
      : [],
  );
  expect(exposed).toEqual(['invoke', 'subscribe']);

  await openNewNotebook(window, QUESTION);

  // The drop channel is not addressable from the page: `invoke` names a channel in the
  // contract, and `wr:drop` is deliberately not in it. Without this, a compromised renderer
  // could name any file on the disk, have it added to the library, and read it back over
  // `rrfile://` — an arbitrary-file-read wearing a feature's clothes.
  const refused = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as {
      rr: { invoke: (channel: string, request: unknown) => Promise<{ ok: boolean }> };
    }).rr;
    return bridge.invoke('wr:drop', { questionId: 'qst_x', paths: ['/etc/hosts'] });
  });
  expect(refused.ok).toBe(false);

  await expect(window.locator('[data-testid="notebook-board"] article')).toHaveCount(0);

  // And nothing reached the library by that route.
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    const row = db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM document_files WHERE path = ?')
      .get('/etc/hosts') as { n: number };
    expect(row.n).toBe(0);
  } finally {
    db.close();
  }
});
