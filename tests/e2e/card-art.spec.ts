/**
 * The icon picker is a gallery of the set's art (criterion `B06`).
 *
 * The control this replaced was a text field that took a card's *name*. It worked, and it could
 * only be used by somebody who already knew several hundred names — a picker you have to know
 * the answer to. The criterion is that it becomes a gallery you scroll and press, that what is
 * shown is *art crops* rather than whole cards, and that everything is kept here after the first
 * time.
 *
 * Nothing in this spec reaches the network, and that is not a compromise: the cache is seeded
 * before the app starts, keyed exactly the way the application keys it, so the running app finds
 * every picture already on its own disk and never asks for one. What is exercised is therefore
 * the whole of the real path except the socket — the listing is parsed, the crops are resolved
 * through the database and streamed over `rrfile://`, and the disclosure and the switch stand
 * where they always did in front of all of it.
 *
 * `seedCardArtCache` computes its paths with the application's own `setListingUrl` and `artUrl`,
 * so a spec that passes is a spec whose seeding still matches what the app would fetch.
 */
import { test, expect, launchApp, type LaunchedApp } from './support/app.js';
import { openFromLibrary, waitForWikilinkEdge } from './support/corpus.js';
import { seedCardArtCache, SEEDED_CARDS } from './support/card-art.js';
import type { Locator, Page } from '@playwright/test';

/** One page of the gallery, as the panel asks for it. Kept in step with `GALLERY_PAGE`. */
const PAGE = 12;

/** Read the disclosure, then turn the switch on — the order the panel enforces. */
async function turnCardArtOn(window: Page): Promise<Locator> {
  await window.locator('[data-testid="graph-card-art-read"]').click();
  const disclosure = window.locator('[data-testid="card-art-disclosure"]');
  await expect(disclosure).toBeVisible();
  await window.locator('[data-testid="graph-card-art-on"]').click();
  const gallery = window.locator('[data-testid="card-art-gallery"]');
  await expect(gallery).toBeVisible();
  return gallery;
}

test('[B06] the icon picker is a scrolling gallery of art crops, drawn from this disk', async ({
  workspace,
}) => {
  // Seeded before the app exists, so every picture the gallery wants is already here. Eight
  // illustrations against a page of twelve, so the whole set arrives in one page and the
  // scroller has something to scroll.
  seedCardArtCache(workspace);
  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    const { documents } = await waitForWikilinkEdge(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    if (source === undefined) throw new Error('the corpus did not produce its page');

    await openFromLibrary(window, source.id);
    await window.locator('[data-testid="activity-graph"]').click();
    const graph = window.locator('[data-testid="graph-panel"]');
    await expect(graph).toBeVisible();

    // Before the switch, there is no gallery — only the offer to read what one would cost.
    await expect(window.locator('[data-testid="graph-card-art"]')).toHaveAttribute(
      'data-card-art',
      'off',
    );
    await expect(window.locator('[data-testid="card-art-gallery"]')).toHaveCount(0);

    // The disclosure says the list of cards is one of the things that leaves this machine, and
    // that the whole card never comes back. Read off the page, because that is where a person
    // reads it — the prose is the main process's and the panel prints it verbatim.
    await window.locator('[data-testid="graph-card-art-read"]').click();
    const sends = window.locator('[data-testid="card-art-disclosure-sends"]');
    await expect(sends).toContainText('Modern Horizons 3');
    await expect(window.locator('[data-testid="card-art-disclosure-withholds"]')).toContainText(
      'whole printed card',
    );

    await window.locator('[data-testid="graph-card-art-on"]').click();
    const gallery = window.locator('[data-testid="card-art-gallery"]');
    await expect(gallery).toBeVisible();

    // Every illustration in the set, on one page, each one a picture that really loaded — the
    // element reports a load only once Chromium fetched it over `rrfile://`, which means the
    // handler resolved a file id through the database and checked its path against the roots.
    const tiles = gallery.locator('.wr-graph__gallery-tile');
    await expect(tiles).toHaveCount(Math.min(SEEDED_CARDS.length, PAGE));
    await expect(gallery).toHaveAttribute('data-total', String(SEEDED_CARDS.length));
    for (let index = 0; index < SEEDED_CARDS.length; index += 1) {
      const tile = window.locator(`[data-testid="card-art-tile-${String(index)}"]`);
      await expect(tile).toHaveAttribute('data-card-name', SEEDED_CARDS[index]?.name ?? '');
      await expect(tile).toHaveAttribute('data-loaded', 'true');
    }

    // It is a scroller: the strip is narrower than the pictures laid end to end, so the eight
    // are reached by scrolling rather than by the panel growing to hold them.
    const overflows = await gallery.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1,
    );
    expect(overflows, 'the gallery is not a scroller — it grew to fit instead').toBe(true);

    // And nothing on this panel says where a picture came from. The renderer addressed every
    // one of them by file id and was never told the rest — no host, no scheme, no path.
    const markup = await window
      .locator('[data-testid="graph-card-art"]')
      .evaluate((element) => element.outerHTML);
    expect(markup).not.toContain('https://');
    expect(markup).not.toContain('scryfall');
    expect(markup).not.toContain(workspace.dir);
  } finally {
    await launched.app.close();
  }
});

