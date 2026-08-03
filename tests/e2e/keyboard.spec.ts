/**
 * Fast in the hand: the keyboard crosses the workspace (`D01`), and the help page is the
 * registries rather than a sheet about them (`D02`).
 *
 * `K03` made the keys *discoverable*; these make them *sufficient*. The first test is one
 * uninterrupted traversal — no clicking between the steps, because a route that needs a mouse
 * halfway is not a route — through every surface milestone 5 built: the directory, a notebook,
 * its journal, a reader, the focused view, the wiki, and back to the reading.
 *
 * The chords are not spelled out in either test. They are read from `DEFAULT_KEYBINDINGS` and
 * pressed, so a rebound key moves the test with it and a *missing* binding fails it — which is
 * the only way an assertion about a keyboard scheme can stay true. Writing `Meta+Shift+D` here
 * would be asserting about this file.
 */
import {
  COMMAND_IDS,
  DEFAULT_KEYBINDINGS,
  KEYBINDING_FAMILIES,
  formatKeystroke,
} from '@wr/workbench';
import { launchApp, test, expect, showLibrary, type LaunchedApp } from './support/app.js';
import { chordOf, press } from './support/keys.js';
import { seedNotebook } from './support/workspace.js';

const NOTEBOOK = 'Do induction heads appear in VLAs?';


test('[D01] crosses the whole workspace from the keyboard, without the mouse', async ({
  workspace,
}) => {
  const notebook = seedNotebook(workspace, NOTEBOOK, [
    { date: '2026-07-20', markdown: 'Ran the sweep.' },
  ]);
  const paper = workspace.pdfDocuments[0];
  expect(paper).toBeDefined();
  if (paper === undefined) return;

  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    // Nothing is open, and nothing is clicked from here on. The library sidebar has to have
    // loaded before the file list can offer anything, which is the one wait the traversal has.
    await showLibrary(window);
    await expect(
      window.locator(`[data-testid="library-panel"] [data-testid="library-item-${paper.id}"]`),
    ).toBeVisible();

    // --- the directory ---------------------------------------------------
    await press(window, COMMAND_IDS.openNotebookDirectory);
    const directory = window.locator('[data-testid="notebook-directory"]');
    await expect(directory).toBeVisible();
    await expect(directory).toContainText(NOTEBOOK);

    // --- a notebook ------------------------------------------------------
    // No argument travels with a keystroke, so the command asks which notebook is in hand.
    await press(window, COMMAND_IDS.openNotebook);
    const notebookPage = window.locator('[data-testid="notebook-panel"]');
    await expect(notebookPage).toBeVisible();
    await expect(notebookPage).toHaveAttribute('data-question-id', notebook);

    // --- its journal -----------------------------------------------------
    // The journal of *that* notebook: the one being looked at, not a global stream (`P02`).
    await press(window, COMMAND_IDS.openJournal);
    await expect(window.locator('[data-testid="journal-main"]')).toBeVisible();
    await expect(window.locator('[data-testid="journal-notebook-title"]')).toContainText(NOTEBOOK);

    // --- a reader --------------------------------------------------------
    // A document is one of thousands rather than one of a dozen, so the chord opens the list
    // and the typing chooses. Both halves are keyboard: filter, arrow, enter.
    await press(window, COMMAND_IDS.goToFile);
    const fileList = window.locator('[data-testid="file-list"]');
    await expect(fileList).toBeVisible();
    await window.keyboard.type(paper.title.slice(0, 12));
    const chosen = window.locator(`[data-testid="file-row-${paper.id}"]`);
    await expect(chosen).toBeVisible();
    await expect(chosen).toHaveAttribute('data-active', 'true');
    await window.keyboard.press('Enter');
    await expect(fileList).toBeHidden();

    const reader = window.locator('[data-testid="pdf-reader"]');
    await expect(reader).toBeVisible({ timeout: 60_000 });
    await expect(reader).toHaveAttribute('data-document-id', paper.id);

    // --- the focused view ------------------------------------------------
    // Opened on what is being read, with no argument: the same resolution the reader's own
    // buttons use (`F02`).
    await press(window, COMMAND_IDS.openFocusView);
    const focus = window.locator('[data-testid="focus-panel"]');
    await expect(focus).toBeVisible();
    await expect(window.locator('[data-testid="focus-title"]')).toContainText(paper.title);

    // --- the wiki --------------------------------------------------------
    await press(window, COMMAND_IDS.openWiki);
    await expect(window.locator('[data-testid="wiki-panel"]')).toBeVisible();

    // --- and back to the reading -----------------------------------------
    // Four pages later, one key returns to the paper rather than to a tab strip.
    await press(window, COMMAND_IDS.openReading);
    await expect(reader).toBeVisible();
    // Focused, not merely still on screen: the crawl left it in a group of its own, so the
    // question is which tab the workspace is *on*, not which tabs exist.
    await expect(
      window.locator('[data-testid="dockview-container"] .dv-active-group .dv-tab.dv-active-tab'),
    ).toContainText(paper.title);

    // --- the help page ---------------------------------------------------
    await press(window, COMMAND_IDS.openHelp);
    await expect(window.locator('[data-testid="help-panel"]')).toBeVisible();

    // The traversal never took the window down with it, which is what a scheme that claims
    // `Cmd+W`-shaped chords has to keep true.
    expect(launched.app.windows()).toHaveLength(1);
  } finally {
    await launched.app.close();
  }
});

