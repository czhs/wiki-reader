/**
 * The tab strip, against a real Electron process (criteria U01, U02, U03, U12).
 *
 * The first three were live at 117 green checks, because nothing in the suite had ever tried
 * to *close* anything. The tests here are written from the other direction: press the key a
 * person presses, click the control a person clicks, and assert the window is still there
 * afterwards.
 *
 * `Cmd+W` arrives over CDP, which delivers straight to the renderer. The other half of `U01`
 * — that no menu accelerator eats the keystroke before the renderer ever sees it — cannot be
 * observed from here and is asserted on the menu template in `main/menu.test.ts`.
 *
 * `U12` is about where the strip *is*. That is a geometry question and it has to be asked as
 * one: CDP injects input into the web contents directly, so a Playwright click reaches a tab
 * drawn under the macOS title bar even though a real hand's would be swallowed by the window.
 * Coordinates are the honest half of the claim; a press aimed at the tab's own rectangle is
 * the other.
 */
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';

/** The platform's close-tab chord, resolved the way the workbench resolves its bindings. */
const CLOSE_TAB = process.platform === 'darwin' ? 'Meta+w' : 'Control+w';
const CLOSE_GROUP = process.platform === 'darwin' ? 'Meta+Shift+w' : 'Control+Shift+w';

const tabs = (window: Page) => window.locator('[data-testid="dockview-container"] .dv-tab');
const groups = (window: Page) =>
  window.locator('[data-testid="dockview-container"] .dv-groupview');

async function openFromLibrary(
  window: Page,
  documentId: string,
  options: { readonly toSide?: boolean } = {},
): Promise<void> {
  const row = window.locator(
    `[data-testid="library-sidebar"] [data-testid="library-item-${documentId}"]`,
  );
  await expect(row).toBeVisible();
  await row.click(options.toSide === true ? { modifiers: ['Meta'] } : {});
}

