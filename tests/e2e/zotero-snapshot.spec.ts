/**
 * A Zotero snapshot renders as what Zotero saved.
 *
 * `[W03]` covers a saved page laid out as an entry document plus a folder of assets. That is
 * not the shape Zotero produces. Across a real 28-snapshot library every one is a *single*
 * HTML file with nothing beside it but `.zotero-ft-cache`: the CSS is inlined as `<style>`
 * (795 blocks) and `style=` attributes (1954), the fonts are inlined as `data:` URIs (418 of
 * 418), and the images are inlined as `data:` too (284). Zotero saves with high fidelity by
 * inlining, so what the reader has to get right is inline content, not asset resolution.
 *
 * The one thing that stays out is the network, and in that same library every remote
 * reference is an ad, an analytics beacon, or a tracking pixel — doubleclick, smetrics,
 * facebook `tr?id=`. Blocking them costs nothing a reader would notice and is the reason the
 * reading list does not leave the machine.
 */
import { test, expect } from './support/app.js';
import { launchApp, resizeWindow } from './support/app.js';
import { writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A 2x1 PNG, so a loaded image is distinguishable from a broken one by its dimensions. */
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M+AFzCOKgAAaqgD/a4M+9UAAAAASUVORK5CYII=';

/**
 * A minimal WOFF the browser will actually parse, inlined the way Zotero inlines fonts.
 *
 * Its metrics do not matter — what is asserted is that the `@font-face` rule was allowed to
 * load at all, which is what `font-src` decides.
 */
const FONT_DATA_URI =
  'data:font/woff2;base64,d09GMgABAAAAAAKAAA0AAAAABswAAAIpAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhYbg1gcgQYGYACCUhEICoRshF4LGAABNgIkAyQEIAWDAgcgG7AGyJ4H2LZtEfEIiwPYtm3btm3btm3btm3btm3bxv//f5KkSZo0adKkSZMmTZo0/9//NfV/1V0zu6vqrpndVXfN7K66a2Z31V0zu6vumtlddVfd1XVX1VVXVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

/** Every HTML attachment the workspace materialised, so its bytes can be replaced. */
function htmlAttachmentPaths(zoteroDataDir: string): string[] {
  const out: string[] = [];
  const storage = join(zoteroDataDir, 'storage');
  for (const key of readdirSync(storage)) {
    const dir = join(storage, key);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name.toLowerCase().endsWith('.html')) out.push(join(dir, name));
    }
  }
  return out;
}

/**
 * A single-file snapshot of the shape Zotero writes: everything inlined, plus the ads and
 * beacons that came along with the article and must not fire.
 */
