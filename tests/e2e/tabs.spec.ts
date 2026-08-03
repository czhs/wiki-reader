/**
 * The tab strip, against a real Electron process (criteria U01, U02, U03, U12, U13).
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
import { test, expect, resizeWindow, showLibrary } from './support/app.js';
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
  await showLibrary(window);
  const row = window.locator(
    `[data-testid="library-panel"] [data-testid="library-item-${documentId}"]`,
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
    // Three: the library is a tab too now (`U15`), and it is the tab the app opened on.
    await expect(tabs(window)).toHaveCount(3);

    await window.keyboard.press(CLOSE_TAB);

    // One tab went, and it was the focused one — the other document is still open, and its
    // tab is still in the strip. Which tab dockview puts in front afterwards is dockview's
    // business, so the claim is made on the tab and then on the reading it brings back.
    await expect(tabs(window)).toHaveCount(2);
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('2 panels');
    await window.locator(`.dv-default-tab[data-panel-id="pdf-reader:${first.id}"]`).click();
    await expect(
      window.locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`),
    ).toBeVisible();
    expect(launched.app.windows()).toHaveLength(1);

    // The last tab. This is where the keystroke used to reach Chromium and take the window
    // with it, so the assertion is about what is *still* here: a live window showing the
    // watermark, with the ways in it names.
    await window.keyboard.press(CLOSE_TAB);
    await window.keyboard.press(CLOSE_TAB);
    await expect(tabs(window)).toHaveCount(0);
    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeVisible();
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
    await expect(tabs(window)).toHaveCount(2);
    await window.locator(`.dv-default-tab[data-panel-id="pdf-reader:${first.id}"]`).click();
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
    await showLibrary(window);
    const longRow = window
      .locator('[data-testid="library-panel"] [data-testid^="library-item-"]', {
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
    await expect(tabs(window)).toHaveCount(4);

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
    await expect(closers).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
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
    await expect(tabs(window)).toHaveCount(3);
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
    launched,
    workspace,
  }) => {
    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await openFromLibrary(window, first.id);
    await openFromLibrary(window, second.id);
    await expect(tabs(window)).toHaveCount(3);

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

    // Three: two documents and the library the app opened on, which is a tab too (`U15`).
    expect(geometry.tabs).toHaveLength(3);
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
    // The second tab in the strip, because the first is the library the app opened on and
    // this assertion is about landing on a *document*.
    const firstTab = tabs(window).nth(1);
    await expect(firstTab).toHaveClass(/dv-inactive-tab/);
    const drawn = geometry.tabs[1];
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

    // …and a group with more tabs than it has room for draws them at that same height.
    //
    // Found by opening five papers: dockview asks for a 3px overlay scrollbar, Chromium ignores
    // both halves of that request — `overflow: overlay` is gone and `::-webkit-scrollbar` is
    // ignored wherever `scrollbar-width` is declared — and the classic bar it drew instead took
    // eleven pixels out of every tab in the group. Beside a group whose tabs had not overflowed,
    // the difference was plain. So: the strip really does overflow here, no bar is in its
    // layout, and the tabs are the height they were when there were two of them.
    //
    // Every file in the library, because six no longer overflow anything: a tab gives way
    // before the strip does now (`U13`), so six of them shrink to fit and the state this half
    // is about — a strip with more in it than it can draw — takes a full shelf to reach.
    const tall = Math.round(drawn.height);
    for (const document of workspace.documents) {
      await openFromLibrary(window, document.id);
    }
    await expect(tabs(window)).toHaveCount(workspace.documents.length + 1);
    // Narrowed until they genuinely do not fit. A tab gives way before the strip does now
    // (`U13`), so a shelf of them shrinks rather than overflowing until the window is small
    // enough that shrinking has run out — which is the state this half is about.
    await resizeWindow(launched, 900, 800);
    const readStrip = async (): Promise<{
      readonly scrollWidth: number;
      readonly clientWidth: number;
      readonly lostToTheBar: number;
      readonly tabs: readonly number[];
    } | null> =>
      window.evaluate(() => {
        const container = document.querySelector(
          '[data-testid="dockview-container"] .dv-tabs-container',
        );
        if (container === null) return null;
        return {
          scrollWidth: container.scrollWidth,
          clientWidth: container.clientWidth,
          lostToTheBar: (container as HTMLElement).offsetHeight - container.clientHeight,
          tabs: [...container.querySelectorAll('.dv-tab')].map((tab) =>
            Math.round(tab.getBoundingClientRect().height),
          ),
        };
      });

    // Polled, because dockview lays its groups out from a `ResizeObserver`: the page knowing
    // its new width and the strip having been laid out at that width are different frames.
    await expect
      .poll(
        async () => {
          const measured = await readStrip();
          return measured === null ? 0 : measured.scrollWidth - measured.clientWidth;
        },
        { message: 'a full shelf of tabs did not overflow the strip', timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    const strip = await readStrip();
    expect(strip).not.toBeNull();
    if (strip === null) return;
    expect(strip.lostToTheBar, 'a scrollbar is taking height out of the tab strip').toBe(0);
    for (const [index, height] of strip.tabs.entries()) {
      expect(height, `tab ${String(index)} of an overflowing strip is drawn shorter`).toBe(tall);
    }
  });
});

/**
 * Where the active tab is, relative to the strip that holds it and to the window.
 *
 * Read in one evaluation because these numbers are only comparable if they were taken in the
 * same frame: a relayout between two `boundingBox` calls is exactly the state this is about.
 */
