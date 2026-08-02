/**
 * The wiki, against a real Electron process (F01–F06).
 *
 * One surface with two states since `F05`: whole, it is the library seen at once; focused, it
 * has exactly one file in the middle and is how a person crawls from it. Both are drawn in the
 * same tab, driven here the way a reader drives them — the activity bar, the right-click, then
 * the nodes themselves — and every id an assertion uses is read back out of the database the
 * app is writing.
 *
 * The edge under test is one nobody wrote: the corpus holds `[[forgetting-curve]]` in one page,
 * and the startup scan turns it into a typed `document-references-document` link. So a line on
 * the map, or a file at the edge of a focused view, means ingestion parsed the wiki and the main
 * process traversed the links table.
 */
import { test, expect, launchApp, type LaunchedApp } from './support/app.js';
import {
  annotationIds,
  awayFromCentre,
  commitLink,
  drawnAt,
  encloses,
  highlight,
  openFromLibrary,
  placeCount,
  readGraph,
  waitForWikilinkEdge,
} from './support/corpus.js';
import type { Locator, Page } from '@playwright/test';

/** The two corpus pages the wikilink joins, once the scan has derived it. */
async function corpusPair(
  databasePath: string,
  slugs: { readonly from: string; readonly to: string },
): Promise<{ source: { id: string; title: string }; target: { id: string; title: string }; edgeId: string }> {
  const { documents, edges } = await waitForWikilinkEdge(databasePath);
  const source = documents.find((row) => row.slug === slugs.from);
  const target = documents.find((row) => row.slug === slugs.to);
  const edge = edges[0];
  if (source === undefined || target === undefined || edge === undefined) {
    throw new Error('the corpus did not produce the two pages and the edge between them');
  }
  return {
    source: { id: source.id, title: source.title },
    target: { id: target.id, title: target.title },
    edgeId: edge.id,
  };
}

async function openWiki(window: Page): Promise<Locator> {
  await window.locator('[data-testid="activity-wiki"]').click();
  const wiki = window.locator('[data-testid="wiki-panel"]');
  await expect(wiki).toBeVisible();
  return wiki;
}

/** Where a disc actually landed on screen, in CSS pixels, and how big it was drawn. */
async function discOnScreen(node: Locator): Promise<{ x: number; y: number; size: number }> {
  const box = await node.locator('.wr-graph__disc').boundingBox();
  if (box === null) throw new Error('a disc that is meant to be drawn has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, size: box.width };
}

/** How many of the drawn discs are actually inside the panel's own rectangle. */
async function discsInView(canvas: Locator, nodes: Locator): Promise<number> {
  const frame = await canvas.boundingBox();
  if (frame === null) throw new Error('the canvas is not on screen');
  let inside = 0;
  for (const node of await nodes.all()) {
    const at = await discOnScreen(node);
    if (
      at.x >= frame.x &&
      at.x <= frame.x + frame.width &&
      at.y >= frame.y &&
      at.y <= frame.y + frame.height
    ) {
      inside += 1;
    }
  }
  return inside;
}

async function openFocusOn(window: Page, documentId: string): Promise<Locator> {
  await openFromLibrary(window, documentId);
  await window.locator('[data-testid="activity-focus"]').click();
  const view = window.locator('[data-testid="focus-panel"]');
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute('data-focus-id', documentId);
  return view;
}

test.describe('the wiki page', () => {
  test('[F01] is its own page showing the whole library, and a node opens what it stands for', async ({
    window,
    workspace,
  }) => {
    const { source, target, edgeId } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });
    const places = placeCount(workspace.databasePath);
    expect(places).toBeGreaterThan(3);

    const wiki = await openWiki(window);

    // The whole library, not a neighbourhood: it opened with no seed at all, and what it says
    // it holds is what the database holds.
    await expect(wiki).toHaveAttribute('data-total-nodes', String(places));
    await expect(wiki).toHaveAttribute('data-truncated', 'false');
    await expect(wiki).toHaveAttribute('data-node-count', String(places));

    // Including the files nothing links to. A map of only what is already connected would hide
    // exactly the work left to do — the Zotero papers and the third corpus page are on it.
    const { documents } = readGraph(workspace.databasePath);
    for (const page of documents) {
      await expect(wiki.locator(`[data-testid="wiki-node-${page.id}"]`)).toHaveCount(1);
    }
    expect(documents.length).toBeGreaterThanOrEqual(3);

    // …and the derived edge is drawn between the two pages it actually joins.
    await expect(wiki.locator(`[data-testid="wiki-edge-${edgeId}"]`)).toHaveCount(1);
    await expect(wiki.locator(`[data-testid="wiki-edge-${edgeId}"]`)).toHaveAttribute(
      'data-link-type',
      'document-references-document',
    );

    // A page in the workspace rather than a sidecar: it has a tab of its own, named.
    await expect(window.locator('.dv-tab', { hasText: 'Wiki' })).toHaveCount(1);

    // Clicking a node opens the thing it stands for. The reader that appears is the one for
    // the page that was clicked, which is the whole of "clicking a node opens it".
    await wiki.locator(`[data-testid="wiki-node-${target.id}"]`).click();
    await expect(
      window.locator(`[data-testid="markdown-reader"][data-document-id="${target.id}"]`),
    ).toBeVisible();
    // The map is still there to click again — it is a way around the library, not a menu.
    await expect(wiki).toBeVisible();
    // And it is one wiki, however many times it is asked for.
    await window.locator('[data-testid="activity-wiki"]').click();
    await expect(window.locator('[data-testid="wiki-panel"]')).toHaveCount(1);
    expect(source.id).not.toBe(target.id);
  });
});

/**
 * The page it opens as, and the page it becomes when it is put beside something (`F04`).
 *
 * The wiki used to scale to fit: `preserveAspectRatio="xMidYMid meet"` over a fixed logical
 * box, so dragging its tab to the side of the workspace halved the panel and halved the map
 * with it. Every disc, every label and every gap between them came out at half the size, which
 * is not a map beside your reading — it is a thumbnail of one. The researcher's decision:
 * docked means the same scale and a smaller window onto it. You see less of the library, not a
 * smaller library.
 *
 * Measured in pixels on screen, because that is the whole claim. The fit the surface is holding
 * rides as `data-fit` for the same reason the viewport publishes its transform — but a test
 * that only read the attribute would pass while the browser drew something else, so the disc's
 * own box and the distance between two of them are what the assertions are made of.
 */
