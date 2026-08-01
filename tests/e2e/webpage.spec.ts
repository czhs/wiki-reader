/**
 * Reading a saved web page, against a real Electron process.
 *
 * The criterion is "renders as the original, loading its own images and CSS", and the last
 * clause is the one with teeth. Markup alone would render from an inlined string; what proves
 * the *original* is on screen is that the page's separate stylesheet took effect and its
 * separate image has pixels — both asked for by the page itself, by relative path, from its
 * own origin, through the protocol handler that bounds them to its snapshot.
 *
 * So the assertions are about loaded resources rather than about text: a computed font that
 * only `assets/page.css` sets, and an image whose `naturalWidth` is non-zero only once the
 * bytes have arrived and decoded. Neither can be satisfied by a fallback rendering.
 *
 * The second test is the other half of the same criterion. This markup came off the open web:
 * it carries an external script, an inline script and a tracking pixel, because saved pages
 * do. None of them may run, and none of them may reach the network.
 *
 * The third is `H01`: marking one up. The two above are exactly why that was broken — the
 * frame that makes the page render as itself is also a frame the application cannot see a
 * selection inside. This one proves the way round it, without loosening either.
 */
import { test, expect, launchApp, type LaunchedApp } from './support/app.js';
import type { FrameLocator, Page } from '@playwright/test';