test('[B06] pressing an illustration puts it on the node, from the cache', async ({
  workspace,
}) => {
  seedCardArtCache(workspace);
  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    const { documents } = await waitForWikilinkEdge(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    if (source === undefined) throw new Error('the corpus did not produce its page');

    await openFromLibrary(window, source.id);
    await window.locator('[data-testid="activity-graph"]').click();
    const graph = window.locator('[data-testid="graph-panel"]');
    await expect(graph).toBeVisible();
    const node = graph.locator(`[data-testid="graph-node-${source.id}"]`);
    // Bare first, or nothing below distinguishes a chosen picture from a default.
    await expect(node).toHaveAttribute('data-icon-file-id', '');

    await turnCardArtOn(window);
    const tile = window.locator('[data-testid="card-art-tile-2"]');
    const fileId = (await tile.getAttribute('data-file-id')) ?? '';
    expect(fileId.length).toBeGreaterThan(0);
    await tile.click();

    // The picture the gallery was already showing is the picture the node now wears: one file,
    // one set of bytes, reused rather than fetched a second time. The status line says so.
    await expect(node).toHaveAttribute('data-icon-file-id', fileId);
    await expect(node.locator('image')).toHaveAttribute('href', `rrfile://${fileId}`);
    await expect(node).toHaveAttribute('data-icon-loaded', 'true');
    await expect(window.locator('[data-testid="status-message"]')).toContainText('already here');

    // A picture is a label, not a rename — the node is still the document it was.
    await expect(node).toHaveAttribute('data-display-name', '');
  } finally {
    await launched.app.close();
  }
});

test('[B06] the gallery pages, and turning card art off puts it away', async ({ workspace }) => {
  // Fourteen illustrations against a page of twelve, so there is a second page to ask for and
  // "More" is a control with something behind it rather than an assumption.
  const many = Array.from({ length: 14 }, (_, index) => ({
    name: `Test Illustration ${String(index + 1)}`,
    artist: `Painter ${String(index + 1)}`,
  }));
  seedCardArtCache(workspace, many);
  const launched: LaunchedApp = await launchApp(workspace);
  try {
    const window = launched.window;
    const { documents } = await waitForWikilinkEdge(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    if (source === undefined) throw new Error('the corpus did not produce its page');

    await openFromLibrary(window, source.id);
    await window.locator('[data-testid="activity-graph"]').click();
    await expect(window.locator('[data-testid="graph-panel"]')).toBeVisible();

    const gallery = await turnCardArtOn(window);
    await expect(gallery).toHaveAttribute('data-shown', String(PAGE));
    await expect(gallery).toHaveAttribute('data-total', String(many.length));

    const more = window.locator('[data-testid="card-art-gallery-more"]');
    await expect(more).toBeVisible();
    await more.click();
    // Appended, not replaced: scrolling back shows what was already there.
    await expect(gallery).toHaveAttribute('data-shown', String(many.length));
    await expect(window.locator('[data-testid="card-art-tile-0"]')).toHaveAttribute(
      'data-card-name',
      'Test Illustration 1',
    );
    await expect(window.locator('[data-testid="card-art-tile-13"]')).toHaveAttribute(
      'data-card-name',
      'Test Illustration 14',
    );
    // Nothing left to ask for, so nothing offers to ask.
    await expect(more).toHaveCount(0);

    // Off is off. The gallery goes with the switch, because a strip of pictures on a panel that
    // cannot fetch would be an invitation to something that has been declined.
    await window.locator('[data-testid="graph-card-art-off"]').click();
    await expect(window.locator('[data-testid="graph-card-art"]')).toHaveAttribute(
      'data-card-art',
      'off',
    );
    await expect(window.locator('[data-testid="card-art-gallery"]')).toHaveCount(0);
  } finally {
    await launched.app.close();
  }
});