test.describe('the wiki as a page', () => {
  test('[F04] opens filling the page, docks to a side by its tab, and keeps its scale there', async ({
    window,
    workspace,
  }) => {
    const { source, target } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });

    // Something to dock it *beside*. Without a second panel the tab has nowhere to go: moving
    // the only panel to a new group empties the old one and Dockview takes it away again.
    await openFromLibrary(window, source.id);
    const wiki = await openWiki(window);
    const canvas = wiki.locator('[data-testid="wiki-canvas"]');
    const nodes = wiki.locator('[data-testid^="wiki-node-"]');

    // Filling the page: one group, and the map has all but the chrome of the workspace's width.
    const container = window.locator('[data-testid="dockview-container"]');
    await expect(window.locator('.dv-groupview')).toHaveCount(1);
    const containerBox = await container.boundingBox();
    const wideBox = await canvas.boundingBox();
    if (containerBox === null || wideBox === null) throw new Error('the wiki is not on screen');
    expect(wideBox.width).toBeGreaterThan(containerBox.width * 0.85);

    const viewport = wiki.locator('[data-testid="wiki-viewport"]');
    await expect(viewport).toHaveAttribute('data-zoom', '1');
    const fitWhenWide = await canvas.getAttribute('data-fit');
    const widthWhenWide = Number(await canvas.getAttribute('data-view-width'));
    expect(widthWhenWide).toBeGreaterThan(600);

    // Two fixed points on the map, and the size of one disc. Both are read again after the
    // dock: if the scale is kept, a disc is the same number of pixels across and two discs are
    // the same number of pixels apart, wherever the panel has moved to.
    const sourceNode = wiki.locator(`[data-testid="wiki-node-${source.id}"]`);
    const targetNode = wiki.locator(`[data-testid="wiki-node-${target.id}"]`);
    const before = { source: await discOnScreen(sourceNode), target: await discOnScreen(targetNode) };
    const apartBefore = apart(before.source, before.target);
    expect(apartBefore).toBeGreaterThan(20);
    const visibleBefore = await discsInView(canvas, nodes);
    expect(visibleBefore).toBeGreaterThan(2);

    // Docked by its tab: Dockview's own drag, to the right-hand edge of the workspace.
    const tab = window.locator('.dv-tab', { hasText: 'Wiki' }).first();
    await tab.hover();
    await window.mouse.down();
    await window.mouse.move(
      containerBox.x + containerBox.width * 0.5,
      containerBox.y + containerBox.height * 0.5,
      { steps: 10 },
    );
    await window.mouse.move(
      containerBox.x + containerBox.width - 10,
      containerBox.y + containerBox.height * 0.5,
      { steps: 10 },
    );
    await window.mouse.up();

    // It is beside the reading now, and genuinely narrower.
    await expect(window.locator('.dv-groupview')).toHaveCount(2, { timeout: 10_000 });
    await expect(
      window.locator(`[data-testid="markdown-reader"][data-document-id="${source.id}"]`),
    ).toBeVisible();
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-view-width')))
      .toBeLessThan(widthWhenWide * 0.75);

    // Showing less, not smaller. The fit the surface holds did not move, the researcher's own
    // zoom did not move, and the pixels agree: the same disc, the same size; the same two
    // discs, the same distance apart.
    await expect(canvas).toHaveAttribute('data-fit', fitWhenWide ?? '');
    await expect(viewport).toHaveAttribute('data-zoom', '1');
    const after = { source: await discOnScreen(sourceNode), target: await discOnScreen(targetNode) };
    expect(after.source.size).toBeCloseTo(before.source.size, 1);
    // Within half a pixel of nearly three hundred: the sub-pixel wobble is the browser laying
    // the same drawing out at a different offset, not the map being redrawn at another size.
    expect(apart(after.source, after.target)).toBeCloseTo(apartBefore, 0);

    // …and less of the library is inside the panel than was inside it before.
    expect(await discsInView(canvas, nodes)).toBeLessThan(visibleBefore);
  });
});

/**
 * One surface, whole or focused (`F05`).
 *
 * The wiki and the focused view shipped as two panels, on the argument that "everything,
 * ranked" and "one file and what it reaches" cannot share a layout. They still cannot — but
 * that was an argument about *arrangement*, and it had been used to justify two tabs. A
 * researcher who focused on a paper from the map and then wanted the map back was closing one
 * page and opening another, and the workspace accumulated both. So there is one tab now, and
 * these are two states of it.
 */
test.describe('the wiki, whole and focused', () => {
  test('[F05] is one surface: the whole library, focused on a file, and back again', async ({
    window,
    workspace,
  }) => {
    const { source, target } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });

    const wiki = await openWiki(window);
    await expect(window.locator('[data-testid="focus-panel"]')).toHaveCount(0);
    const tabs = window.locator('[data-testid="dockview-container"] .dv-tab');
    const tabsWhole = await tabs.count();
    const panelCount = await window.locator('[data-testid="status-panel-count"]').textContent();

    // Focus it on one file, from the map itself: a disc is a thing you can act on, and this is
    // the same command the reader, the palette and a key run.
    await wiki.locator(`[data-testid="wiki-node-${source.id}"]`).click({ button: 'right' });
    await expect(window.locator('[data-testid="context-menu"]')).toHaveAttribute(
      'data-menu-kind',
      'graph-node',
    );
    await window.locator('[data-testid="context-menu-item-wr.openFocusView"]').click();

    // The same tab, in its other state. Not a second page: the whole map is gone from the
    // screen, no tab was added, and the workspace holds exactly the panels it held.
    const focused = window.locator('[data-testid="focus-panel"]');
    await expect(focused).toBeVisible();
    await expect(focused).toHaveAttribute('data-focus-id', source.id);
    await expect(window.locator('[data-testid="wiki-panel"]')).toHaveCount(0);
    await expect(tabs).toHaveCount(tabsWhole);
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText(panelCount ?? '');
    // And the tab says where the crawl has got to, so you can tell without looking at it.
    await expect(window.locator('.dv-tab', { hasText: 'Wiki ·' })).toHaveCount(1);

    // The crawl still crawls, in that one tab (`F03`).
    await focused.locator(`[data-testid="focus-node-${target.id}"]`).click();
    await expect(window.locator('[data-testid="focus-panel"]')).toHaveAttribute(
      'data-focus-id',
      target.id,
    );
    await expect(tabs).toHaveCount(tabsWhole);

    // And the way back to the whole library is on the surface it is a state of.
    await window.locator('[data-testid="wiki-whole"]').click();
    await expect(window.locator('[data-testid="wiki-panel"]')).toBeVisible();
    await expect(window.locator('[data-testid="focus-panel"]')).toHaveCount(0);
    await expect(tabs).toHaveCount(tabsWhole);
    await expect(window.locator('.dv-tab', { hasText: 'Wiki' })).toHaveCount(1);
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText(panelCount ?? '');
  });
});

