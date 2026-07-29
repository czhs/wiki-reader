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

/**
 * Drop a real file on the library.
 *
 * The `File` has to come from the operating system, because the mechanism under test is
 * `webUtils.getPathForFile` in the preload — a `File` built in JavaScript has no path and must
 * not acquire one. A file input is how Playwright hands the browser a real one.
 */
async function dropOnLibrary(window: Page, path: string): Promise<void> {
  await window.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'e2e-library-drop-source';
    input.style.display = 'none';
    document.body.append(input);
  });
  await window.setInputFiles('#e2e-library-drop-source', path);

  const transfer = await window.evaluateHandle(() => {
    const input = document.querySelector('#e2e-library-drop-source');
    const data = new DataTransfer();
    if (input instanceof HTMLInputElement && input.files !== null) {
      for (const file of Array.from(input.files)) data.items.add(file);
    }
    return data;
  });
  await window.locator('[data-testid="library-drop-hint"]').dispatchEvent('drop', {
    dataTransfer: transfer,
  });
  await window.evaluate(() => {
    document.querySelector('#e2e-library-drop-source')?.remove();
  });
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
 * The removal, from the interface (criteria B01, B03).
 *
 * The integration suite owns the hard part — that a re-import does not resurrect what was
 * removed — because that is a claim about the importer. What only an end-to-end run can say
 * is that the researcher can reach it at all, and that what they made on the document is
 * still there afterwards rather than quietly gone.
 */
test('[B03] a document is removed from the interface and can be put back', async ({ window }) => {
  await openLibrary(window);

  const rows = window.locator('[data-testid="library-zotero-list"] .wr-row');
  const countBefore = await rows.count();
  expect(countBefore).toBeGreaterThan(0);

  const title = (await rows.first().getAttribute('title')) ?? '';
  expect(title).not.toBe('');

  await window.locator('[data-testid="library-zotero-list"] button:has-text("Remove")').first().click();

  await expect(rows).toHaveCount(countBefore - 1, { timeout: 30_000 });
  const removedList = window.locator('[data-testid="library-removed-list"]');
  await expect(removedList).toBeVisible({ timeout: 30_000 });
  await expect(removedList).toContainText(title);

  await removedList.locator('button:has-text("Put back")').first().click();

  await expect(rows).toHaveCount(countBefore, { timeout: 30_000 });
  await expect(window.locator('[data-testid="library-zotero-list"]')).toContainText(title);
});
