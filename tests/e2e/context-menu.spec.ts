/**
 * The right hand (criterion `R01`), against a real Electron process.
 *
 * The criterion has two halves, and the second is the one worth writing a test for. The first
 * is easy to see: right-clicking a library row, a tab, a disc on the map, a marked sentence, a
 * notebook and a block each offers something, and each thing offered actually runs on the thing
 * that was clicked. The second is the rule behind it — *a menu is the command registry read
 * contextually, never a second list of actions* — and a menu that quietly grew its own actions
 * would pass every "does it work" assertion while breaking exactly what was asked for.
 *
 * So the load-bearing assertion here reads the menu and then reads the help page, which is
 * generated from the registries (`D02`), and insists that every item the menu offered has a
 * row there. A menu item nobody can find on the help page is by definition a second list.
 *
 * The last test is the composition the criterion calls out: the archive frame's right-click is
 * already how a selection gets out of a sandboxed page (`H01`), and it still is.
 */
import { launchApp, test, expect, type LaunchedApp } from './support/app.js';
import { rightClickInFrame, selectInFrame } from './support/archive.js';
import { corpusPageId, openLibrary, highlight } from './support/corpus.js';
import { seedNotebook } from './support/workspace.js';
import type { FrameLocator, Page } from '@playwright/test';

const menu = (window: Page) => window.locator('[data-testid="context-menu"]');
const item = (window: Page, commandId: string) =>
  window.locator(`[data-testid="context-menu-item-${commandId}"]`);

/** Every command id a menu is offering, in the order it draws them. */
async function offered(window: Page): Promise<string[]> {
  await expect(menu(window)).toBeVisible();
  return menu(window).locator('[data-command-id]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-command-id') ?? ''),
  );
}

/** Right-click something, and wait for the menu it belongs to. */
async function rightClick(window: Page, selector: string, kind: string): Promise<void> {
  await window.locator(selector).click({ button: 'right' });
  await expect(menu(window)).toBeVisible();
  await expect(menu(window)).toHaveAttribute('data-menu-kind', kind);
}

test('[R01] a library row and a tab each offer what belongs to them, and nothing a menu invented', async ({
  window,
  workspace,
}) => {
  const [paper] = workspace.documents;
  if (paper === undefined) throw new Error('the workspace seeded no documents');

  await openLibrary(window);
  await rightClick(
    window,
    `[data-testid="library-sidebar"] [data-testid="library-item-${paper.id}"]`,
    'library-row',
  );

  // What a file *is* decides what is offered: open it, account for its links, look at it in
  // the map, link it, send it to a notebook, take a note from it.
  const onARow = await offered(window);
  expect(onARow).toContain('wr.openDocument');
  expect(onARow).toContain('wr.openLedger');
  expect(onARow).toContain('wr.linkToDocument');
  expect(onARow).toContain('wr.sendToNotebook');

  // The rule, asserted rather than assumed: every one of those is a command the help page
  // knows, because the menu and the help page are the same registry read two ways. A menu
  // item missing here would be an action that exists only in a menu.
  await window.keyboard.press('Escape');
  await expect(menu(window)).toHaveCount(0);
  await window.locator('[data-testid="status-help"]').click();
  const help = window.locator('[data-testid="help-panel"]');
  await expect(help).toBeVisible();
  for (const commandId of onARow) {
    await expect(
      help.locator(`[data-testid="help-command-${commandId}"]`),
      `the help page does not list ${commandId}`,
    ).toHaveCount(1);
  }

  // And an item runs the command *on what was right-clicked*, not on whatever was in front:
  // the help page is the active tab, and the ledger that opens is the paper's.
  await openLibrary(window);
  await rightClick(
    window,
    `[data-testid="library-sidebar"] [data-testid="library-item-${paper.id}"]`,
    'library-row',
  );
  await item(window, 'wr.openLedger').click();
  const ledger = window.locator('[data-testid="ledger-panel"]');
  await expect(ledger).toBeVisible();
  await expect(ledger).toHaveAttribute('data-document-id', paper.id);

  // A tab is a panel as well as what it shows, so its menu closes it — the same command the
  // keyboard's close chord runs, with this tab's id rather than the focused one's.
  const tabs = window.locator('[data-testid="dockview-container"] .dv-tab');
  const before = await tabs.count();
  await tabs.filter({ hasText: 'Links' }).first().click({ button: 'right' });
  await expect(menu(window)).toHaveAttribute('data-menu-kind', 'tab');
  const onATab = await offered(window);
  expect(onATab).toContain('wr.closeTab');
  expect(onATab).toContain('wr.closeGroup');
  await item(window, 'wr.closeTab').click();
  await expect(tabs).toHaveCount(before - 1);
  await expect(window.locator('[data-testid="ledger-panel"]')).toHaveCount(0);
});