interface StripGeometry {
  readonly overflowLeft: number;
  readonly overflowRight: number;
  /** How much of the strip cannot be drawn at once. Zero when every tab fits. */
  readonly hidden: number;
  readonly centreWidth: number;
  readonly centreRight: number;
  readonly windowWidth: number;
}

async function stripGeometry(window: Page): Promise<StripGeometry | null> {
  return window.evaluate(() => {
    const strip = document.querySelector('[data-testid="dockview-container"] .dv-tabs-container');
    const active = document.querySelector(
      '[data-testid="dockview-container"] .dv-tabs-container > .dv-tab.dv-active-tab',
    );
    const centre = document.querySelector('[data-testid="dockview-container"]');
    if (strip === null || active === null || centre === null) return null;
    const stripBox = strip.getBoundingClientRect();
    const tabBox = active.getBoundingClientRect();
    const centreBox = centre.getBoundingClientRect();
    return {
      overflowLeft: stripBox.left - tabBox.left,
      overflowRight: tabBox.right - stripBox.right,
      hidden: strip.scrollWidth - strip.clientWidth,
      centreWidth: centreBox.width,
      centreRight: centreBox.right,
      windowWidth: window.innerWidth,
    };
  });
}

/**
 * Nothing renders off the page (`U13`).
 *
 * The second tab report. `U12` fixed the band the strip is drawn in; what the researcher was
 * still losing was the tab of the document they had just opened. Three things composed into
 * it: dockview pins every tab at `flex-shrink: 0`, so five capped tabs already overflowed a
 * 1087px strip; `U12`'s fix took the scrollbar away, which was the only thing on screen that
 * said the strip had more in it; and dockview does *not* scroll the active tab into view —
 * there is no `scrollIntoView` and no `scrollLeft` write anywhere in the library, so nothing
 * ever brought a tab back. The eighth tab was measured 806px past the strip's right edge.
 *
 * Asserted as "the tab in front is inside the strip it is in", which is the property. The
 * obvious assertion — that nothing leaves the viewport — is vacuous here: `html, body, #root`
 * are all `overflow: hidden`, so everything that escapes is silently clipped and such a test
 * passes while the researcher cannot find their document.
 *
 * The second half is the workspace itself. The two sidebars and the strip below could be
 * dragged to a combined 1438px, which at a 1440px window left the Dockview container two
 * pixels wide with its group drawn outside it. They are tabs now (`U15`), so no arrangement of
 * the furniture can do it, and the floor is measured at each size rather than assumed.
 */
test('[U13] keeps the tab in front inside the strip, at every window size', async ({
  window,
  launched,
  workspace,
}) => {
  // A workspace with more in it than a strip can draw. The pages first — every one of these
  // is a tab now (`U15`), the library the app opened on included — and then every file in the
  // library, so the file opened last is the tab at the far right, which is the one the
  // researcher lost.
  expect(workspace.documents.length).toBeGreaterThan(2);
  for (const button of [
    'activity-notebooks',
    'activity-questions',
    'activity-search',
  ] as const) {
    await window.locator(`[data-testid="${button}"]`).click();
  }
  await window.locator('[data-testid="status-guide"]').click();
  await window.locator('[data-testid="status-help"]').click();
  for (const document of workspace.documents) {
    await openFromLibrary(window, document.id);
  }
  await expect(tabs(window)).toHaveCount(workspace.documents.length + 6);

  const last = workspace.documents[workspace.documents.length - 1];
  expect(last).toBeDefined();
  if (last === undefined) return;

  // Down to the smallest window the app allows, because that is where the strip genuinely
  // runs out of room: a tab shrinks before the strip overflows now, so a wide window with a
  // full shelf tests nothing about scrolling one back.
  let everOverflowed = false;
  for (const [width, height] of [
    [1440, 900],
    [1100, 800],
    [900, 700],
  ] as const) {
    const size = `${String(width)}x${String(height)}`;
    await resizeWindow(launched, width, height);

    // Two things a hand can always reach for, whatever the strip is doing: the surface the
    // activity bar puts in front, and a document opened from it.
    await window.locator('[data-testid="activity-library"]').click();
    await expect(window.locator('[data-testid="library-panel"]')).toBeVisible();
    await showLibrary(window);
    await window
      .locator(`[data-testid="library-panel"] [data-testid="library-item-${last.id}"]`)
      .click();

    await expect
      .poll(async () => (await stripGeometry(window))?.overflowRight ?? Number.NaN, {
        message: `the tab in front is drawn past the strip's right edge at ${size}`,
        timeout: 10_000,
      })
      .toBeLessThanOrEqual(1);

    const measured = await stripGeometry(window);
    expect(measured, `no active tab at ${size}`).not.toBeNull();
    if (measured === null) continue;

    // Inside the strip on the other side too — scrolling one tab in must not push it out.
    expect(measured.overflowLeft, `the tab in front starts left of the strip at ${size}`)
      .toBeLessThanOrEqual(1);
    if (measured.hidden > 0) everOverflowed = true;

    // And the workspace has room to be a workspace, at every size.
    expect(
      measured.centreWidth,
      `the workspace is ${String(Math.round(measured.centreWidth))}px wide at ${size}`,
    ).toBeGreaterThan(measured.windowWidth * 0.7);
    expect(measured.centreRight, `the workspace is drawn past the window at ${size}`)
      .toBeLessThanOrEqual(measured.windowWidth + 1);
  }

  // And the claim was worth making: at one of those sizes the strip really did hold more than
  // it could draw. Without this the whole test passes vacuously the day tabs stop overflowing,
  // which is exactly the state the scroll-back it asserts is invisible in.
  expect(everOverflowed, 'no window size filled the strip, so nothing was scrolled back').toBe(
    true,
  );
});