test.describe('the focused view', () => {
  test('[F02] puts a file’s highlights centre-stage and the files it reaches at the edge', async ({
    workspace,
  }) => {
    // Two sittings, which is also how a reader gets here: mark the paper up, come back later
    // and look at what it says and where it leads.
    const reading: LaunchedApp = await launchApp(workspace);
    try {
      const { source } = await corpusPair(workspace.databasePath, {
        from: workspace.corpusPage.slug,
        to: workspace.corpusPage.resolvedLinkText,
      });
      await highlight(reading.window, source.id, 0);
      await highlight(reading.window, source.id, 1);
    } finally {
      await reading.app.close();
    }

    const { source, target } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });
    const marked = annotationIds(workspace.databasePath, source.id);
    expect(marked.length).toBeGreaterThanOrEqual(2);

    const looking: LaunchedApp = await launchApp(workspace);
    try {
      const window = looking.window;
      const view = await openFocusOn(window, source.id);

      await expect(view).toHaveAttribute('data-annotation-count', String(marked.length));
      await expect(view).toHaveAttribute('data-neighbour-count', '1');

      // Every highlight is in the middle, named as one, and carries its own words.
      for (const annotationId of marked) {
        const node = view.locator(`[data-testid="focus-node-${annotationId}"]`);
        await expect(node).toHaveAttribute('data-role', 'annotation');
        await expect(node.locator('title')).not.toHaveText('');
      }
      // The file the page links to is at the edge, and choosing it is a move rather than an
      // open — which is what makes the next criterion possible at all.
      const edge = view.locator(`[data-testid="focus-node-${target.id}"]`);
      await expect(edge).toHaveAttribute('data-role', 'neighbour');
      await expect(edge).toHaveAttribute('data-action', 'refocus');
      await expect(edge).toHaveAttribute('data-through-annotation', 'false');

      // Centre-stage and at the edge as geometry, not as a label: every highlight is drawn
      // nearer the middle of the view than the connected file is.
      const centre = await drawnAt(view.locator(`[data-testid="focus-node-${source.id}"]`));
      expect(awayFromCentre(centre)).toBeLessThan(1);
      const neighbourAt = await drawnAt(edge);
      for (const annotationId of marked) {
        const at = await drawnAt(view.locator(`[data-testid="focus-node-${annotationId}"]`));
        expect(awayFromCentre(at)).toBeLessThan(awayFromCentre(neighbourAt));
      }

      // The box round the middle holds the file and what it says, and nothing it merely reaches.
      const box = await drawnAt(view.locator(`[data-testid="focus-group-${source.id}"]`));
      expect(box.width).toBeGreaterThan(0);
      expect(encloses(box, centre)).toBe(true);
      for (const annotationId of marked) {
        const at = await drawnAt(view.locator(`[data-testid="focus-node-${annotationId}"]`));
        expect(encloses(box, at)).toBe(true);
      }
      expect(encloses(box, neighbourAt)).toBe(false);

      // A highlight in the middle opens the sentence it stands for, in the paper it is in.
      const first = marked[0];
      if (first === undefined) throw new Error('the highlights were not written');
      await view.locator(`[data-testid="focus-node-${first}"]`).click();
      await expect(
        window.locator(`[data-testid="markdown-reader"][data-document-id="${source.id}"]`),
      ).toBeVisible();
    } finally {
      await looking.app.close();
    }
  });

  test('[F03] crawls: choosing a connected file refocuses the same view on it', async ({
    window,
    workspace,
  }) => {
    const { source, target } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });

    const view = await openFocusOn(window, source.id);
    const edge = view.locator(`[data-testid="focus-node-${target.id}"]`);
    await expect(edge).toBeVisible();

    await edge.click();

    // The same view, on the other file. Not a second panel: one tab, re-seated, which is what
    // makes a session a walk through the library rather than a pile of tabs.
    await expect(window.locator('[data-testid="focus-panel"]')).toHaveCount(1);
    await expect(window.locator('[data-testid="focus-panel"]')).toHaveAttribute(
      'data-focus-id',
      target.id,
    );
    await expect(window.locator('[data-testid="focus-title"]')).toHaveText(target.title);

    // And the crawl goes on: the page that linked here is now the file at *this* one's edge,
    // so the same gesture walks back.
    const back = window.locator(`[data-testid="focus-node-${source.id}"]`);
    await expect(back).toHaveAttribute('data-role', 'neighbour');
    await back.click();
    await expect(window.locator('[data-testid="focus-panel"]')).toHaveAttribute(
      'data-focus-id',
      source.id,
    );
    await expect(window.locator('[data-testid="focus-panel"]')).toHaveCount(1);

    // Opening the focused view on a *third* file from outside re-seats the same tab too: the
    // rule is about the view, not about which button was pressed.
    const { documents } = readGraph(workspace.databasePath);
    const third = documents.find((row) => row.id !== source.id && row.id !== target.id);
    if (third === undefined) throw new Error('the corpus did not produce a third page');
    await openFocusOn(window, third.id);
    await expect(window.locator('[data-testid="focus-panel"]')).toHaveCount(1);
  });

  /**
   * The crawl starts the next file's picture where a picture starts.
   *
   * A re-seat changes what one mounted panel is showing, so its viewport survives unless
   * something says otherwise — and every focused file is laid out at the middle of the same
   * scene, so a view panned to where the last file's edge was draws the new file's middle
   * wherever that was, which past the extremes is off the panel entirely. `graph-canvas` has
   * always documented the rule ("a remembered pan would put the next file's picture somewhere
   * the reader left the last one's"); nothing enforced it, and nothing read the viewport
   * across a refocus to notice.
   */
  test('[F03] leaves the previous file’s pan and zoom behind when it refocuses', async ({
    window,
    workspace,
  }) => {
    const { source, target } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });

    const view = await openFocusOn(window, source.id);
    const viewport = view.locator('[data-testid="focus-viewport"]');
    await expect(viewport).toHaveAttribute('data-pan-x', '0');

    // Pan the way a reader does: press on empty canvas, drag, release. The corner is chosen
    // so the gesture starts on the scene and not on a node, which is navigation, not a pan.
    const canvas = await view.locator('[data-testid="focus-canvas"]').boundingBox();
    if (canvas === null) throw new Error('the focused view is not on screen');
    await window.mouse.move(canvas.x + 12, canvas.y + 12);
    await window.mouse.down();
    await window.mouse.move(canvas.x + 190, canvas.y + 130, { steps: 8 });
    await window.mouse.up();

    await expect
      .poll(async () => Number(await viewport.getAttribute('data-pan-x')))
      .toBeGreaterThan(20);
    const pannedY = Number(await viewport.getAttribute('data-pan-y'));
    expect(pannedY).toBeGreaterThan(20);

    // Crawl. The file at the edge is a different subject, so the picture starts at rest.
    const edge = view.locator(`[data-testid="focus-node-${target.id}"]`);
    await expect(edge).toBeVisible();
    await edge.click();

    const after = window.locator('[data-testid="focus-panel"]');
    await expect(after).toHaveAttribute('data-focus-id', target.id);
    const nextViewport = after.locator('[data-testid="focus-viewport"]');
    await expect(nextViewport).toHaveAttribute('data-pan-x', '0');
    await expect(nextViewport).toHaveAttribute('data-pan-y', '0');
    await expect(nextViewport).toHaveAttribute('data-zoom', '1');
    // …and the newly focused file is where the layout put it, in the middle of the scene,
    // rather than wherever the last file's viewport would have carried it.
    const centre = await drawnAt(after.locator(`[data-testid="focus-node-${target.id}"]`));
    expect(awayFromCentre(centre)).toBeLessThan(1);
  });

  /**
   * Find, on the third graph surface — the one a dense paper is actually crawled on.
   *
   * `V02` was green on the wiki page and on the neighbourhood panel, and the guide declared
   * `graph.find` with the surface "Every graph surface" and told the reader to type in it from
   * the chapter that covers the focused view. The focused view drew the same discs, the same
   * viewport group, its own Labels checkbox and Reset button — and no filter. `O01`'s coverage
   * could not see it: the control is declared once and drawn once, so every assertion about
   * declared-versus-drawn was satisfied while the sentence the page printed was false.
   */
  test('[V02] the focused view dims what does not match and moves to what does', async ({
    window,
    workspace,
  }) => {
    const { source, target } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });

    const view = await openFocusOn(window, source.id);
    const viewport = view.locator('[data-testid="focus-viewport"]');
    await expect(viewport).toHaveAttribute('data-pan-x', '0');
    const neighbour = view.locator(`[data-testid="focus-node-${target.id}"]`);
    await expect(neighbour).toBeVisible();
    await expect(neighbour).toHaveAttribute('data-match', 'true');
    const at = await drawnAt(neighbour);

    // A word of the file at the edge, which the file in the middle certainly does not carry —
    // so the middle is what "dimmed" is asserted on.
    const word = target.title.split(/\s+/u)[0] ?? target.title;
    await view.locator('[data-testid="focus-filter"]').fill(word.toLowerCase());

    await expect(view.locator('[data-testid="focus-filter-count"]')).toHaveAttribute(
      'data-matches',
      '1',
    );
    await expect(neighbour).toHaveAttribute('data-match', 'true');
    const centreNode = view.locator(`[data-testid="focus-node-${source.id}"]`);
    await expect(centreNode).toHaveAttribute('data-match', 'false');
    // Dimmed, not dropped: the middle of the view is still drawn, and nothing moved.
    await expect(centreNode).toBeVisible();
    expect(await drawnAt(neighbour)).toEqual(at);
    // The lines dim with the nodes, so a match is not joined to the picture by a lit edge to
    // something that does not match.
    await expect(view.locator(`[data-testid="focus-edge-${target.id}"]`)).toHaveAttribute(
      'data-match',
      'true',
    );

    // And the view went to it, keeping the zoom the researcher was reading at.
    const panX = Number(await viewport.getAttribute('data-pan-x'));
    const panY = Number(await viewport.getAttribute('data-pan-y'));
    const zoom = Number(await viewport.getAttribute('data-zoom'));
    expect(zoom).toBe(1);
    expect(panX + at.x * zoom).toBeCloseTo(500, 0);
    expect(panY + at.y * zoom).toBeCloseTo(350, 0);

    await view.locator('[data-testid="focus-filter"]').fill('');
    await expect(view.locator('[data-testid^="focus-node-"][data-match="false"]')).toHaveCount(0);
  });
});

