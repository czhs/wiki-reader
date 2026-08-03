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
import { selectAndInvoke } from './support/archive.js';
import { contrastOf } from './support/contrast.js';
import type { FrameLocator, Page } from '@playwright/test';

/** Open a document from the library sidebar and wait for the saved page to be framed. */
async function openSavedPage(page: Page, documentId: string): Promise<FrameLocator> {
  const row = page.locator(
    `[data-testid="library-panel"] [data-testid="library-item-${documentId}"]`,
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
 * What the archive is showing of a mark, asked of the frame's own document.
 *
 * Everything here is a question a reader could answer by looking: is there a mark, is it on
 * the paragraph, has it any size, what colour is it. `document.title` comes back with them
 * because it is the page's proof that its scripts still did not run — the inline one in this
 * fixture sets the title, and painting the page must not have been the thing that let it.
 */
async function paintedMark(frame: FrameLocator): Promise<{
  readonly text: string;
  readonly onTheParagraph: boolean;
  readonly width: number;
  readonly background: string;
  readonly title: string;
}> {
  return frame.locator('mark[data-wr-annotation]').first().evaluate((mark) => {
    const paragraph = mark.closest('p');
    const markBox = mark.getBoundingClientRect();
    const paragraphBox = paragraph?.getBoundingClientRect();
    const view = mark.ownerDocument.defaultView;
    return {
      text: (mark.textContent ?? '').trim(),
      onTheParagraph:
        paragraphBox !== undefined &&
        markBox.top >= paragraphBox.top - 1 &&
        markBox.bottom <= paragraphBox.bottom + 1,
      width: markBox.width,
      background: view?.getComputedStyle(mark).backgroundColor ?? '',
      title: mark.ownerDocument.title,
    };
  });
}

test.describe('a highlight on the saved page itself', () => {
  test('[H10] a mark made on a saved page is painted on the page, and is still there after a restart', async ({
    workspace,
  }) => {
    const documentId = savedPageOf(workspace);
    let quoted: string;

    const first: LaunchedApp = await launchApp(workspace);
    try {
      const window = first.window;
      const frame = await openSavedPage(window, documentId);
      await expect(frame.locator('[data-testid="snapshot-heading"]')).toBeVisible({
        timeout: 30_000,
      });

      // Nothing marked yet, so nothing painted. The page is the page.
      await expect(frame.locator('mark[data-wr-annotation]')).toHaveCount(0);

      quoted = await selectAndInvoke(window, documentId, frame);
      await expect(window.locator('[data-testid="article-selection-toolbar"]')).toBeVisible({
        timeout: 15_000,
      });
      await window.locator('[data-testid="create-highlight"]').click();

      // The archive is framed with `sandbox` and no tokens: there is no script inside it to
      // draw anything and no origin from which the application could reach in. So the mark
      // arrives the only way it can — in the bytes, painted by the process that serves them,
      // and the frame fetches the page again to show it.
      await expect(frame.locator('mark[data-wr-annotation]')).toHaveCount(1, { timeout: 20_000 });

      const painted = await paintedMark(frame);
      expect(painted.text).toBe(quoted.trim());
      // Where the text is: on the paragraph the words were selected in, with a real size and
      // the highlight palette's own colour under it — not a list beside the page.
      expect(painted.onTheParagraph).toBe(true);
      expect(painted.width).toBeGreaterThan(0);
      expect(painted.background).toBe('rgb(243, 227, 168)');
      // And the page is still script-free. Painting granted the archive nothing: the inline
      // script that would rename this document still did not run.
      expect(painted.title).toBe(workspace.snapshot.heading);

      // The strip beside the page stays, and it is not a duplicate: a mark cannot say that it
      // failed to resolve, and an unpainted sentence looks exactly like a page with nothing on
      // it. The strip is where a highlight that no longer lands says so.
      const chip = window.locator('[data-testid="article-highlights"] button');
      await expect(chip).toHaveCount(1);
      // …and it can be read. A chip is painted in the highlight's own colour, which is a paper
      // colour; it was drawn in the chrome's ink, which is chosen for the chrome's near-black,
      // and the quote came out at 1.3:1 — there in the DOM, invisible on the screen, exactly
      // the failure `[UX01]` exists for one surface over.
      expect(
        await contrastOf(chip.first()),
        'the quote on a highlight chip cannot be read against the chip',
      ).toBeGreaterThanOrEqual(4.5);
    } finally {
      await first.app.close();
    }

    // A second process, which never saw the selection, the click, or the page it painted.
    const second: LaunchedApp = await launchApp(workspace);
    try {
      const window = second.window;
      const frame = await openSavedPage(window, documentId);
      await expect(frame.locator('mark[data-wr-annotation]')).toHaveCount(1, { timeout: 30_000 });

      const painted = await paintedMark(frame);
      expect(painted.text).toBe(quoted.trim());
      expect(painted.onTheParagraph).toBe(true);
      expect(painted.title).toBe(workspace.snapshot.heading);

      // Nothing was written into the archive to achieve any of this. The mark is re-derived
      // from the anchor every time the page is served, which is why a highlight whose words
      // have gone comes back as no mark rather than as a mark in the wrong place.
      await expect(frame.locator('[data-testid="snapshot-heading"]')).toHaveText(
        workspace.snapshot.heading,
      );
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