function zoteroShapedSnapshot(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Structural phylogenetics unravels the evolutionary history</title>',
    '<style>',
    `@font-face { font-family: "SnapshotSerif"; src: url("${FONT_DATA_URI}") format("woff2"); }`,
    'body { margin: 0; background: #fdfdfb; }',
    '.article { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem; }',
    'h1 { font-family: "SnapshotSerif", Georgia, serif; font-size: 2.5rem; letter-spacing: -0.02em; }',
    '.lede { color: rgb(17, 85, 170); font-size: 1.25rem; }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="article">',
    '<h1 data-testid="snapshot-heading">Structural phylogenetics unravels the evolutionary history</h1>',
    '<p class="lede" style="font-style: italic;">Fold comparison recovers relationships that sequence alone cannot.</p>',
    `<img id="inline-figure" src="${PNG_DATA_URI}" alt="A structural alignment">`,
    // Everything below is what a real snapshot carries and must never reach the network.
    '<img id="ad" src="https://pubads.g.doubleclick.net/gampad/ad?iu=/6839/journal" alt="" width="728" height="90">',
    '<img id="beacon" src="https://smetrics.elsevier.com/b/ss/elsevier-sd-prod/1/G.4--NS/1726969102569" alt="" width="1" height="1">',
    '<img id="pixel" src="https://www.facebook.com/tr?id=0&ev=PageView&noscript=1" alt="" width="1" height="1">',
    '<link rel="stylesheet" href="https://cdn.ncbi.nlm.nih.gov/pubmed/core/no-script.css">',
    '<script src="https://cdn.invalid/analytics.js"></script>',
    '<script>document.title = "scripts ran";</script>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

test('[UX08] a saved page is laid out at desktop width however narrow the panel is', async ({
  window,
  launched,
  workspace,
}) => {
  // A page chooses its layout from its own media queries against the viewport it is given.
  // A reading panel is narrower than the breakpoint most sites use, so an archived desktop
  // page rendered its *phone* layout and dropped its navigation and table of contents. The
  // frame is laid out at `DESKTOP_WIDTH_PX` and scaled to fit instead.
  // A reading panel narrower than the breakpoint. The library sidebar used to make it so;
  // there are no sidebars (`U15`), so the window is what sets a panel's width now.
  await resizeWindow(launched, 900, 700);
  await window.locator(`[data-testid="library-item-${workspace.webpageDocuments[0]!.id}"]`).click();
  await window.waitForSelector('[data-testid="snapshot-frame"]', { timeout: 60_000 });
  await window.waitForTimeout(1500);

  const panelWidth = await window
    .locator('[data-testid="html-reader"]')
    .evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const laidOutAt = await window
    .frameLocator('[data-testid="snapshot-frame"]')
    .locator('body')
    .evaluate(() => window.innerWidth);

  expect(panelWidth, 'this test is pointless unless the panel is narrower than a desktop')
    .toBeLessThan(1280);
  expect(laidOutAt, 'the page was laid out at the panel width, so it picked its narrow layout')
    .toBeGreaterThanOrEqual(1280);

  // Scaled down to fit, never up: a panel with room shows the page pixel-exact.
  const scale = Number(
    await window.locator('[data-testid="html-reader"]').getAttribute('data-snapshot-scale'),
  );
  expect(scale).toBeLessThan(1);
  expect(scale).toBeGreaterThan(0);
  expect(Math.round(laidOutAt * scale), 'the scaled page does not fill the panel').toBeCloseTo(
    panelWidth,
    -1,
  );
});

test('[UX07] a saved page is not reloaded when the workspace re-renders around it', async ({
  window,
  workspace,
}) => {
  // The frame is pointed at the snapshot's own URL, so remounting it is a full page load:
  // the reader loses its scroll position and every image decodes again. `HtmlReaderView`
  // took `onReady`/`onError` as effect dependencies, and the panel passes a fresh arrow
  // function for `onError` on every render — so *any* workspace change re-ran the effect,
  // which sets status back to 'loading', unmounts the iframe, and reloads the page. Reading
  // a long article and touching anything sent you back to the top.
  await window.locator(`[data-testid="library-item-${workspace.webpageDocuments[0]!.id}"]`).click();
  await window.waitForSelector('[data-testid="snapshot-frame"]', { timeout: 60_000 });
  await window.waitForTimeout(1500);

  const frame = window.frameLocator('[data-testid="snapshot-frame"]');
  await expect(frame.locator('[data-testid="snapshot-heading"]')).toBeVisible();

  // A value that only survives if this document is never re-navigated.
  await frame.locator('body').evaluate(() => {
    (window as unknown as { __wrReloadProbe?: number }).__wrReloadProbe = 4242;
  });

  // Anything that re-renders the panel. Toggling a sidebar is the cheapest honest trigger;
  // a status-bar message or a selection elsewhere would do the same.
  await window.locator('[data-testid="activity-annotations"]').click();
  await window.waitForTimeout(1500);
  await window.locator('[data-testid="activity-annotations"]').click();
  await window.waitForTimeout(1500);

  const probe = await frame
    .locator('body')
    .evaluate(() => (window as unknown as { __wrReloadProbe?: number }).__wrReloadProbe ?? null);
  expect(probe, 'the saved page was reloaded by an unrelated workspace re-render').toBe(4242);
});

test('[UX06] a single-file Zotero snapshot renders with its own inlined CSS, fonts and images', async ({
  workspace,
}) => {
  const markup = zoteroShapedSnapshot();
  for (const path of htmlAttachmentPaths(workspace.zoteroDataDir)) {
    writeFileSync(path, markup, 'utf8');
  }

  const { app, window } = await launchApp(workspace);
  // Responses, not requests: a request cancelled in the main process is still observably
  // *issued*, it just never comes back. "Nothing remote answered" is the claim worth making,
  // and it is the one that fails if the block is removed. Same reasoning as `[W03]`.
  const answered: string[] = [];
  window.on('response', (response) => {
    const url = response.url();
    if (url.startsWith('http://localhost')) return; // the dev server, when one is running
    if (/^https?:\/\//.test(url)) answered.push(url);
  });

  try {
    await window.locator(`[data-testid="library-item-${workspace.webpageDocuments[0]!.id}"]`).click();
    await window.waitForSelector('[data-testid="snapshot-frame"]', { timeout: 60_000 });
    await window.waitForTimeout(3000);

    const frame = window.frameLocator('[data-testid="snapshot-frame"]');
    await expect(frame.locator('[data-testid="snapshot-heading"]')).toBeVisible();

    const rendered = await frame.locator('[data-testid="snapshot-heading"]').evaluate((heading) => {
      const lede = document.querySelector('.lede') as HTMLElement;
      const figure = document.querySelector('#inline-figure') as HTMLImageElement;
      const headingStyle = getComputedStyle(heading);
      const ledeStyle = getComputedStyle(lede);
      return {
        // The page's own `<style>` block decided all of these.
        headingFontFamily: headingStyle.fontFamily,
        headingFontSize: headingStyle.fontSize,
        headingLetterSpacing: headingStyle.letterSpacing,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        articleMaxWidth: getComputedStyle(document.querySelector('.article')!).maxWidth,
        // A `style=` attribute, which is the other half of what Zotero inlines.
        ledeFontStyle: ledeStyle.fontStyle,
        ledeColor: ledeStyle.color,
        // An inlined image really decoded, rather than showing a broken-image box.
        figureWidth: figure.naturalWidth,
        // The `@font-face` rule was allowed to load its data: source.
        fontFaceLoaded: [...document.fonts].some((f) => f.family.includes('SnapshotSerif')),
        // Scripts never ran, so the title is the saved one.
        title: document.title,
      };
    });

    expect(rendered.headingFontFamily, 'the page’s own font stack did not apply').toContain(
      'SnapshotSerif',
    );
    expect(rendered.fontFaceLoaded, 'the inlined @font-face was blocked, so the page is set in a fallback').toBe(
      true,
    );
    expect(rendered.headingFontSize).toBe('40px');
    expect(rendered.headingLetterSpacing).toBe('-0.8px');
    expect(rendered.bodyBackground).toBe('rgb(253, 253, 251)');
    expect(rendered.articleMaxWidth).toBe('736px');
    expect(rendered.ledeFontStyle, 'a style= attribute was dropped').toBe('italic');
    expect(rendered.ledeColor).toBe('rgb(17, 85, 170)');
    expect(rendered.figureWidth, 'the inlined figure did not decode').toBe(2);
    expect(rendered.title).toBe('Structural phylogenetics unravels the evolutionary history');

    // The ads, the beacon and the pixel are the only things that did not render. Zero
    // natural width on each is what says the reading was reported to nobody.
    const trackerWidths = await frame.locator('body').evaluate(() =>
      ['#ad', '#beacon', '#pixel'].map((selector) => ({
        selector,
        width: (document.querySelector(selector) as HTMLImageElement).naturalWidth,
      })),
    );
    for (const tracker of trackerWidths) {
      expect(tracker.width, `${tracker.selector} loaded`).toBe(0);
    }

    expect(answered, 'the archived page reached the network').toEqual([]);
  } finally {
    await app.close();
  }
});
