/**
 * The notebook speaks Typst (criteria S04–S08).
 *
 * The researcher's decision behind this milestone: a paper is written in the tool papers are
 * set in. So the notebook's *source language* changes and everything else about the page stays
 * — it is the same block editor, over the same one document, storing the same source as typed.
 *
 * What these specs pin down, because each could have gone the other way:
 *
 * - the compiler is **local and vendored**, and nothing is fetched to draw a page (`S04`);
 * - a page written before the switch is still markdown and still renders as markdown, because
 *   nothing converted it — which is what makes "nothing already written is lost" checkable
 *   rather than hopeful (`S04`);
 * - two headers, in a fixed order, so a notebook can shadow a shared definition (`S05`);
 * - a picture still arrives by being dropped *and* can be written into the prose (`S06`);
 * - where the typeset page sits is the panel's aspect, with one setting for the tall case
 *   (`S07`);
 * - and every insertion lands after the block last written in (`S08`).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { openDatabase } from '@wr/database';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { COMMAND_IDS } from '@wr/workbench';
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { seedNotebook, type E2EWorkspace } from './support/workspace.js';
import { seedHighlight } from './support/librarian.js';
import { press } from './support/keys.js';
import { dropFileOn } from './support/drop.js';
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

const blocks = (window: Page) =>
  window.locator('[data-testid^="notebook-block-"]:not([data-testid*="editor"])');
const block = (window: Page, index: number) =>
  window.locator(`[data-testid="notebook-block-${String(index)}"]`);

/** Add a block and type into it, then click away — which is what commits. */
async function addBlock(window: Page, kind: 'text' | 'code', source: string): Promise<void> {
  await window.locator(`[data-testid="notebook-add-${kind}"]`).click();
  const editor = window.locator('[data-testid^="notebook-block-editor-"]');
  await editor.fill(source);
  await editor.blur();
}

/**
 * A notebook written before the switch: markdown, and stored as such.
 *
 * Written straight into the row because that is exactly what one is — a body from an older
 * version of the app, with the column still saying `markdown` because migration 016 defaults
 * it that way and nothing rewrote it.
 */
function seedMarkdownNotebook(workspace: E2EWorkspace, title: string, body: string): string {
  const id = seedNotebook(workspace, title);
  const { db } = openDatabase({ file: workspace.databasePath, migrate: false });
  try {
    db.sqlite
      .prepare("UPDATE questions SET body = ?, body_format = 'markdown' WHERE id = ?")
      .run(body, id);
  } finally {
    db.close();
  }
  return id;
}

test('[S04] the page is Typst, compiled locally, and a page written before the switch is untouched', async ({
  workspace,
}) => {
  const typstId = seedNotebook(workspace, NOTEBOOK);
  const legacyId = seedMarkdownNotebook(
    workspace,
    'What the older notebook said',
    '## Prior work\n\nSpacing **beats** massing.\n',
  );

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, typstId);

    // A notebook minted today opens on the Typst template — `=` headings, compiled, so what is
    // on screen is a heading and not four lines beginning with an equals sign.
    const template = await blocks(window).count();
    expect(template).toBeGreaterThan(1);
    await expect(block(window, 0).locator('h2')).toHaveText('What I want to know');

    // Typst, written as Typst and rendered as the paper it sets.
    // One typed document, two blocks: the blank line between them is the one segmentation rule
    // both languages share, so it still decides where a block ends.
    await addBlock(window, 'text', '= Method\n\nTwo schedules, *massed* and spaced.');
    await expect(block(window, template).locator('h2')).toHaveText('Method');
    await expect(block(window, template + 1).locator('strong')).toHaveText('massed');

    // Mathematics is not silently dropped, which is the failure this compiler's HTML target
    // has by default: a `$…$` that vanished would compile without complaint.
    await addBlock(window, 'text', 'Retention decays as $R = e^(-t/S)$ over days.');
    await expect(block(window, template + 2).locator('img.typst-frame')).toHaveCount(1);
    await expect(block(window, template + 2)).toContainText('Retention decays as');

    // Local-first: nothing was fetched to compile or to draw any of it.
    const requested = await window.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('file:') && !name.startsWith('data:')),
    );
    expect(requested.filter((name) => /typst|cdn|jsdelivr|unpkg|https?:/u.test(name))).toEqual([]);

    // A Typst package would be fetched over the network, so the source never reaches the
    // compiler and the page says why rather than going quietly blank.
    await addBlock(window, 'text', '#import "@preview/cetz:0.2.2": *');
    await expect(block(window, template + 3)).toContainText('@preview');

    // …and nothing already written is lost: the older notebook is still markdown, still says
    // what it said, and still renders through the markdown pipeline.
    await openNotebook(window, legacyId);
    await expect(window.locator('[data-testid="markdown-heading-prior-work"]')).toBeVisible();
    await expect(block(window, 1).locator('strong')).toHaveText('beats');
    await expect(window.locator('[data-testid="typst-global-header"]')).toHaveCount(0);
  } finally {
    await first.app.close();
  }

  // Stored as the Typst that was typed, so it compiles again after a restart.
  const second: LaunchedApp = await launchApp(workspace);
  try {
    const window = second.window;
    await openNotebook(window, typstId);
    await expect(window.locator('[data-testid="notebook-blocks"] h2').first()).toHaveText(
      'What I want to know',
    );
    await block(window, 5).click();
    const editing = window.locator('[data-testid^="notebook-block-editor-"]');
    expect(await editing.inputValue()).toContain('*massed*');
  } finally {
    await second.app.close();
  }
});

