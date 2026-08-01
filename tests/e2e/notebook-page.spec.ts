/**
 * The notebook writes the paper (criteria S01, S02, S03).
 *
 * The researcher's decision behind this milestone: the journal's days are tweets to oneself,
 * and the notebook is where a full publishable scientific paper has to be writable — LaTeX,
 * linking, code blocks, markdown, images. So what is asserted here is not "there is an editor"
 * but that the six things a paper is made of survive being written, saved and reopened, on the
 * page named after the work.
 *
 * Three deliberate choices these specs pin down, because each of them could have gone the
 * other way and would be invisible in a screenshot:
 *
 * - the page is the *same* block editor the journal's day is, storing the *same* markdown, so
 *   nothing here is a second way of writing (`S01`);
 * - maths renders from a vendored KaTeX in MathML, so there is `<math>` in the document and no
 *   network request anywhere (`S02`);
 * - an excerpt is markdown — a blockquote and an `annotation://` link — so it is still there
 *   for search and for a text editor, and it is a control that goes back to the sentence
 *   (`S03`).
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { openDatabase } from '@wr/database';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { seedNotebook } from './support/workspace.js';
import { seedHighlight } from './support/librarian.js';
import { dropFileOn } from './support/drop.js';
import type { E2EWorkspace } from './support/workspace.js';
import type { Page } from '@playwright/test';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_IMAGE = join(REPO_ROOT, 'tests', 'fixtures', 'node-icon.png');

const NOTEBOOK = 'Does spacing beat massing in a 12-layer model?';

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

/** Add a block and type into it, then click away — which is what commits. */
async function addBlock(window: Page, kind: 'text' | 'code', source: string): Promise<void> {
  await window.locator(`[data-testid="notebook-add-${kind}"]`).click();
  const editor = window.locator('[data-testid^="notebook-block-editor-"]');
  await editor.fill(source);
  await editor.blur();
}

const block = (window: Page, index: number) =>
  window.locator(`[data-testid="notebook-block-${String(index)}"]`);

/** Every `question-references-…` edge out of a notebook, straight out of SQLite. */
function referencesFromNotebook(
  workspace: E2EWorkspace,
  notebookId: string,
): { type: string; targetId: string }[] {
  const { db } = openDatabase({ file: workspace.databasePath, readonly: true, migrate: false });
  try {
    return (
      db.sqlite
        .prepare(
          `SELECT type, target_id FROM links
            WHERE source_type = 'question' AND source_id = ?
              AND type LIKE 'question-references-%' ORDER BY created_at, id`,
        )
        .all(notebookId) as Record<string, unknown>[]
    ).map((row) => ({ type: String(row['type']), targetId: String(row['target_id']) }));
  } finally {
    db.close();
  }
}