test('[R01] a highlight and a node on the map offer what can be done to them there', async ({
  window,
  workspace,
}) => {
  const documentId = await corpusPageId(workspace);
  const quoted = await highlight(window, documentId);

  // The marked sentence, in the sidebar that lists them. Right-clicking one is the same
  // gesture as right-clicking the row of the paper it is in, and offers the things that are
  // true of a *sentence*: send it to a notebook, write a note on it, link it.
  const sidebar = window.locator('[data-testid="annotations-sidebar"]');
  if (!(await sidebar.isVisible())) {
    await window.locator('[data-testid="activity-annotations"]').click();
  }
  const card = sidebar.locator('[data-testid^="annotation-"]').first();
  await expect(card).toBeVisible();
  await card.click({ button: 'right' });
  await expect(menu(window)).toHaveAttribute('data-menu-kind', 'highlight');
  const onAHighlight = await offered(window);
  expect(onAHighlight).toContain('wr.sendToNotebook');
  expect(onAHighlight).toContain('wr.newNoteFromHere');

  // Running it opens the notebook picker *on that sentence* — the same command `Cmd+Alt+S`
  // runs, so there is one way of sending things to a notebook and the menu is a door onto it.
  await item(window, 'wr.sendToNotebook').click();
  const picker = window.locator('[data-testid="notebook-picker"]');
  await expect(picker).toBeVisible();
  await expect(window.locator('[data-testid="notebook-picker-source"]')).toContainText(
    quoted.trim().slice(0, 20),
  );
  await window.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  // The same file as a disc on the map. A node is a thing you can act on, not only a place to
  // click through to, and what it offers is what its row in the library offers.
  await window.locator('[data-testid="activity-focus"]').click();
  const view = window.locator('[data-testid="focus-panel"]');
  await expect(view).toHaveAttribute('data-focus-id', documentId);
  await view.locator(`[data-testid="focus-node-${documentId}"]`).click({ button: 'right' });
  await expect(menu(window)).toHaveAttribute('data-menu-kind', 'graph-node');
  const onANode = await offered(window);
  expect(onANode).toContain('wr.openLedger');
  expect(onANode).toContain('wr.linkToDocument');
  await item(window, 'wr.openLedger').click();
  const ledger = window.locator('[data-testid="ledger-panel"]');
  await expect(ledger).toBeVisible();
  await expect(ledger).toHaveAttribute('data-document-id', documentId);
});

test('[R01] a notebook opens from its row, and a block adds another beneath itself', async ({
  workspace,
}) => {
  const notebookId = seedNotebook(workspace, 'Does spacing beat massing?');
  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    await window.locator('[data-testid="activity-notebooks"]').click();
    await expect(window.locator('[data-testid="notebook-directory"]')).toBeVisible();

    // A notebook's two doors. Deliberately *not* discard or delete: those live on the queue's
    // row, guarded and in that order, and a menu must not be a second, unguarded way in.
    await rightClick(window, `[data-testid="directory-item-${notebookId}"]`, 'notebook');
    const onANotebook = await offered(window);
    expect(onANotebook).toEqual([
      'wr.openNotebook',
      'wr.openJournal',
      'wr.openNotebookDirectory',
    ]);
    await item(window, 'wr.openJournal').click();
    await expect(window.locator('[data-testid="journal-page"]')).toHaveAttribute(
      'data-notebook-id',
      notebookId,
    );

    // The page itself. The template opens as several blocks; right-clicking the first one and
    // asking for a text block puts the new one *under it* — which is the thing the insert
    // strip at the bottom of the page cannot say, because it only ever appends.
    await window.locator('[data-testid="activity-notebooks"]').click();
    await window.locator(`[data-testid="directory-open-${notebookId}"]`).click();
    await expect(window.locator('[data-testid="notebook-panel"]')).toHaveAttribute(
      'data-question-id',
      notebookId,
    );
    const blocks = window.locator('[data-testid^="notebook-block-"]:not([data-testid*="editor"])');
    await expect(blocks.first()).toBeVisible();
    const wasSecond = await blocks.nth(1).innerText();

    await rightClick(window, '[data-testid="notebook-block-0"]', 'block');
    expect(await offered(window)).toEqual(['wr.editBlock', 'wr.addTextBlock', 'wr.addCodeBlock']);
    await item(window, 'wr.addTextBlock').click();

    const editor = window.locator('[data-testid="notebook-block-editor-1"]');
    await expect(editor).toBeVisible();
    await editor.fill('Inserted right here.');
    await editor.blur();

    await expect(window.locator('[data-testid="notebook-block-1"]')).toContainText(
      'Inserted right here.',
    );
    // And it went *between*, not over: what used to be second is now third.
    await expect(window.locator('[data-testid="notebook-block-2"]')).toHaveText(wasSecond);
  } finally {
    await launched.app.close();
  }
});

test('[R01] the archive frame keeps its own right-click, and the reader around it gets the menu', async ({
  window,
  workspace,
}) => {
  const [saved] = workspace.webpageDocuments;
  if (saved === undefined) throw new Error('the workspace seeded no saved web page');

  await openLibrary(window);
  await window
    .locator(`[data-testid="library-sidebar"] [data-testid="library-item-${saved.id}"]`)
    .click();
  const reader = window.locator(`[data-testid="html-reader"][data-document-id="${saved.id}"]`);
  await expect(reader).toBeVisible({ timeout: 30_000 });
  const frame: FrameLocator = reader.frameLocator('[data-testid="snapshot-frame"]');

  // A selection inside the archive, and the right-click that carries it out (`H01`). The point
  // is computed from the published scale, because the reader lays the frame out at desktop
  // width and scales it — Playwright's own hit-testing lands on `<body>`.
  await rightClickInFrame(window, reader, await selectInFrame(frame));

  // The gesture still does what `H01` made it do — the words came out of the frame and the
  // bar to mark them is up — and no menu appeared over it. The two compose because the frame's
  // events never cross into this document at all.
  await expect(window.locator('[data-testid="article-selection-toolbar"]')).toBeVisible();
  await expect(menu(window)).toHaveCount(0);

  // The reader's own chrome, one right-click away, does offer the menu: the file being read
  // has a ledger, a place in the map, and a notebook it can be sent to.
  await window.locator(`[data-testid="reader-actions-${saved.id}"]`).click({ button: 'right' });
  await expect(menu(window)).toHaveAttribute('data-menu-kind', 'reader');
  const onTheReader = await offered(window);
  expect(onTheReader).toContain('wr.openLedger');
  expect(onTheReader).toContain('wr.sendToNotebook');
});