test('[S05] a global header serves every notebook, and this notebook’s own header wins', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  const otherId = seedNotebook(workspace, 'A second question entirely');

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, notebookId);
    const template = await blocks(window).count();

    // A command defined once, for every notebook.
    const globalHeader = window.locator('[data-testid="typst-global-header"]');
    await globalHeader.fill('#let claim(body) = [SHARED: #body]');
    await globalHeader.blur();
    await expect(window.locator('[data-testid="typst-global-header-error"]')).toHaveCount(0);

    await addBlock(window, 'text', '#claim[spacing wins]');
    await expect(block(window, template)).toContainText('SHARED: spacing wins');

    // The same command, redefined for this notebook alone. The local header is imported after
    // the global one, so it shadows it — which is the whole point of having two.
    const localHeader = window.locator('[data-testid="typst-local-header"]');
    await localHeader.fill('#let claim(body) = [THIS PAPER: #body]');
    await localHeader.blur();
    await expect(block(window, template)).toContainText('THIS PAPER: spacing wins');

    // A header that does not compile is refused, and the page says why rather than going blank.
    await localHeader.fill('#let claim(body) = ');
    await localHeader.blur();
    await expect(window.locator('[data-testid="typst-local-header-error"]')).toBeVisible();
    await expect(block(window, template)).toContainText('THIS PAPER: spacing wins');

    // …and the global one still serves every *other* notebook, which is what "global" means.
    await openNotebook(window, otherId);
    const otherTemplate = await blocks(window).count();
    await addBlock(window, 'text', '#claim[induction heads]');
    await expect(block(window, otherTemplate)).toContainText('SHARED: induction heads');
  } finally {
    await first.app.close();
  }
});

test('[S06] a picture still arrives by being dropped, and can be written into the prose', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  const inbox = join(workspace.dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const picture = join(inbox, 'retention-curve.png');
  copyFileSync(FIXTURE_IMAGE, picture);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, notebookId);
    const template = await blocks(window).count();

    // Block insertion stays exactly as it was (`P04`): the picture is dropped on the page and
    // the main process writes the figure in.
    await dropFileOn(window, '[data-testid="notebook-blocks"]', [picture]);
    const figure = block(window, template);
    await expect(figure).toHaveAttribute('data-block-type', 'image');
    const drawn = figure.locator('img.wr-block__figure');
    await expect(drawn).toHaveAttribute('src', /^rrfile:\/\/dfl_/u);

    // The reference in the source is an internal file id and nothing else — never a path.
    await figure.click();
    const editing = window.locator('[data-testid^="notebook-block-editor-"]');
    const written = await editing.inputValue();
    expect(written).toMatch(/^#image\("\/img\/dfl_[0-9a-hjkmnp-tv-z]{26}"/u);
    expect(written).not.toContain(inbox);
    const fileId = /\/img\/(dfl_[0-9a-hjkmnp-tv-z]{26})/u.exec(written)?.[1] ?? '';
    expect(fileId).not.toBe('');
    await editing.blur();

    // And Typst embedding also works: the same picture, inside a paragraph, typeset by the
    // compiler — which means the compiler was handed the bytes, in the main process, under
    // that same id.
    await addBlock(
      window,
      'text',
      `The curve is #image("/img/${fileId}", width: 40pt) as expected.`,
    );
    const embedded = block(window, template + 1);
    await expect(embedded).toContainText('The curve is');
    await expect(embedded.locator('img[src^="data:image/"]')).toHaveCount(1);
  } finally {
    await first.app.close();
  }
});

