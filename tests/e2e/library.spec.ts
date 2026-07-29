/**
 * A library you curate (criterion B02).
 *
 * Zotero is one source of documents, not the definition of the library. A paper that arrived
 * by email, a preprint downloaded this morning, a PDF a colleague handed over on a stick —
 * none of them are in anybody's Zotero, and a reader that can only show what Zotero already
 * holds sends the researcher back out to a second application to file something before they
 * are allowed to read it.
 *
 * The assertion is not "a row appeared". It is that the file was added **where it lies**: the
 * bytes are still the researcher's, at the path they chose, and the application reads them
 * from there rather than taking a copy into a store of its own. So the spec checks the
 * library row against the original path, checks the workspace holds no second copy, and then
 * opens the paper — which can only work if adding the file admitted that one path to the
 * allow-list and remembered it.
 *
 * The way in is the drop, because that is the way that can be driven end to end on a machine
 * nobody is sitting at. The other way in — the file dialog — is refused in background mode by
 * design (a modal an unattended run cannot answer would wedge the process on somebody else's
 * desktop), so what is asserted here is that the control exists and is reachable; the sequence
 * behind it is covered against a real filesystem in `tests/integration/library-curation.test.ts`.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@wr/database';
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { dropFileOn } from './support/drop.js';
import { startZoteroApi } from './support/zotero-api.js';
import type { E2EWorkspace } from './support/workspace.js';
import type { Page } from '@playwright/test';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_PDF = join(REPO_ROOT, 'tests', 'fixtures', 'sample-paper.pdf');

async function openLibrary(window: Page): Promise<void> {
  const sidebar = window.locator('[data-testid="library-sidebar"]');
  await expect(async () => {
    if (!(await sidebar.isVisible())) {
      await window.locator('[data-testid="activity-library"]').click();
    }
    await expect(sidebar).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Drop a real file on the library. The mechanism is `dropFileOn`; the target is the hint. */
async function dropOnLibrary(window: Page, path: string): Promise<void> {
  await dropFileOn(window, '[data-testid="library-drop-hint"]', path);
}

interface FiledDocument {
  readonly id: string;
  readonly title: string;
  /** A collection the document is filed in — the shelf an import names to get it back. */
  readonly collection: string;
}

/**
 * An imported document that is filed somewhere, and where.
 *
 * Read from the database before Electron owns it, because the collection a document belongs
 * to is not on screen: the sidebar lists papers, and the picker lists collections, and the
 * spec has to know which row in one goes with which row in the other. The fixtures include an
 * item filed in nothing at all, so this is a search rather than "the first one".
 */
function pickFiledDocument(workspace: E2EWorkspace): FiledDocument {
  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    for (const item of db.library.list({ source: 'zotero', limit: 200 }).items) {
      const collectionId = db.collections.collectionIdsForDocument(item.document.id)[0];
      const collection = collectionId === undefined ? null : db.collections.getById(collectionId);
      if (collection === null) continue;
      return { id: item.document.id, title: item.document.title, collection: collection.name };
    }
    throw new Error('e2e: the fixture library has no document filed in a collection');
  } finally {
    db.close();
  }
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