/** How far apart two nodes were drawn, in the scene's own units. */
function apart(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** One disc as the surface drew it: where it is in scene units, and how big it is. */
interface DrawnDisc {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * Every disc a graph surface drew, read out of the DOM in the scene's own units.
 *
 * The position comes off the node's published `data-x`/`data-y` and the size off the `r` of the
 * circle it actually painted, so "these two overlap" is a claim about the picture rather than
 * about a layout function this test could have called itself.
 */
async function drawnDiscs(nodes: Locator): Promise<DrawnDisc[]> {
  return nodes.evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute('data-entity-id') ?? '',
      x: Number(element.getAttribute('data-x')),
      y: Number(element.getAttribute('data-y')),
      radius: Number(element.querySelector('.wr-graph__disc')?.getAttribute('r') ?? '0'),
    })),
  );
}

/** The closest two discs came to each other, rims counted: negative means they overlap. */
function tightest(discs: readonly DrawnDisc[]): { clearance: number; between: string } {
  let clearance = Number.POSITIVE_INFINITY;
  let between = '';
  for (const [index, one] of discs.entries()) {
    for (const other of discs.slice(index + 1)) {
      const room = apart(one, other) - one.radius - other.radius;
      if (room < clearance) {
        clearance = room;
        between = `${one.id} and ${other.id}`;
      }
    }
  }
  return { clearance, between };
}