test.describe('closing tabs and groups', () => {
  test('[U01] closes the focused tab with the keyboard and leaves the window open', async ({
    window,
    launched,
    workspace,
  }) => {
    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await openFromLibrary(window, first.id);
    await openFromLibrary(window, second.id);
    await expect(tabs(window)).toHaveCount(2);

    await window.keyboard.press(CLOSE_TAB);

    // One tab went, and it was the focused one — the other document is still open.
    await expect(tabs(window)).toHaveCount(1);
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('1 panel');
    await expect(
      window.locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`),
    ).toBeVisible();
    expect(launched.app.windows()).toHaveLength(1);

    // The last tab. This is where the keystroke used to reach Chromium and take the window
    // with it, so the assertion is about what is *still* here: a live window showing the
    // watermark, with the library sidebar to open the next document from.
    await window.keyboard.press(CLOSE_TAB);
    await expect(tabs(window)).toHaveCount(0);
    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeVisible();
    await expect(window.locator('[data-testid="library-sidebar"]')).toBeVisible();
    expect(launched.app.windows()).toHaveLength(1);

    // And once more with nothing open at all. The binding is unconditional precisely so that
    // this keystroke is still claimed rather than handed back to the window.
    await window.keyboard.press(CLOSE_TAB);
    await expect(window.locator('[data-testid="app-shell"]')).toBeVisible();
    expect(launched.app.windows()).toHaveLength(1);
    expect(launched.app.process().killed).toBe(false);
  });

  test('[U02] closes a split group, including the one holding the last tab', async ({
    window,
    launched,
    workspace,
  }) => {
    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await openFromLibrary(window, first.id);
    await openFromLibrary(window, second.id, { toSide: true });
    await expect(groups(window)).toHaveCount(2);

    // The split group, the one that just took focus, goes as a unit.
    await window.keyboard.press(CLOSE_GROUP);
    await expect(groups(window)).toHaveCount(1);
    await expect(tabs(window)).toHaveCount(1);
    await expect(
      window.locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`),
    ).toBeVisible();
    // The survivor takes the whole centre back rather than leaving a dead half behind.
    const centre = await window.locator('[data-testid="dockview-container"]').boundingBox();
    const reader = await window
      .locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`)
      .boundingBox();
    expect(centre).not.toBeNull();
    expect(reader).not.toBeNull();
    if (centre === null || reader === null) return;
    expect(reader.width).toBeGreaterThan(centre.width * 0.9);

    // The remaining group holds the last tab in the workspace. Closing it is the case the
    // criterion names, and the window has to survive it.
    await window.keyboard.press(CLOSE_GROUP);
    await expect(groups(window)).toHaveCount(0);
    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeVisible();
    expect(launched.app.windows()).toHaveLength(1);
  });

  test('[U03] keeps a tab close control hit-able however long the title', async ({
    window,
    workspace,
  }) => {
    // A markdown page whose title is 119 characters, written into the corpus and ingested by
    // the real importer. Opened alongside two PDFs, so the strip is genuinely shared.
    const longRow = window
      .locator('[data-testid="library-sidebar"] [data-testid^="library-item-"]', {
        hasText: workspace.corpusPage.longTitle,
      })
      .first();
    await expect(longRow).toBeVisible();
    await longRow.click();

    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    await openFromLibrary(window, first.id);
    await openFromLibrary(window, second.id);
    await expect(tabs(window)).toHaveCount(3);

    const longTab = tabs(window).filter({ hasText: workspace.corpusPage.longTitle });
    await expect(longTab).toHaveCount(1);

    // Reach first, because reach is what the criterion claims: every tab's × sits inside the
    // strip, this one included. A tab sized to its title puts the control past the right edge,
    // where no click can reach it. This is deliberately asserted before anything about how the
    // title is painted — truncation is one way to buy the reach, and the test should fail on
    // the property, not on the technique.
    const strip = await window
      .locator('[data-testid="dockview-container"] .dv-tabs-container')
      .first()
      .boundingBox();
    expect(strip).not.toBeNull();
    if (strip === null) return;

    const closers = tabs(window).locator('.dv-default-tab-action');
    await expect(closers).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      const box = await closers.nth(index).boundingBox();
      expect(box, `tab ${String(index)} has no close control on screen`).not.toBeNull();
      if (box === null) continue;
      expect(box.x).toBeGreaterThanOrEqual(strip.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
      expect(box.width).toBeGreaterThan(0);
    }

    // The whole title is still in the DOM; only its painting is clipped. Asserting the text
    // is intact rules out a "fix" that shortened the title instead of the tab.
    await expect(longTab.locator('.dv-default-tab-content')).toHaveText(
      workspace.corpusPage.longTitle,
    );
    const clipped = await longTab
      .locator('.dv-default-tab-content')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(clipped).toBe(true);

    // And it is a control, not just a glyph inside the strip: hovering the tab reveals it and
    // clicking closes that tab and no other. The hover is not test scaffolding — dockview
    // shows an inactive tab's × on hover, the way an editor tab strip has always worked, and
    // it is exactly the gesture the criterion is about. What was broken was where the control
    // ended up, not whether it was painted: hovering a tab whose × sits past the right edge
    // reveals nothing a pointer can reach.
    await longTab.hover();
    const longCloser = longTab.locator('.dv-default-tab-action');
    await expect(longCloser).toBeVisible();
    await longCloser.click();
    await expect(tabs(window)).toHaveCount(2);
    await expect(tabs(window).filter({ hasText: workspace.corpusPage.longTitle })).toHaveCount(0);
  });

  /**
   * Where the strip sits, and whether a press lands on it (`U12`).
   *
   * The researcher saw tabs "too high" — riding up into the window's own furniture, their tops
   * cut off by its rounded corner. `titleBarStyle: 'hiddenInset'` gives the page a full-size
   * content view, so the page's y=0 *is* the top of the window: the strip was drawn in the
   * band the traffic lights sit in, where the native title bar takes every press. `.wr-shell`
   * reserves that band now, at the root, from `env(titlebar-area-height)` — a number macOS
   * only reports when `titleBarOverlay` is on, which is why the band was previously reserved
   * as the 8px fallback of a variable nobody had enabled.
   *
   * The band is read from the *window*, not from the shell's own padding: asking the CSS that
   * is the fix how tall the fix is passes whatever the fix says, including nothing at all.
   * `navigator.windowControlsOverlay` is macOS answering directly, and on darwin its being
   * invisible is itself the failure — that is the main-process half of this, and without it
   * `env(titlebar-area-height)` is undefined and every reader of it gets its own fallback.
   *
   * Then geometry, because geometry is what a hand runs into, and hit-testing at the tab's
   * drawn centre, because that catches the other way this breaks: the strip in the right place
   * with something else painted over it.
   */
  test('[U12] draws the tab strip below the window band, hit-able where it is drawn', async ({
    window,
    workspace,
  }) => {
    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await openFromLibrary(window, first.id);
    await openFromLibrary(window, second.id);
    await expect(tabs(window)).toHaveCount(2);

    // What the window itself says it keeps: the bottom edge of the region the traffic lights
    // and the native title bar own. Zero where the frame is outside the page.
    const band = await window.evaluate(() => {
      const overlay = (
        navigator as unknown as {
          windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect: () => DOMRect };
        }
      ).windowControlsOverlay;
      if (overlay === undefined || !overlay.visible) return 0;
      const rect = overlay.getTitlebarAreaRect();
      return rect.y + rect.height;
    });

    const geometry = await window.evaluate(() => {
      const shell = document.querySelector('[data-testid="app-shell"]');
      const strip = document.querySelector(
        '[data-testid="dockview-container"] .dv-tabs-and-actions-container',
      );
      if (shell === null || strip === null) return null;
      const stripRect = strip.getBoundingClientRect();
      const describe = (x: number, y: number, tab: Element): string => {
        const element = document.elementFromPoint(x, y);
        if (element === null) return 'nothing';
        if (tab.contains(element)) return 'tab';
        return `${element.tagName.toLowerCase()}.${String(element.getAttribute('class') ?? '')}`;
      };
      return {
        // What the shell actually set aside, to be checked against what the window asked for.
        reserved: Number.parseFloat(getComputedStyle(shell).paddingTop),
        strip: {
          top: stripRect.top,
          bottom: stripRect.bottom,
          left: stripRect.left,
          right: stripRect.right,
          height: stripRect.height,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        tabs: [...document.querySelectorAll('[data-testid="dockview-container"] .dv-tab')].map(
          (tab) => {
            const rect = tab.getBoundingClientRect();
            return {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              height: rect.height,
              // The centre of what is drawn, its top edge, and its leading edge — the three
              // places a hand aims at a tab.
              atCentre: describe(rect.left + rect.width / 2, rect.top + rect.height / 2, tab),
              atTop: describe(rect.left + rect.width / 2, rect.top + 2, tab),
              atLeading: describe(rect.left + 4, rect.top + rect.height / 2, tab),
            };
          },
        ),
      };
    });
    expect(geometry).not.toBeNull();
    if (geometry === null) return;

    // The page starts at the top of the window on macOS, so there is a band and it is not
    // nothing. Elsewhere the frame is outside the page and zero is the right answer.
    if (process.platform === 'darwin') {
      expect(band, 'the window reports no title bar band — is titleBarOverlay on?').toBeGreaterThan(
        0,
      );
    }
    // The shell sets aside everything the window asked for, and does it once at the root.
    expect(geometry.reserved).toBeGreaterThanOrEqual(band);

    // The strip is below the band, whole, and inside the window: not offset upward, not
    // clipped at either end.
    expect(geometry.strip.top).toBeGreaterThanOrEqual(band);
    expect(geometry.strip.height).toBeGreaterThan(20);
    expect(geometry.strip.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.strip.right).toBeLessThanOrEqual(geometry.viewport.width + 1);

    expect(geometry.tabs).toHaveLength(2);
    for (const [index, tab] of geometry.tabs.entries()) {
      const where = `tab ${String(index)}`;
      // Every tab is drawn inside the strip, full height, below the band.
      expect(tab.top, `${where} starts inside the window's own band`).toBeGreaterThanOrEqual(band);
      expect(tab.top, `${where} rides above the strip`).toBeGreaterThanOrEqual(
        geometry.strip.top - 1,
      );
      expect(tab.bottom, `${where} hangs below the strip`).toBeLessThanOrEqual(
        geometry.strip.bottom + 1,
      );
      expect(tab.height, `${where} is squashed`).toBeGreaterThan(20);
      // And the renderer agrees that the tab is what is at those pixels.
      expect(tab.atCentre, `${where} is not at its own centre`).toBe('tab');
      expect(tab.atTop, `${where} is covered at its top edge`).toBe('tab');
      expect(tab.atLeading, `${where} is covered at its leading edge`).toBe('tab');
    }

    // A press aimed at the pixels the first tab occupies selects it. `page.mouse`, not
    // `locator.click`: the coordinates are the claim, and Playwright's own scroll-into-view
    // would hide a strip that had been pushed somewhere else.
    const firstTab = tabs(window).first();
    await expect(firstTab).toHaveClass(/dv-inactive-tab/);
    const drawn = geometry.tabs[0];
    expect(drawn).toBeDefined();
    if (drawn === undefined) return;
    await window.mouse.click(
      drawn.left + (drawn.right - drawn.left) / 2,
      drawn.top + drawn.height / 2,
    );
    await expect(firstTab).toHaveClass(/dv-active-tab/);
    await expect(
      window.locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`),
    ).toBeVisible();
  });
});