test('[B02] a file on disk is added to the library without going through Zotero', async ({
  workspace,
}) => {
  const inbox = join(workspace.dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const paper = join(inbox, 'a-mathematical-framework.pdf');
  copyFileSync(FIXTURE_PDF, paper);
  const before = statSync(paper);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openLibrary(window);

    // The other way in is present and reachable, even though a background run may not open a
    // modal: a feature nothing points at is a feature nobody has.
    await expect(window.locator('[data-testid="library-add-files"]')).toBeVisible();
    await expect(window.locator('[data-testid="library-add-files"]')).toBeEnabled();

    await dropOnLibrary(window, paper);

    const list = window.locator('[data-testid="library-local-list"]');
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(list).toContainText('a-mathematical-framework');

    // Nothing about it went through Zotero: it is not in the imported list, and the Zotero
    // items that were imported are untouched.
    await expect(window.locator('[data-testid="library-zotero-list"]')).not.toContainText(
      'a-mathematical-framework',
    );

    // Reading it is the point of adding it. The bytes reach the page over `rrfile://`, which
    // they can only do because adding the file admitted that one path.
    await list.locator('button').first().click();
    await expect(window.locator('[data-testid="pdf-reader"]')).toBeVisible({ timeout: 30_000 });
    await expect(window.locator('[data-testid="pdf-page-0"] canvas')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await first.app.close();
  }

  // The file did not move and was not copied. Read straight out of the database, because the
  // path is the fact the criterion is about and the renderer is never allowed to see it.
  const after = statSync(paper);
  expect(after.ino).toBe(before.ino);
  expect(findByName(workspace.dir, 'a-mathematical-framework.pdf')).toEqual([paper]);

  const { db } = openDatabase({ file: workspace.databasePath });
  try {
    const row = db.sqlite
      .prepare(
        `SELECT f.path AS path, d.source AS source
           FROM document_files f JOIN documents d ON d.id = f.document_id
          WHERE f.path = ?`,
      )
      .get(paper) as { path: string; source: string } | undefined;
    expect(row?.path).toBe(paper);
    // 'local', not 'zotero': how a document arrived is recorded, and this one did not arrive
    // through an import.
    expect(row?.source).toBe('local');
  } finally {
    db.close();
  }

  // And it is still there — and still readable — in a second process, which is what proves
  // the admission was remembered rather than living in the first process's memory.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openLibrary(window);
    const list = window.locator('[data-testid="library-local-list"]');
    await expect(list).toContainText('a-mathematical-framework', { timeout: 30_000 });
    await list.locator('button').first().click();
    await expect(window.locator('[data-testid="pdf-page-0"] canvas')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await second.app.close();
  }
});

/**
 * The removal, from the interface (criterion B03).
 *
 * The integration suite owns what a removal does to the database — the highlights and the
 * edges it must not destroy — because that is a claim about the repositories. What only an
 * end-to-end run can say is that the researcher can reach the removal at all, and that the
 * application tells them what it did and did not take: a row that vanishes with no word about
 * the work on it reads as a deletion whatever the rows say.
 */
test('[B03] a removal is reachable, and says what it kept and how to undo it', async ({
  window,
}) => {
  await openLibrary(window);

  const rows = window.locator('[data-testid="library-zotero-list"] .wr-row');
  const countBefore = await rows.count();
  expect(countBefore).toBeGreaterThan(0);

  const title = (await rows.first().getAttribute('title')) ?? '';
  expect(title).not.toBe('');

  await window.locator('[data-testid="library-zotero-list"] button:has-text("Remove")').first().click();

  await expect(rows).toHaveCount(countBefore - 1, { timeout: 30_000 });
  await expect(window.locator('[data-testid="library-zotero-list"]')).not.toContainText(title);

  // "Not now", said in the interface: the way back is naming the collection again, and a
  // researcher who is not told that has been given a delete button.
  await expect(window.locator('[data-testid="status-bar"]')).toContainText(
    'import its collection again to bring it back',
    { timeout: 30_000 },
  );

  // And no list of removed things to curate: the shelf it came from is the list.
  await expect(window.locator('[data-testid="library-removed-list"]')).toHaveCount(0);
});

/**
 * One collection, one action, and the round trip (criteria B05, B01).
 *
 * `C01` covers picking collections as a *scope* — a standing decision about what future
 * imports cover. This is the other gesture: import this one, now. It is what makes a removal
 * safe to make, because a removal means "not now" and the way back is the shelf the paper came
 * from — so the two are asserted on one path, which is also the only honest way to assert
 * either: remove something, name its collection, and find it back where it was.
 *
 * The app talks to a fixture Zotero API over a real loopback socket (`startZoteroApi`),
 * because everything between the button and the importer is what this criterion is about.
 */
test('[B05] a Zotero collection is imported from the library in one action', async ({
  workspace,
}) => {
  // Worked out from the database before launch: the renderer never sees a collection id, and
  // the row is found by the name the researcher reads.
  const filed = pickFiledDocument(workspace);

  const zotero = await startZoteroApi(workspace.zoteroChildren);
  const launched = await launchApp(workspace, { WR_ZOTERO_ENDPOINT: zotero.endpoint });
  try {
    const window = launched.window;
    await openLibrary(window);

    const row = window.locator(`[data-testid="library-item-${filed.id}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await window.locator(`[data-testid="library-remove-${filed.id}"]`).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });

    // One action: open the picker, press Import on the collection that holds it.
    await window.locator('[data-testid="zotero-scope-toggle"]').click();
    const option = window.locator(
      `[data-testid="zotero-scope-option"][data-collection="${filed.collection}"]`,
    );
    await expect(option).toBeVisible({ timeout: 30_000 });
    await option.locator('[data-testid="zotero-scope-import"]').click();

    // Back in the library, under the same id — the same document, not a copy of it.
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(window.locator('[data-testid="status-bar"]')).toContainText(
      `Imported from “${filed.collection}”`,
      { timeout: 30_000 },
    );

    // Importing one collection is not a *choice* about future imports: the remembered scope,
    // which is what the summary line reports, is exactly where it was.
    await expect(window.locator('[data-testid="zotero-scope-summary"]')).toHaveText(
      'Importing the whole library',
    );
  } finally {
    await launched.app.close();
    await zotero.close();
  }
});