/**
 * The help page, checked against the registries it claims to be rendered from.
 *
 * Every assertion below compares the page with `COMMAND_IDS` and `DEFAULT_KEYBINDINGS` — the
 * tables the running app registered — rather than with a list written here. The count
 * assertions are the load-bearing ones: a page that merely *contains* every command could
 * still be a hand-written sheet that happens to be complete today, and a page with exactly as
 * many rows as there are commands cannot be.
 */
test('[D02] lists every feature and every keybinding, generated from the registries', async ({
  workspace,
}) => {
  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;

    // Found without knowing a key, for the reason `K03` gives: the page that explains the
    // scheme must not be reachable only through the scheme. It prints its own chord.
    const entry = window.locator('[data-testid="status-help"]');
    await expect(entry).toBeVisible();
    await expect(entry.locator('.wr-kbd')).toHaveCount(1);
    await entry.click();

    const help = window.locator('[data-testid="help-panel"]');
    await expect(help).toBeVisible();

    // Every feature: one row per registered command, and no more.
    const commandIds = Object.values(COMMAND_IDS);
    await expect(help).toHaveAttribute('data-command-count', String(commandIds.length));
    for (const commandId of commandIds) {
      const row = window.locator(`[data-testid="help-command-${commandId}"]`);
      await expect(row, `no help row for ${commandId}`).toHaveCount(1);
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeVisible();

      // Named as a feature, not as an identifier: "Open Notebooks", not `wr.openNotebooks`.
      const title = ((await row.locator('.wr-help__command-title').textContent()) ?? '').trim();
      expect(title.length, `${commandId} has no title`).toBeGreaterThan(0);
      expect(title).not.toBe(commandId);
    }

    // Every keybinding: one row per registered binding, at the chord the registry resolved.
    await expect(help).toHaveAttribute('data-binding-count', String(DEFAULT_KEYBINDINGS.length));
    for (const rule of DEFAULT_KEYBINDINGS) {
      const chord = formatKeystroke(chordOf(rule));
      const key = window.locator(`[data-testid="help-key-${chord}"]`);
      await expect(key, `no help row for ${chord}`).toHaveCount(1);
      await key.scrollIntoViewIfNeeded();
      await expect(key).toBeVisible();
      await expect(key).toHaveAttribute('data-command-id', rule.commandId);
      // Printed the way a keyboard prints it, beside the name of what it does.
      await expect(key.locator('.wr-kbd')).toHaveCount(1);

      // And the feature list agrees about the same chord, because both read one registry.
      const row = window.locator(`[data-testid="help-command-${rule.commandId}"]`);
      const chords = ((await row.getAttribute('data-chord')) ?? '').split(' ');
      expect(chords, `${rule.commandId} is not shown with ${chord}`).toContain(chord);
    }

    // The scheme is on the page as a scheme: the family the pages live in is named, and the
    // pages milestone 5 built are in it. The name comes from the table that decides the
    // scheme, so a renamed family moves this assertion with it.
    const pages = window.locator(`[data-testid="help-family-${KEYBINDING_FAMILIES.page}"]`);
    await expect(pages).toBeVisible();
    for (const commandId of [
      COMMAND_IDS.openNotebookDirectory,
      COMMAND_IDS.openNotebook,
      COMMAND_IDS.openJournal,
      COMMAND_IDS.openWiki,
      COMMAND_IDS.openFocusView,
      COMMAND_IDS.openHelp,
    ]) {
      await expect(pages.locator(`[data-command-id="${commandId}"]`)).toHaveCount(1);
    }

    // One help page, however many times it is asked for.
    await entry.click();
    await expect(window.locator('[data-testid="help-panel"]')).toHaveCount(1);
  } finally {
    await launched.app.close();
  }
});