test('[S07] the live render follows the panel’s aspect, and the tall case has a setting', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    const resize = async (width: number, height: number): Promise<void> => {
      await first.app.evaluate(
        async ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
        },
        { width, height },
      );
    };

    await openNotebook(window, notebookId);
    const panel = window.locator('[data-testid="notebook-panel"]');
    const area = window.locator('[data-testid="notebook-writing-area"]');

    /**
     * How much of the window is not this panel.
     *
     * Measured rather than assumed: the rule is about the *panel's* aspect, and the sidebar,
     * the activity bar and the title band between the window and the panel are exactly the
     * numbers a spec must not hard-code. With these two the test can drive the panel to a
     * shape and then assert what the shape means.
     */
    const box = await panel.boundingBox();
    if (box === null) throw new Error('the notebook panel did not lay out');
    const chromeWidth = 1_440 - box.width;
    const chromeHeight = 900 - box.height;
    const shape = async (width: number, ratio: number): Promise<void> => {
      await resize(width, Math.round((width - chromeWidth) / ratio) + chromeHeight);
    };

    // Full width: the render sits beside the writing, and it is the typeset page — an SVG the
    // compiler produced, whose glyphs are paths, so it can never be mistaken for the editor.
    await shape(1_440, 1.6);
    await expect(area).toHaveAttribute('data-render-placement', 'right');
    await expect(window.locator('[data-testid="notebook-live-render-page"]')).toBeVisible();

    // Neither shape: no render at all, which is the honest answer for a panel with room for
    // one column of writing and nothing beside it.
    await shape(1_100, 1);
    await expect(area).toHaveAttribute('data-render-placement', 'none');
    await expect(window.locator('[data-testid="notebook-live-render"]')).toHaveCount(0);

    // Full height: beneath the writing.
    await shape(900, 1 / 1.6);
    await expect(area).toHaveAttribute('data-render-placement', 'below');
    await expect(window.locator('[data-testid="notebook-live-render-page"]')).toBeVisible();

    // …with a setting, because where you want to watch the page set itself is a preference,
    // and it is only a question at all when the render is stacked with the writing.
    const setting = window.locator('[data-testid="typst-render-placement"]');
    await setting.selectOption('top');
    await expect(area).toHaveAttribute('data-render-placement', 'above');
    await setting.selectOption('off');
    await expect(area).toHaveAttribute('data-render-placement', 'none');
  } finally {
    await first.app.close();
  }
});

test('[S08] every insertion has a chord and lands after the active block, else at the end', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, NOTEBOOK);
  const fresh = seedNotebook(workspace, 'A notebook nobody has written in');
  const source = workspace.documents[0];
  if (source === undefined) throw new Error('the workspace seeded no documents');
  const QUOTE = 'Recall is strongest when review is spread across days rather than massed.';
  const annotationId = seedHighlight(workspace, {
    documentId: source.id,
    pageIndex: 0,
    text: QUOTE,
  });

  const inbox = join(workspace.dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const picture = join(inbox, 'retention-curve.png');
  copyFileSync(FIXTURE_IMAGE, picture);

  const first: LaunchedApp = await launchApp(workspace);
  try {
    const window = first.window;
    await openNotebook(window, notebookId);
    const template = await blocks(window).count();

    // A picture in the library, so `+ image` has something to offer. New bytes still come from
    // a drop; this is the same picture being put in a second place.
    await dropFileOn(window, '[data-testid="notebook-blocks"]', [picture]);
    await expect(blocks(window)).toHaveCount(template + 1);

    // The active block is the second one of the template, and every chord below lands after
    // whichever block was last written in — not at the end of the page.
    await block(window, 1).click();
    const editing = window.locator('[data-testid^="notebook-block-editor-"]');
    await expect(editing).toBeVisible();
    await editing.blur();

    await press(window, COMMAND_IDS.addTextBlock);
    await expect(editing).toBeVisible();
    await editing.fill('The paragraph the chord made.');
    await editing.blur();
    await expect(block(window, 2)).toContainText('The paragraph the chord made.');

    await press(window, COMMAND_IDS.addCodeBlock);
    await expect(editing).toBeVisible();
    await editing.fill('```bash\npython sweep.py\n```');
    await editing.blur();
    await expect(block(window, 3)).toHaveAttribute('data-block-type', 'code');

    // `+ excerpt` and `+ image` are insertions too, so they have chords and they land in the
    // same place. Each opens the chooser it needs, because neither a highlight nor a picture
    // is something the editor could pick on its own.
    await press(window, COMMAND_IDS.addExcerptBlock);
    await expect(window.locator('[data-testid="excerpt-picker"]')).toBeVisible();
    await window.locator(`[data-testid="excerpt-picker-file-${source.id}"]`).click();
    await window.locator(`[data-testid="excerpt-picker-highlight-${annotationId}"]`).click();
    await expect(editing).toBeVisible();
    expect(await editing.inputValue()).toContain('#quote(block: true');
    await editing.blur();
    await expect(block(window, 4).locator('blockquote')).toContainText(QUOTE);

    await press(window, COMMAND_IDS.addImageBlock);
    const picker = window.locator('[data-testid="picture-picker"]');
    await expect(picker).toBeVisible();
    await picker.locator('[data-testid^="picture-picker-dfl_"]').first().click();
    await expect(editing).toBeVisible();
    await editing.blur();
    await expect(block(window, 5)).toHaveAttribute('data-block-type', 'image');

    // …else at the end. A page nobody has written in has no active block, and a chord pressed
    // on it means what the criterion says it means.
    await openNotebook(window, fresh);
    const freshTemplate = await blocks(window).count();
    await press(window, COMMAND_IDS.addTextBlock);
    await expect(editing).toBeVisible();
    await editing.fill('At the end, because nothing was open.');
    await editing.blur();
    await expect(block(window, freshTemplate)).toContainText('At the end, because nothing was open.');
  } finally {
    await first.app.close();
  }
});
