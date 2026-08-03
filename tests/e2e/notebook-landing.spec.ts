/**
 * What lands in a notebook, and where it lands (criteria N06, N07, P06).
 *
 * The desk board is retired. It was a second surface beside the page holding the same
 * `question-references-…` edges the page can hold itself, and the researcher's verdict was that
 * a notebook should be **one document**: what you collected belongs in what you are writing,
 * not on a pinboard under it.
 *
 * So `N06` and `N07` are re-promised here against the landing rather than the board. What each
 * one is about is unchanged:
 *
 * - `N06` — a thing put into a notebook **survives**, and survives as something the researcher
 *   can read without opening anything: a paper by its name, a highlight by the sentence it
 *   marks. The assertion is not "it appeared" but "it is still there, in a second process,
 *   naming what it stands for, and it goes back to what it came from".
 * - `N07` — a file dropped on the page joins the library **where it lies**. Same inode, same
 *   bytes, no copy anywhere in the workspace, and the reference the page carries is an id
 *   rather than a path, because a path is the one thing the renderer must never be handed.
 * - `P06` is the difference itself: the landing is prose in the document, it is editable, it
 *   does not double, and there is no board anywhere.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@wr/database';
import { launchApp, test, expect, showLibrary, type LaunchedApp } from './support/app.js';
import { openLibrary } from './support/corpus.js';
import { dropFileOn } from './support/drop.js';
import type { Locator, Page } from '@playwright/test';

const QUESTION = 'Which papers actually show the copying circuit?';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_PDF = join(REPO_ROOT, 'tests', 'fixtures', 'sample-paper.pdf');

async function openQueue(window: Page): Promise<void> {
  const sidebar = window.locator('[data-testid="queue-panel"]');
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

/** The blocks of the page, which is the only surface a notebook has now. */
const blocks = (window: Page): Locator =>
  window.locator('[data-testid^="notebook-block-"]:not([data-testid*="editor"])');

/**
 * Send a paper into a notebook, the way a hand does it: open it, press Send, pick the notebook.
 *
 * Deliberately the reader's own gesture rather than a channel call — the criterion is about
 * where reading *goes*, and the reader's strip is where the researcher starts.
 */
async function sendFromLibrary(
  window: Page,
  documentId: string,
  notebookId: string,
): Promise<void> {
  await openLibrary(window);
  await showLibrary(window);
  const row = window.locator(
    `[data-testid="library-panel"] [data-testid="library-item-${documentId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const send = window.locator(`[data-testid="reader-actions-${documentId}"]`).locator(
    '[data-testid="reader-send-to-notebook"]',
  );
  await expect(send).toBeVisible({ timeout: 30_000 });
  await send.click();
  const picker = window.locator('[data-testid="notebook-picker"]');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-testid="notebook-picker-target-${notebookId}"]`).click();
  await expect(picker).toHaveCount(0);
}