test('[S01] the page is written in blocks like a journal day, and the writing takes the room', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);

  // A figure where the researcher keeps it: outside every root this app was configured with.
  const inbox = join(workspace.dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const picture = join(inbox, 'retention-curve.png');
  copyFileSync(FIXTURE_IMAGE, picture);
  const before = statSync(picture);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, notebookId);

    // The blank page opens as blocks, not as a box of hashes: the template's headings are
    // rendered markdown, one block each, which is what makes them editable one at a time.
    const blocks = window.locator(
      '[data-testid^="notebook-block-"]:not([data-testid*="editor"])',
    );
    await expect(blocks.first()).toBeVisible();
    const template = await blocks.count();
    expect(template).toBeGreaterThan(1);
    await expect(window.locator('[data-testid="markdown-heading-experiment-log"]')).toBeVisible();

    // Markdown, and a code block that stays the text that was typed. The same two gestures
    // the journal's day has, on the page — one editor, not two ways of writing.
    await addBlock(window, 'text', '## Method');
    await addBlock(window, 'text', 'Two schedules, **massed** and spaced.');
    await addBlock(window, 'code', '```bash\npython sweep.py --schedule spaced\n```');

    const method = block(window, template);
    await expect(method).toHaveAttribute('data-block-type', 'text');
    await expect(method.locator('h2')).toHaveText('Method');
    await expect(block(window, template + 1).locator('strong')).toHaveText('massed');

    const command = block(window, template + 2);
    await expect(command).toHaveAttribute('data-block-type', 'code');
    await expect(command.locator('code')).toHaveText('python sweep.py --schedule spaced');

    // A picture becomes a block, and its bytes come the only way bytes reach this window.
    await dropFileOn(window, '[data-testid="notebook-blocks"]', picture);
    const figure = block(window, template + 3);
    await expect(figure).toHaveAttribute('data-block-type', 'image', { timeout: 30_000 });
    const image = figure.locator('img');
    await expect(image).toHaveAttribute('src', /^rrfile:\/\/dfl_/u);
    await expect
      .poll(async () => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
        timeout: 30_000,
        message: 'the dropped picture never loaded over rrfile://',
      })
      .toBeGreaterThan(0);

    // Nothing on the page says where that picture is: the renderer addressed it by id.
    const markup = await window
      .locator('[data-testid="notebook-panel"]')
      .evaluate((element) => element.outerHTML);
    expect(markup).not.toContain('retention-curve.png');
    expect(markup).not.toContain(workspace.dir);

    // The page takes the room (`S01`). It used to be one column of a grid with a 240px margin
    // beside it and a desk under it; since `P10` it is the whole page, and the front matter and
    // the claims are sections of the same scrolling document. So the shape this criterion is
    // about is now: the writing is as wide as the page, and taller than the front matter that
    // introduces it.
    const writing = await window.locator('[data-testid="notebook-blocks"]').boundingBox();
    const scroller = await window.locator('[data-testid="notebook-page"]').boundingBox();
    const front = await window
      .locator('[data-testid="notebook-section-front-matter"]')
      .boundingBox();
    if (writing === null || scroller === null || front === null) {
      throw new Error('the notebook page did not lay out');
    }
    expect(writing.width).toBeGreaterThan(scroller.width * 0.9);
    expect(writing.height).toBeGreaterThan(front.height);
  } finally {
    await first.app.close();
  }

  // The file is still exactly where it was: same inode, same bytes, not moved and not copied.
  const after = statSync(picture);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);

  // Everything above is one markdown document, so it all comes back the same way.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, notebookId);
    const page = window.locator('[data-testid="notebook-panel"]');
    await expect(page.locator('[data-testid="markdown-heading-method"]')).toHaveText('Method');
    await expect(page).toContainText('python sweep.py --schedule spaced');
    await expect(page.locator('[data-block-type="image"] img')).toHaveCount(1);
    // And the headings are real navigation rather than a grey line of text: the margin lists
    // what the document actually has in it.
    await expect(page.locator('[data-testid="notebook-outline"]')).toContainText('Method');
  } finally {
    await second.app.close();
  }
});