/** Open a document from the library sidebar and wait for the saved page to be framed. */
async function openSavedPage(page: Page, documentId: string): Promise<FrameLocator> {
  const row = page.locator(
    `[data-testid="library-sidebar"] [data-testid="library-item-${documentId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const reader = page.locator(`[data-testid="html-reader"][data-document-id="${documentId}"]`);
  await expect(reader).toBeVisible({ timeout: 30_000 });
  return reader.frameLocator('[data-testid="snapshot-frame"]');
}

/** The one saved page the fixture library holds. */
function savedPageOf(workspace: { readonly webpageDocuments: readonly { id: string }[] }): string {
  const [saved] = workspace.webpageDocuments;
  if (saved === undefined) throw new Error('the workspace seeded no saved web page');
  return saved.id;
}

test.describe('reading a saved web page', () => {
  test('[W03] renders the archived page as the original, with its own images and CSS', async ({
    window,
    workspace,
  }) => {
    const frame = await openSavedPage(window, savedPageOf(workspace));

    // The page's own markup, rendered as itself rather than summarized.
    const heading = frame.locator('[data-testid="snapshot-heading"]');
    await expect(heading).toHaveText(workspace.snapshot.heading);
    await expect(frame.locator('body')).toContainText(workspace.snapshot.bodyText);

    // `assets/page.css` is a separate file the page asks for by relative path. Without it the
    // heading falls back to the frame's default family, and this string is not in it.
    await expect
      .poll(
        () =>
          heading.evaluate(
            (element) =>
              element.ownerDocument.defaultView?.getComputedStyle(element).fontFamily ?? '',
          ),
        { timeout: 15_000, message: "the snapshot's own stylesheet never applied" },
      )
      .toContain(workspace.snapshot.headingFontFamily);

    // And the image beside it. A broken image still occupies a DOM node; only a decoded one
    // has a natural size, so this is the assertion that the bytes arrived.
    await expect
      .poll(
        () => frame.locator('#figure').evaluate((image: HTMLImageElement) => image.naturalWidth),
        { timeout: 15_000, message: "the snapshot's own image never loaded" },
      )
      .toBe(workspace.snapshot.figureWidth);

    // The reading view is the page and nothing else. Extracted text exists for search and
    // anchoring; a panel that also rendered it here would be the silent substitution the
    // reader must never make, and it would show up as text beside the frame. Asked of the
    // reading surface rather than of the whole reader, because the reader also carries the
    // zoom lever (`V04`) — chrome the researcher operates, not a rendering of the document.
    const outsideTheFrame = await window
      .locator(`[data-testid="html-reader"][data-document-id="${savedPageOf(workspace)}"]`)
      .locator('[data-testid="snapshot-viewport"]')
      .innerText();
    expect(outsideTheFrame.trim()).toBe('');
    await expect(window.locator('[data-testid="html-reader-error"]')).toHaveCount(0);
  });

  test('[W03] runs none of the archived page’s scripts and lets none of its requests out', async ({
    window,
    workspace,
  }) => {
    // Responses rather than requests: a request cancelled in the main process may still be
    // seen being issued, but it never comes back. "Nothing remote ever answered" is the
    // claim worth making, and it is the one that fails if the block is removed.
    const answered: string[] = [];
    window.on('response', (response) => {
      const url = response.url();
      if (url.startsWith('http://localhost')) return; // the dev server, when one is running
      if (/^https?:\/\//.test(url)) answered.push(url);
    });

    const frame = await openSavedPage(window, savedPageOf(workspace));
    await expect(frame.locator('[data-testid="snapshot-heading"]')).toHaveText(
      workspace.snapshot.heading,
    );

    // The inline script sets `document.title`. The title staying as the page's own is what
    // says the empty `sandbox` attribute — and the CSP served with the bytes — both held.
    await expect
      .poll(() => frame.locator('body').evaluate((element) => element.ownerDocument.title), {
        timeout: 10_000,
      })
      .toBe(workspace.snapshot.heading);

    // The tracking pixel is a real remote URL in the markup. Zero natural width means it
    // never loaded — the user's reading was not reported to anyone.
    expect(
      await frame.locator('#tracker').evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBe(0);

    expect(answered, 'the archived page reached the network').toEqual([]);
  });
});

/**
 * Select a paragraph of the archived page and ask for its context menu, the way a reader does.
 *
 * The selection is made with a real DOM Range *inside the frame* — which Playwright can do
 * through CDP and the application deliberately cannot — and the right-click is a real mouse
 * gesture on the selected words. Nothing here reaches into the app: the only thing the test
 * arranges is the state a person's hand would leave behind.
 */
async function selectAndInvoke(
  window: Page,
  documentId: string,
  frame: FrameLocator,
): Promise<string> {
  const paragraph = frame.locator('p').first();
  await expect(paragraph).toBeVisible({ timeout: 30_000 });

  const inside = await paragraph.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = view?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const box = element.getBoundingClientRect();
    return { text: selection?.toString() ?? '', x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  expect(inside.text.trim().length).toBeGreaterThan(12);

  // The right-click has to land *inside* the selection, or Chromium drops it before the menu
  // is asked for — and where "inside" is on screen is not where Playwright's own hit-testing
  // puts it, because the reader lays the frame out at desktop width and scales it down to fit
  // the panel (`HtmlReaderView` says why). So the point is computed the same way the reader
  // draws it: the frame's own coordinates through the scale the panel published.
  const frameBox = await window.locator('[data-testid="snapshot-frame"]').boundingBox();
  const scale = Number(
    await window
      .locator(`[data-testid="html-reader"][data-document-id="${documentId}"]`)
      .getAttribute('data-snapshot-scale'),
  );
  if (frameBox === null || !Number.isFinite(scale)) throw new Error('the snapshot is not on screen');

  await window.mouse.click(frameBox.x + inside.x * scale, frameBox.y + inside.y * scale, {
    button: 'right',
  });
  return inside.text;
}

test.describe('highlighting a saved web page', () => {
  test('[H01] a highlight is made on a saved web page, and it survives restart', async ({
    workspace,
  }) => {
    const documentId = savedPageOf(workspace);
    let quoted: string;

    const first: LaunchedApp = await launchApp(workspace);
    try {
      const window = first.window;
      const frame = await openSavedPage(window, documentId);

      // Nothing is marked up yet, so there is no strip beside the page at all.
      await expect(window.locator('[data-testid="article-highlights"]')).toHaveCount(0);

      // …but the gesture is on screen. Every other reader raises its bar on mouseup; a saved
      // page cannot, because the archive is framed with no script and no origin to speak from,
      // so the selection is only legible to the main process's context menu. A reader who is
      // not told that finds a page where the thing they have learned everywhere else does
      // nothing, which from the outside is the bug `H01` was written to fix.
      const hint = window.locator('[data-testid="article-highlight-hint"]');
      await expect(hint).toBeVisible();
      await expect(hint).toContainText('right-click');

      quoted = await selectAndInvoke(window, documentId, frame);

      // The selection crossed out of the frame: the panel is offering to keep the words the
      // reader chose, quoted back at them.
      const bar = window.locator('[data-testid="article-selection-toolbar"]');
      await expect(bar).toBeVisible({ timeout: 15_000 });
      await expect(bar).toContainText(workspace.snapshot.bodyText.slice(0, 40));

      await window.locator('[data-testid="create-highlight"]').click();
      await expect(bar).toHaveCount(0);
      // The bar gone, the instruction back: the strip is one place, saying whichever of the
      // two things is true now.
      await expect(window.locator('[data-testid="article-highlight-hint"]')).toBeVisible();

      const chip = window.locator('[data-testid="article-highlights"] button');
      await expect(chip).toHaveCount(1);
      await expect(chip.first()).toContainText(workspace.snapshot.bodyText.slice(0, 40));
      // Resolved against the archive's own bytes, not merely stored: the anchor was re-found
      // in the text extracted from the snapshot on disk.
      await expect(chip.first()).toHaveAttribute('data-resolved', 'true');
    } finally {
      await first.app.close();
    }

    // A second process, which has never seen the selection or the click.
    const second: LaunchedApp = await launchApp(workspace);
    try {
      const window = second.window;
      await openSavedPage(window, documentId);

      const chip = window.locator('[data-testid="article-highlights"] button');
      await expect(chip).toHaveCount(1, { timeout: 30_000 });
      await expect(chip.first()).toContainText(quoted.trim().slice(0, 40));
      // And it still points at the same sentence in the page as it stands now — a highlight
      // that survived as a row but no longer resolves is not a highlight that survived.
      await expect(chip.first()).toHaveAttribute('data-resolved', 'true');

      // The page is still the page. Nothing was painted into the archive, and nothing about
      // marking it up put text inside the reading surface.
      const insideTheReader = await window
        .locator(`[data-testid="html-reader"][data-document-id="${documentId}"]`)
        .locator('[data-testid="snapshot-viewport"]')
        .innerText();
      expect(insideTheReader.trim()).toBe('');
    } finally {
      await second.app.close();
    }
  });
});

/**
 * How big the page's own body text actually is on screen, in the window's pixels.
 *
 * The frame is laid out at desktop width and drawn through a transform, so the font size the
 * archived document reports is not the size anybody reads it at: the two have to be multiplied.
 * This is the number the criterion is about — "stays readable at half-screen width" is a claim
 * about millimetres on glass, not about a CSS declaration inside a frame.
 */
async function renderedTextPx(
  window: Page,
  documentId: string,
  frame: FrameLocator,
): Promise<number> {
  const inFrame = await frame.locator('p').first().evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    return Number.parseFloat(view?.getComputedStyle(element).fontSize ?? '0');
  });
  const scale = Number(
    await window
      .locator(`[data-testid="html-reader"][data-document-id="${documentId}"]`)
      .getAttribute('data-snapshot-scale'),
  );
  return inFrame * scale;
}

test.describe('reading a saved page in a narrow panel', () => {
  test('[V04] the researcher holds a zoom lever, and the page comes back at the size they left it', async ({
    workspace,
  }) => {
    const documentId = savedPageOf(workspace);
    // Measured in the first process and compared in the second: the size the page is read at
    // depends on the panel, so what the restart has to reproduce cannot be predicted here.
    let zoomedText: number | undefined;

    const first: LaunchedApp = await launchApp(workspace);
    try {
      const window = first.window;
      const frame = await openSavedPage(window, documentId);
      await expect(frame.locator('[data-testid="snapshot-heading"]')).toBeVisible({
        timeout: 30_000,
      });
      const reader = window.locator(
        `[data-testid="html-reader"][data-document-id="${documentId}"]`,
      );

      // The complaint this criterion answers: the panel is narrower than the width the page
      // is laid out at, so the page is shrunk, and nothing about that was the reader's to
      // decide. Everything below is about that shrink and not about the layout width.
      const fit = Number(await reader.getAttribute('data-snapshot-fit'));
      expect(fit, 'this test is pointless unless the page is being shrunk').toBeLessThan(1);
      await expect(reader).toHaveAttribute('data-snapshot-zoom', '1');
      await expect(reader).toHaveAttribute('data-snapshot-scale', fit.toFixed(3));

      const fitted = await renderedTextPx(window, documentId, frame);
      expect(fitted).toBeGreaterThan(0);

      // The lever. Two steps up, through the control a reader would press.
      const lever = window.locator('[data-testid="snapshot-zoom"]');
      await expect(lever).toBeVisible();
      await window.locator('[data-testid="snapshot-zoom-in"]').click();
      await expect(reader).toHaveAttribute('data-snapshot-zoom', '1.5');
      await window.locator('[data-testid="snapshot-zoom-in"]').click();
      await expect(reader).toHaveAttribute('data-snapshot-zoom', '2');

      // Bigger on screen — measured through the page's own text, because a panel that
      // recorded a zoom it did not draw would satisfy the attribute alone.
      zoomedText = await renderedTextPx(window, documentId, frame);
      expect(zoomedText).toBeGreaterThan(fitted * 1.8);
      // At the size the page was written for, or larger. This is the readability the
      // criterion asks for: a half-width panel no longer means five-pixel body text.
      expect(zoomedText).toBeGreaterThanOrEqual(fitted / fit - 0.5);

      // And the page kept its desktop layout at every step. Zooming must not be a narrower
      // viewport in disguise: that is what makes an archived page drop its navigation.
      const laidOutAt = await frame.locator('body').evaluate(() => window.innerWidth);
      expect(laidOutAt).toBeGreaterThanOrEqual(1280);

      // The published scale is the effective one — fit times lever — so everything that
      // computes a point inside the frame from it still lands on the words.
      const zoomed = Number(await reader.getAttribute('data-snapshot-scale'));
      expect(zoomed).toBeCloseTo(fit * 2, 2);
      const frameBox = await window.locator('[data-testid="snapshot-frame"]').boundingBox();
      expect(frameBox).not.toBeNull();
      if (frameBox === null) return;
      expect(frameBox.width).toBeCloseTo(laidOutAt * zoomed, -1);

      // The way back is one press, and it says where it goes.
      await window.locator('[data-testid="snapshot-zoom-reset"]').click();
      await expect(reader).toHaveAttribute('data-snapshot-zoom', '1');
      await expect(reader).toHaveAttribute('data-snapshot-scale', fit.toFixed(3));

      // Left where the researcher wants it, and given time to be written down.
      await window.locator('[data-testid="snapshot-zoom-in"]').click();
      await window.locator('[data-testid="snapshot-zoom-in"]').click();
      await expect(reader).toHaveAttribute('data-snapshot-zoom', '2');
      await window.waitForTimeout(1_500);
    } finally {
      await first.app.close();
    }

    // A second process, which has never seen the lever pressed. The setting is the panel's
    // own — two saved pages side by side are read at two sizes — so it comes back with the
    // panel rather than as a preference somewhere else.
    if (zoomedText === undefined) throw new Error('the first run measured nothing to compare');
    const second: LaunchedApp = await launchApp(workspace);
    try {
      const window = second.window;
      const reader = window.locator(
        `[data-testid="html-reader"][data-document-id="${documentId}"]`,
      );
      await expect(reader).toBeVisible({ timeout: 30_000 });
      await expect(reader).toHaveAttribute('data-snapshot-zoom', '2', { timeout: 30_000 });

      const frame = reader.frameLocator('[data-testid="snapshot-frame"]');
      await expect(frame.locator('[data-testid="snapshot-heading"]')).toBeVisible({
        timeout: 30_000,
      });
      const back = await renderedTextPx(window, documentId, frame);
      expect(back).toBeGreaterThan(zoomedText * 0.9);
      expect(back).toBeLessThan(zoomedText * 1.1);
    } finally {
      await second.app.close();
    }
  });
});