/** How far apart two discs typically are on this map, so "pulled together" has a yardstick. */
function typicalDistance(discs: readonly DrawnDisc[]): number {
  let total = 0;
  let pairs = 0;
  for (const [index, one] of discs.entries()) {
    for (const other of discs.slice(index + 1)) {
      total += apart(one, other);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}

/**
 * The map lays itself out by force (`F08`).
 *
 * The researcher used the wiki and said the nodes should push each other apart. They did not:
 * the arrangement was a sunflower spiral of the ranking, so two papers landed near each other
 * when their *degrees* were adjacent and nowhere near each other when they were not — the one
 * relation the picture is of, absent from it — and wherever the spiral's step fell below the
 * size of a disc, two discs were drawn on top of one another and the map became a texture.
 *
 * Both halves are asserted here on the drawn picture: nothing overlaps, and what is linked is
 * drawn together. The spiral survives as the seed the relaxation starts from, which is why the
 * third assertion is that the same library still draws the same map — a force layout that
 * reshuffled itself on every redraw would have traded one unusable map for another.
 */
test.describe('the wiki, laid out by force', () => {
  test('[F08] pushes the nodes apart, draws what is linked together, and holds still', async ({
    window,
    workspace,
  }) => {
    const { source, target } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });

    const wiki = await openWiki(window);
    const nodes = wiki.locator('[data-testid^="wiki-node-"]');
    await expect.poll(async () => nodes.count()).toBeGreaterThan(3);
    const discs = await drawnDiscs(nodes);
    expect(discs.every((disc) => disc.radius > 0 && Number.isFinite(disc.x))).toBe(true);

    // None overlap, at rest. Every pair on the map, not a sample of it: an overlap the reader
    // meets is wherever it happens to be, and one pair drawn on top of another is a disc that
    // cannot be clicked.
    const closest = tightest(discs);
    expect(closest.clearance, `${closest.between} overlap on the map`).toBeGreaterThanOrEqual(0);

    // …and none is pushed off the scene either. A disc whose rim hangs over the edge is drawn
    // half outside its own panel, and the point a hand aims at — between the disc and the name
    // under it — lands off the canvas, which is a node that cannot be pressed at all.
    for (const disc of discs) {
      expect(disc.x - disc.radius, `${disc.id} hangs off the map`).toBeGreaterThanOrEqual(0);
      expect(disc.x + disc.radius, `${disc.id} hangs off the map`).toBeLessThanOrEqual(1000);
      expect(disc.y - disc.radius, `${disc.id} hangs off the map`).toBeGreaterThanOrEqual(0);
      expect(disc.y + disc.radius, `${disc.id} hangs off the map`).toBeLessThanOrEqual(700);
    }

    // …and what the library actually joins is drawn together. The edge under test is the one
    // nobody wrote: `[[forgetting-curve]]` in one corpus page, turned into a typed link by the
    // startup scan. A ranking spiral had no reason to put its two ends anywhere near each other.
    const from = discs.find((disc) => disc.id === source.id);
    const to = discs.find((disc) => disc.id === target.id);
    if (from === undefined || to === undefined) throw new Error('the two pages are not drawn');
    const linked = apart(from, to);
    const typical = typicalDistance(discs);
    expect(typical).toBeGreaterThan(0);
    expect(linked, 'two linked pages are no nearer than any two pages').toBeLessThan(typical);

    // And it is the same map every time it is drawn. Asked for again at a different size and
    // then back — two fresh `graph:overview` answers and two fresh layouts over this corpus,
    // which is small enough that both sizes hold all of it — every disc comes back where it was.
    const size = wiki.locator('[data-testid="wiki-setting-size"]');
    await size.selectOption('60');
    await expect.poll(async () => nodes.count()).toBe(discs.length);
    await size.selectOption('150');
    await expect.poll(async () => nodes.count()).toBe(discs.length);
    const again = await drawnDiscs(nodes);
    expect(new Map(again.map((disc) => [disc.id, `${String(disc.x)},${String(disc.y)}`]))).toEqual(
      new Map(discs.map((disc) => [disc.id, `${String(disc.x)},${String(disc.y)}`])),
    );
  });
});

/**
 * Focusing centres; it does not hide (`F09`).
 *
 * The focused state of the wiki drew one file, the sentences marked in it and the files it
 * reaches — and nothing else in the library at all. The researcher's words: *focus view should
 * not hide things, just center around the focused thing*. So the two bands are unchanged, the
 * rest of the corpus is drawn round them, faint, and the file being focused on is in the middle
 * of the panel.
 *
 * The assertions are the three halves of that sentence: everything the library holds is still on
 * the screen, what is not the subject is drawn dimmer rather than dropped, and the subject is
 * where the eye is — measured in pixels against the middle of the canvas.
 */
