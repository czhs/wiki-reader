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
 */
import { test, expect } from './support/app.js';
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
    // reader must never make, and it would show up as text outside the frame.
    const outsideTheFrame = await window
      .locator(`[data-testid="html-reader"][data-document-id="${savedPageOf(workspace)}"]`)
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