/** Drop a real file on the page. The mechanism is `dropFileOn`; the target is the blocks. */
async function dropFile(window: Page, path: string): Promise<void> {
  await dropFileOn(window, '[data-testid="notebook-blocks"]', path);
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

test('[N06] a paper put into a notebook is a block in its page, and survives restart', async ({
  workspace,
}) => {
  const [collected, second] = workspace.pdfDocuments;
  if (collected === undefined || second === undefined) {
    throw new Error('e2e: the fixture library needs two papers');
  }

  let questionId: string;

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    questionId = await openNewNotebook(window, QUESTION);

    // The page opens as its template and nothing else. There is no board to be empty.
    await expect(window.locator('[data-testid="notebook-board"]')).toHaveCount(0);
    const template = await blocks(window).count();

    await sendFromLibrary(window, collected.id, questionId);
    await openNotebook(window, questionId);
    await expect(blocks(window)).toHaveCount(template + 1);

    await sendFromLibrary(window, second.id, questionId);
    await openNotebook(window, questionId);
    await expect(blocks(window)).toHaveCount(template + 2);
  } finally {
    await first.app.close();
  }

  const restarted: LaunchedApp = await launchApp(workspace);
  try {
    const window = restarted.window;
    await openNotebook(window, questionId);

    // Both are still there, naming what they stand for, in a process that has never seen the
    // gesture that put them there. A block is markdown in the document, so this can only fail
    // if the document itself lost them.
    const page = window.locator('[data-testid="notebook-panel"]');
    await expect(page).toContainText(collected.title);
    await expect(page).toContainText(second.title);

    // And a block is a way back into the reading rather than a printed title: the link on it
    // is the internal-link chip every excerpt carries, and it opens the paper.
    const chip = window.locator(`[data-testid="internal-link-${collected.id}"]`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-scheme', 'document');
    await chip.click();
    await expect(window.locator('.dv-tab', { hasText: collected.title })).not.toHaveCount(0);
  } finally {
    await restarted.app.close();
  }
});

test('[P06] the desk is gone: what landed is editable prose, and it does not land twice', async ({
  workspace,
  window,
}) => {
  const [collected] = workspace.pdfDocuments;
  if (collected === undefined) throw new Error('e2e: the fixture library needs a paper');

  const questionId = await openNewNotebook(window, QUESTION);
  const template = await blocks(window).count();

  await sendFromLibrary(window, collected.id, questionId);
  await openNotebook(window, questionId);

  // Nothing that was the board is on the page any more — not the surface, not the cards, and
  // not the control that put things on it. By testid rather than by the word "desk", so a
  // board that had merely been renamed could not pass this.
  for (const gone of ['notebook-board', 'notebook-board-empty', 'board-pick', 'board-add']) {
    await expect(window.locator(`[data-testid="${gone}"]`)).toHaveCount(0);
  }
  await expect(window.locator('[data-testid^="board-card-"]')).toHaveCount(0);

  // What arrived is a block of the page, at the end of it, and it is editable prose: clicking
  // it opens a textarea holding the markdown that was written. That is the whole of "landed as
  // a formatted block" rather than "landed in a widget".
  const landed = blocks(window).nth(template);
  await expect(landed).toHaveAttribute('data-block-type', 'text');
  await expect(landed).toContainText(collected.title);
  // Opened with the keyboard rather than with a click: the block *is* one citation chip, edge
  // to edge, and a click anywhere on it is a click on the chip — which navigates, because that
  // is what the chip is for. `Enter` on the focused block is the other way in, and it is the
  // one that asks the question this criterion is asking.
  await landed.focus();
  await landed.press('Enter');
  const editor = window.locator('[data-testid^="notebook-block-editor-"]');
  await expect(editor).toBeVisible();
  const source = await editor.inputValue();
  expect(source).toContain(`#link("document://${collected.id}")`);
  // Addressed by id, never by path: there is nothing in this world that could build one.
  expect(source).not.toContain(workspace.dir);
  await editor.blur();

  // Sending the same paper again does not write it in twice. A notebook that grew a duplicate
  // whenever somebody re-sent a paper would be worse than one that never showed it.
  await sendFromLibrary(window, collected.id, questionId);
  await openNotebook(window, questionId);
  await expect(blocks(window)).toHaveCount(template + 1);
});

test('[N07] a dropped file becomes a block without leaving the researcher’s disk', async ({
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
  const template = await blocks(window).count();

  await dropFile(window, dropped);

  // Titled by the file, so a page of dropped papers is readable.
  const landed = blocks(window).nth(template);
  await expect(landed).toContainText('induction-heads', { timeout: 30_000 });
  await expect(landed).toHaveAttribute('data-block-type', 'text');

  // The file is still exactly where it was: same inode, same bytes, not moved and not
  // rewritten.
  const after = statSync(dropped);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  // …and nothing copied it anywhere else in the workspace. A notebook that quietly duplicated
  // gigabytes of PDFs into a store of its own would pass every assertion above this one.
  expect(findByName(workspace.dir, 'induction-heads.pdf')).toEqual([dropped]);
  // Nothing on the page says where it is, either.
  const markup = await window
    .locator('[data-testid="notebook-panel"]')
    .evaluate((element) => element.outerHTML);
  expect(markup).not.toContain(workspace.dir);
});

test('[N07] the dropped paper opens from the page, and still opens after a restart', async ({
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
    const link = window.locator('[data-testid^="internal-link-"]').first();
    await expect(link).toBeVisible({ timeout: 30_000 });

    // The bytes are served over `rrfile://` like every other document's, which they can only
    // be because the drop admitted this one path to the allow-list.
    await link.click();
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
    const link = window.locator('[data-testid^="internal-link-"]').first();
    await expect(link).toBeVisible();
    // An admission that were not remembered would leave this link opening as 403 Forbidden —
    // the stranded-corpus failure, arrived at from the other side.
    await link.click();
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

  const questionId = await openNewNotebook(window, QUESTION);
  const template = await blocks(window).count();

  // The drop channel is not addressable from the page: `invoke` names a channel in the
  // contract, and `wr:drop` is deliberately not in it. Without this, a compromised renderer
  // could name any file on the disk, have it added to the library, and read it back over
  // `rrfile://` — an arbitrary-file-read wearing a feature's clothes.
  const refused = await window.evaluate(async (notebookId: string) => {
    const bridge = (globalThis as unknown as {
      rr: { invoke: (channel: string, request: unknown) => Promise<{ ok: boolean }> };
    }).rr;
    return bridge.invoke('wr:drop', { notebookPage: notebookId, paths: ['/etc/hosts'] });
  }, questionId);
  expect(refused.ok).toBe(false);

  await expect(blocks(window)).toHaveCount(template);

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