test.describe('the wiki, focused', () => {
  test('[F09] centres on the file and dims the rest of the library rather than hiding it', async ({
    window,
    workspace,
  }) => {
    const { source, target } = await corpusPair(workspace.databasePath, {
      from: workspace.corpusPage.slug,
      to: workspace.corpusPage.resolvedLinkText,
    });
    const { documents } = readGraph(workspace.databasePath);
    const others = documents.filter((page) => page.id !== source.id && page.id !== target.id);
    expect(others.length).toBeGreaterThan(0);

    const view = await openFocusOn(window, source.id);

    // Nothing is hidden. Every file in the library is drawn on this view — the one in the
    // middle, the one it reaches, and every other page besides.
    await expect(view).toHaveAttribute('data-context-count', String(placeCount(workspace.databasePath) - 2));
    for (const page of documents) {
      await expect(
        view.locator(`[data-testid="focus-node-${page.id}"]`),
        `${page.title} is not on the focused map at all`,
      ).toHaveCount(1);
    }
    await expect(view.locator('[data-testid="focus-context-count"]')).toContainText(
      'the rest of the library',
    );

    // Only de-emphasized. A file that is neither the subject nor one of its neighbours is
    // marked as the ground the view stands on, and is genuinely drawn fainter — but it is not
    // *filtered*: nothing has been typed, so it still matches, which is the difference between
    // this and `V02`.
    const [elsewhere] = others;
    if (elsewhere === undefined) throw new Error('the corpus produced no third page');
    const faded = view.locator(`[data-testid="focus-node-${elsewhere.id}"]`);
    await expect(faded).toHaveAttribute('data-role', 'context');
    await expect(faded).toHaveAttribute('data-faded', 'true');
    await expect(faded).toHaveAttribute('data-match', 'true');
    const opacityOf = async (node: Locator): Promise<number> =>
      node.evaluate((element) =>
        Number(element.ownerDocument.defaultView?.getComputedStyle(element).opacity ?? '1'),
      );
    const centreNode = view.locator(`[data-testid="focus-node-${source.id}"]`);
    expect(await opacityOf(faded), 'the rest of the library is not drawn any fainter').toBeLessThan(
      await opacityOf(centreNode),
    );
    await expect(centreNode).toHaveAttribute('data-faded', 'false');

    // Centred on the node. Measured where a reader sees it: the disc of the focused file is in
    // the middle of the panel, not merely at the middle of a scene that has been panned away.
    // Two pixels of tolerance, because the scene's fit inside the panel is *held* (`F04`) and
    // is a rounded number — this is a claim about where the eye lands, not about arithmetic.
    const canvas = await view.locator('[data-testid="focus-canvas"]').boundingBox();
    const disc = await discOnScreen(centreNode);
    if (canvas === null) throw new Error('the focused view is not on screen');
    expect(Math.abs(disc.x - (canvas.x + canvas.width / 2))).toBeLessThan(2);
    expect(Math.abs(disc.y - (canvas.y + canvas.height / 2))).toBeLessThan(2);

    // The two bands are still the two bands: `F02`'s geometry is untouched by the corpus drawn
    // behind it, and nothing on this view overlaps anything else (`F08`).
    const neighbourAt = await drawnAt(view.locator(`[data-testid="focus-node-${target.id}"]`));
    expect(awayFromCentre(await drawnAt(centreNode))).toBeLessThan(1);
    expect(awayFromCentre(await drawnAt(faded))).toBeGreaterThan(awayFromCentre(neighbourAt));
    const closest = tightest(await drawnDiscs(view.locator('[data-testid^="focus-node-"]')));
    expect(closest.clearance, `${closest.between} overlap`).toBeGreaterThanOrEqual(0);

    // And it is a map, not a picture: a file out in the dimmed corpus is somewhere to go, and
    // going there re-centres the same view on it — with the file just left behind still drawn.
    await expect(faded).toHaveAttribute('data-action', 'refocus');
    await faded.locator('.wr-graph__disc').click();
    const moved = window.locator('[data-testid="focus-panel"]');
    await expect(moved).toHaveAttribute('data-focus-id', elsewhere.id);
    await expect(moved.locator(`[data-testid="focus-node-${source.id}"]`)).toHaveCount(1);
    // In the scene's own units rather than in pixels this time, and deliberately: the fit the
    // panel holds was captured before the crawl (`F04` — it is released only by Reset view),
    // and the header says a different number of things about a different file, so the panel is
    // a few pixels taller or shorter than the fit still assumes. The claim is the same one —
    // the newly focused file is the middle of the picture and the view is at rest on it.
    const viewport = moved.locator('[data-testid="focus-viewport"]');
    await expect(viewport).toHaveAttribute('data-pan-x', '0');
    await expect(viewport).toHaveAttribute('data-pan-y', '0');
    await expect(viewport).toHaveAttribute('data-zoom', '1');
    const arrived = await drawnAt(moved.locator(`[data-testid="focus-node-${elsewhere.id}"]`));
    expect(awayFromCentre(arrived)).toBeLessThan(1);

    // And it stays centred when the panel changes size, which is the state this was found in:
    // a docked wiki dragged back into the middle, or simply the window widened. The fit holds
    // its *scale* (`F04`) — that is what docking must not change — but it was holding its two
    // offsets with it, and those are measured from the panel's top-left corner, so every new
    // pixel went down the right-hand side and the file the view is centred on sat two hundred
    // pixels left of the middle with half the panel empty beside it.
    const focusCanvas = moved.locator('[data-testid="focus-canvas"]');
    const scaleBefore = await focusCanvas.getAttribute('data-fit');
    const widthBefore = Number(await focusCanvas.getAttribute('data-view-width'));
    await window.locator('[data-testid="activity-library"]').click();
    await expect(window.locator('[data-testid="library-sidebar"]')).toBeHidden();
    await expect
      .poll(async () => Number(await focusCanvas.getAttribute('data-view-width')))
      .toBeGreaterThan(widthBefore);

    // Same scale — the map was not redrawn — and the focused file is still where the eye is.
    await expect(focusCanvas).toHaveAttribute('data-fit', scaleBefore ?? '');
    const grown = await focusCanvas.boundingBox();
    const stillCentred = await discOnScreen(
      moved.locator(`[data-testid="focus-node-${elsewhere.id}"]`),
    );
    if (grown === null) throw new Error('the focused view is not on screen');
    expect(
      Math.abs(stillCentred.x - (grown.x + grown.width / 2)),
      'the focused file drifted off centre when the panel grew',
    ).toBeLessThan(2);
    expect(Math.abs(stillCentred.y - (grown.y + grown.height / 2))).toBeLessThan(2);
  });
});