test('[S02] LaTeX renders in a notebook block, inline and display', async ({ workspace }) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, notebookId);
    const template = await window
      .locator('[data-testid^="notebook-block-"]:not([data-testid*="editor"])')
      .count();

    await addBlock(
      window,
      'text',
      'Retention decays as $R = e^{-t/S}$, so the schedule solves\n\n$$\\max_{\\Delta} \\sum_{i=1}^{n} R(t_i)$$',
    );

    // Two formulas: one inside the sentence, one as its own line.
    const maths = window.locator('[data-testid="markdown-math"]');
    await expect(maths).toHaveCount(2);
    await expect(maths.nth(0)).toHaveAttribute('data-display', 'inline');
    await expect(maths.nth(1)).toHaveAttribute('data-display', 'block');

    // Rendered mathematics, not a picture of it and not the source: MathML elements the
    // engine lays out, built from a vendored KaTeX.
    await expect(maths.nth(0).locator('math')).toHaveCount(1);
    await expect(maths.nth(1).locator('math')).toHaveAttribute('display', 'block');
    await expect(maths.nth(1).locator('msubsup, munderover')).not.toHaveCount(0);

    // Local-first: nothing was fetched to draw it. No stylesheet, no font, no CDN.
    const requested = await window.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('file:') && !name.startsWith('data:')),
    );
    expect(requested.filter((name) => /katex|cdn|jsdelivr|unpkg|https?:/u.test(name))).toEqual([]);

    // The sentence around it is still a sentence.
    await expect(block(window, template)).toContainText('Retention decays as');
  } finally {
    await first.app.close();
  }

  // It is stored as the LaTeX that was typed, so it renders again and is still editable text.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, notebookId);
    await expect(window.locator('[data-testid="markdown-math"]')).toHaveCount(2);
    const written = window.locator('[data-testid="markdown-math"]').first();
    await expect(written).toHaveAttribute('data-tex', 'R = e^{-t/S}');
  } finally {
    await second.app.close();
  }
});

test('[S03] a highlight is quoted into the page and keeps its link to the source', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  const source = workspace.documents[0];
  if (source === undefined) throw new Error('the workspace seeded no documents');
  const QUOTE = 'Recall is strongest when review is spread across days rather than massed.';
  const annotationId = seedHighlight(workspace, {
    documentId: source.id,
    pageIndex: 0,
    text: QUOTE,
  });

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, notebookId);
    const template = await window
      .locator('[data-testid^="notebook-block-"]:not([data-testid*="editor"])')
      .count();

    // The gesture: quote a highlight into the page you are writing on. The file first, then
    // the sentence — the same two steps the link picker takes.
    await window.locator('[data-testid="notebook-add-excerpt"]').click();
    await expect(window.locator('[data-testid="excerpt-picker"]')).toBeVisible();
    await window.locator(`[data-testid="excerpt-picker-file-${source.id}"]`).click();
    await window.locator(`[data-testid="excerpt-picker-highlight-${annotationId}"]`).click();
    await expect(window.locator('[data-testid="excerpt-picker"]')).toHaveCount(0);

    // It lands as an open block, so the researcher can write around the quote straight away.
    const editing = window.locator('[data-testid^="notebook-block-editor-"]');
    await expect(editing).toBeVisible();
    // Markdown, and one block: a blockquote with the sentence and an `annotation://` link.
    const written = await editing.inputValue();
    expect(written).toContain(`> ${QUOTE}`);
    expect(written).toContain(`(annotation://${annotationId})`);
    await editing.blur();

    const excerpt = block(window, template);
    await expect(excerpt.locator('blockquote')).toContainText(QUOTE);

    // Quoting it in a notebook *is* the notebook referring to that highlight, so the edge is
    // real. It is asserted in the database rather than on a second surface: since `P06` the
    // page is the only surface, and the quote above is the block — a desk that drew the same
    // edge again is exactly what this milestone took away.
    expect(referencesFromNotebook(workspace, notebookId)).toEqual([
      { type: 'question-references-annotation', targetId: annotationId },
    ]);
  } finally {
    await first.app.close();
  }

  // It survives a restart as markdown, and the link is what carries the reader back: pressing
  // the attribution opens the file the sentence was marked in.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, notebookId);

    const chip = window.locator(`[data-testid="internal-link-${annotationId}"]`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-scheme', 'annotation');
    await expect(chip).toHaveText(source.title);
    await chip.click();

    // The source, open on the highlight — which is the whole of "keeps its link to it".
    await expect(window.locator('.dv-tab', { hasText: source.title })).not.toHaveCount(0);
    await expect
      .poll(
        async () =>
          window.evaluate(() => document.querySelectorAll('[data-testid^="reader-"]').length),
        { timeout: 30_000, message: 'the excerpt link never opened its source' },
      )
      .toBeGreaterThan(0);
  } finally {
    await second.app.close();
  }
});