test.describe('highlights on the wiki', () => {
  /**
   * The map used to draw files and notes and nothing else, and said so in three comments.
   *
   * That made two papers joined because a sentence in one bears on a sentence in the other
   * (`H02`) look exactly like two papers that have never met — the one connection this app is
   * for, invisible on the page that is meant to show the shape of the corpus. The researcher's
   * decision: highlights belong on the wiki, carrying the text that was highlighted, so that
   * they are easy to tell apart from a page node.
   *
   * `V01` shipped that as *one line*, cut to the width of a title — "the model appears to have
   * le…" — which told you a highlight was there and not which one, so the map still had to be
   * clicked through disc by disc. `F06` re-promises it: enough of the sentence to know what it
   * is. The words were always arriving (the channel sends 120 characters); what was missing was
   * a label that wraps instead of truncating. So this is `V01`'s test, re-anchored, and the
   * assertion about the drawn label is the one that moved.
   */
  test('[V01] [F06] a marked sentence is on the map, showing enough of its words to know what it is', async ({
    workspace,
  }) => {
    // The words the first process actually selected, and the pages the corpus scan derived;
    // the second process compares the map against them, and nothing outside the app can
    // predict what the corpus page says or what its ids are.
    let quoted: string | undefined;
    let pages: { source: { id: string; title: string }; target: { id: string } } | undefined;

    const reading: LaunchedApp = await launchApp(workspace);
    try {
      const window = reading.window;
      // Inside the first process, because the wikilink edge is derived by *its* corpus scan.
      const { source, target } = await corpusPair(workspace.databasePath, {
        from: workspace.corpusPage.slug,
        to: workspace.corpusPage.resolvedLinkText,
      });
      pages = { source, target };

      // Two marked sentences. The first is pointed at another paper — the researcher joining
      // a sentence to what it bears on, which is the whole gesture `H02` added. The second is
      // left alone, and is the control: a map of *every* highlight in the library would be a
      // picture of the annotations rather than of the corpus.
      quoted = await highlight(window, source.id, 0);
      const link = window.locator('[data-testid="reader-link"]');
      await expect(link).toHaveAttribute('data-link-source', 'annotation');
      await link.click();
      await window.locator(`[data-testid="link-picker-target-${target.id}"]`).click();
      await commitLink(window);

      await highlight(window, source.id, 1);
    } finally {
      await reading.app.close();
    }

    if (quoted === undefined || pages === undefined) throw new Error('the first run marked nothing');
    const { source, target } = pages;
    const places = placeCount(workspace.databasePath);
    const marked = annotationIds(workspace.databasePath, source.id);
    const [linked, alone] = marked;
    expect(linked).toBeDefined();
    expect(alone).toBeDefined();
    if (linked === undefined || alone === undefined) return;

    const looking: LaunchedApp = await launchApp(workspace);
    try {
      const window = looking.window;
      const wiki = await openWiki(window);

      // The library gained one place: the sentence that became structure. The one nobody
      // linked is not on the map, and is not counted as missing from it either.
      await expect(wiki).toHaveAttribute('data-total-nodes', String(places + 1));
      await expect(wiki).toHaveAttribute('data-truncated', 'false');
      await expect(wiki.locator(`[data-testid="wiki-node-${alone}"]`)).toHaveCount(0);
      await expect(wiki.locator('.wr-graph__title')).toContainText('files, notes and highlights');

      const node = wiki.locator(`[data-testid="wiki-node-${linked}"]`);
      await expect(node).toHaveCount(1);
      await expect(node).toHaveAttribute('data-entity-type', 'annotation');

      // It carries the words that were highlighted — the researcher's actual ask — and they
      // are the page's own text, not a title read off the file.
      const snippet = (await node.getAttribute('data-snippet')) ?? '';
      expect(snippet.length).toBeGreaterThan(12);
      expect(quoted.replace(/\s+/gu, ' ').trim()).toContain(snippet.replace(/…$/u, ''));
      expect(snippet).not.toContain(source.title);

      // …and they are drawn, in quotation marks, so a glance tells a sentence from a file.
      const label = await node.locator('.wr-graph__label').textContent();
      expect(label ?? '').toMatch(/^“.+”$/u);
      const fileNode = wiki.locator(`[data-testid="wiki-node-${source.id}"]`);
      await expect(fileNode).toHaveAttribute('data-snippet', '');
      expect((await fileNode.locator('.wr-graph__label').textContent()) ?? '').not.toMatch(/^“/u);
      // A title stays one line, because a title is a name and a name does not need reading.
      await expect(fileNode.locator('.wr-graph__label tspan')).toHaveCount(0);

      // `F06`: enough of the sentence to know which one it is. The label runs onto its own
      // lines rather than being cut to the width of a title, and what is drawn is the start of
      // the sentence itself — not a different, shorter summary of it.
      const lines = await node
        .locator('.wr-graph__label tspan')
        .evaluateAll((tspans) => tspans.map((tspan) => tspan.textContent ?? ''));
      expect(lines.length, 'a highlight is still labelled on one line').toBeGreaterThan(1);
      const drawn = lines
        .join(' ')
        .replace(/^“/u, '')
        .replace(/”$/u, '')
        .replace(/…$/u, '')
        .trim();
      // Comfortably more than the twenty-eight characters a title is cut to, which is the
      // whole of what `V01` used to show.
      expect(drawn.length, `only “${drawn}” of the sentence is drawn`).toBeGreaterThan(40);
      expect(snippet.replace(/\s+/gu, ' ')).toContain(drawn);
      // Wrapped, not overflowing: no single line is wider than the column the map allows.
      for (const line of lines) expect(line.replace(/[“”…]/gu, '').length).toBeLessThanOrEqual(24);

      // A second difference that needs no reading: the disc is smaller than a file's.
      const discOf = async (target: Locator): Promise<number> =>
        Number(await target.locator('.wr-graph__disc').getAttribute('r'));
      expect(await discOf(node)).toBeLessThan(await discOf(fileNode));

      // And it is drawn *at* its paper rather than at its own place in the ranking, so which
      // paper the sentence is in is read off the map the way `G06` reads it off a box.
      const at = await drawnAt(node);
      const paperAt = await drawnAt(fileNode);
      const otherAt = await drawnAt(wiki.locator(`[data-testid="wiki-node-${target.id}"]`));
      expect(apart(at, paperAt)).toBeLessThan(apart(paperAt, otherAt));
      expect(apart(at, paperAt)).toBeLessThan(60);

      // The line the researcher drew is on the map, joining the sentence to the paper it
      // bears on — the connection that was invisible here before.
      const drawnEdge = wiki.locator(
        '[data-testid^="wiki-edge-"][data-link-type="related-to"]',
      );
      await expect(drawnEdge).toHaveCount(1);

      // Clicking it opens the sentence's own paper, like every other node on this page. The
      // disc is what a hand aims at: a node's label hangs below it and takes no pointer, so
      // the group's own middle is the gap between the two.
      await node.locator('.wr-graph__disc').click();
      await expect(
        window.locator(`[data-testid="markdown-reader"][data-document-id="${source.id}"]`),
      ).toBeVisible();
    } finally {
      await looking.app.close();
    }
  });
});

test.describe('searching the wiki in place', () => {
  /**
   * A map is not a list, so finding something on it cannot be a list of results.
   *
   * Nothing on any graph surface could be searched at all: on a library-sized map the only way
   * to find a paper was to read every label. The criterion asks for the search to happen *in
   * place* — what does not match is dimmed rather than removed, because the arrangement is what
   * the researcher navigates by, and the view moves to what does.
   */
  test('[V02] a filter dims what does not match and moves the view to what does', async ({
    window,
    workspace,
  }) => {
    await waitForWikilinkEdge(workspace.databasePath);
    const wiki = await openWiki(window);
    const viewport = wiki.locator('[data-testid="wiki-viewport"]');
    const drawn = wiki.locator('[data-testid^="wiki-node-"]');
    const before = await drawn.count();
    expect(before).toBeGreaterThan(2);

    // Nobody has typed anything: the whole map is lit, and there is no count to report.
    await expect(wiki.locator('[data-testid^="wiki-node-"][data-match="false"]')).toHaveCount(0);
    await expect(wiki.locator('[data-testid="wiki-filter-count"]')).toHaveCount(0);
    await expect(viewport).toHaveAttribute('data-pan-x', '0');

    // Something to look for: a word from one node's own title that appears in no other, on the
    // node drawn furthest from the middle — so that "the view moved to it" is a claim with
    // somewhere to move from.
    const nodes = await Promise.all(
      (await drawn.all()).map(async (node) => ({
        id: (await node.getAttribute('data-entity-id')) ?? '',
        title: (await node.locator('title').textContent()) ?? '',
        x: Number(await node.getAttribute('data-x')),
        y: Number(await node.getAttribute('data-y')),
      })),
    );
    const away = [...nodes].sort(
      (a, b) => Math.hypot(b.x - 500, b.y - 350) - Math.hypot(a.x - 500, a.y - 350),
    );
    const chosen = away
      .flatMap((node) => {
        const word = (node.title.toLowerCase().match(/[a-z]{5,}/gu) ?? []).find(
          (candidate) =>
            !nodes.some((other) => other.id !== node.id && other.title.toLowerCase().includes(candidate)),
        );
        return word === undefined ? [] : [{ node, word }];
      })
      .at(0);
    if (chosen === undefined) throw new Error('no node on this corpus has a distinctive word');
    expect(Math.hypot(chosen.node.x - 500, chosen.node.y - 350)).toBeGreaterThan(20);

    await window.locator('[data-testid="wiki-filter"]').fill(chosen.word);

    // One match, said out loud — a needle that matches nothing and a needle whose match is off
    // the edge of the panel look the same without it.
    const count = wiki.locator('[data-testid="wiki-filter-count"]');
    await expect(count).toHaveAttribute('data-matches', '1');
    const match = wiki.locator(`[data-testid="wiki-node-${chosen.node.id}"]`);
    await expect(match).toHaveAttribute('data-match', 'true');

    // Everything else is dimmed rather than dropped: the map still has all of its nodes, and
    // each of them is still where it was.
    await expect(drawn).toHaveCount(before);
    await expect(wiki.locator('[data-testid^="wiki-node-"][data-match="false"]')).toHaveCount(
      before - 1,
    );
    const other = nodes.find((node) => node.id !== chosen.node.id);
    if (other === undefined) throw new Error('the corpus drew only one node');
    const dimmed = wiki.locator(`[data-testid="wiki-node-${other.id}"]`);
    expect(
      await dimmed.evaluate((element) =>
        Number(element.ownerDocument.defaultView?.getComputedStyle(element).opacity ?? '1'),
      ),
      'a node that does not match is not visibly dimmed',
    ).toBeLessThan(0.5);
    const stillAt = await drawnAt(match);
    expect(stillAt.x, 'filtering moved a node instead of dimming its neighbours').toBe(chosen.node.x);
    expect(stillAt.y).toBe(chosen.node.y);

    // And the view went to it. Asserted through the viewport's own transform, in the scene's
    // units: the match is in the middle of the picture now, and it was not before.
    const panned = {
      x: Number(await viewport.getAttribute('data-pan-x')),
      y: Number(await viewport.getAttribute('data-pan-y')),
      zoom: Number(await viewport.getAttribute('data-zoom')),
    };
    expect(panned.zoom, 'the filter changed the zoom the researcher chose').toBe(1);
    expect(panned.x + chosen.node.x * panned.zoom).toBeCloseTo(500, 0);
    expect(panned.y + chosen.node.y * panned.zoom).toBeCloseTo(350, 0);

    // Clearing it gives the map back, whole.
    await window.locator('[data-testid="wiki-filter"]').fill('');
    await expect(wiki.locator('[data-testid^="wiki-node-"][data-match="false"]')).toHaveCount(0);
    await expect(count).toHaveCount(0);
    await expect(drawn).toHaveCount(before);
  });
});

