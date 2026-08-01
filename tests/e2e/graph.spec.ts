/**
 * The graph view, against a real Electron process (criterion W09).
 *
 * The edge under test is one nobody wrote into the database: the workspace puts two ordinary
 * markdown files in a folder, one of which contains `[[forgetting-curve]]`, and the corpus
 * importer turns that wikilink into a typed `document-references-document` edge at startup. So
 * a line on screen between two nodes means ingestion parsed the wiki, the main process
 * traversed the links table, and the panel drew what came back.
 *
 * Every id the assertions use is read back out of the database the app is writing to, never
 * scraped from the DOM the app rendered — otherwise the view would be marking its own work.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, launchApp, type LaunchedApp } from './support/app.js';
import { dropFileOn } from './support/drop.js';
import {
  annotationIds,
  drawnAt,
  encloses,
  highlight,
  openFromLibrary,
  openLibrary,
  readGraph,
  waitForWikilinkEdge,
} from './support/corpus.js';
import type { Locator, Page } from '@playwright/test';
import { openDatabase } from '@wr/database';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** A real 16×16 PNG, of the kind somebody would put on a node. */
const FIXTURE_IMAGE = join(REPO_ROOT, 'tests', 'fixtures', 'node-icon.png');

/** Open the graph on the corpus page, and hand back the panel once it has drawn. */
async function openGraphOnSource(window: Page, sourceId: string): Promise<Locator> {
  await openFromLibrary(window, sourceId);
  await window.locator('[data-testid="activity-graph"]').click();
  const graph = window.locator('[data-testid="graph-panel"]');
  await expect(graph).toBeVisible();
  await expect(graph).toHaveAttribute('data-seed-id', sourceId);
  return graph;
}

/** The file row the app minted for a dropped image, read out of the database it is writing. */
function imageFileId(databasePath: string, name: string): string | null {
  const { db } = openDatabase({ file: databasePath, readonly: true, migrate: false });
  try {
    const row = db.sqlite
      .prepare(
        `SELECT id FROM document_files
          WHERE path LIKE ? AND mime_type LIKE 'image/%'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(`%${name}`) as { id: string } | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

interface Viewport {
  readonly panX: string;
  readonly panY: string;
  readonly zoom: string;
}

async function readViewport(window: Page): Promise<Viewport> {
  const view = window.locator('[data-testid="graph-viewport"]');
  return {
    panX: (await view.getAttribute('data-pan-x')) ?? '',
    panY: (await view.getAttribute('data-pan-y')) ?? '',
    zoom: (await view.getAttribute('data-zoom')) ?? '',
  };
}

test.describe('the link graph', () => {
  test('[W09] renders the neighbourhood of the open document as nodes and edges', async ({
    window,
    workspace,
  }) => {
    const { documents, edges } = await waitForWikilinkEdge(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    const target = documents.find((row) => row.slug === workspace.corpusPage.resolvedLinkText);
    const edge = edges[0];
    if (source === undefined || target === undefined || edge === undefined) {
      throw new Error('the corpus did not produce the two pages and the edge between them');
    }
    // The edge ingestion derived, before anything is rendered.
    expect(edge.type).toBe('document-references-document');
    expect([edge.sourceId, edge.targetId]).toEqual([source.id, target.id]);

    await openFromLibrary(window, source.id);
    await window.locator('[data-testid="activity-graph"]').click();

    const graph = window.locator('[data-testid="graph-panel"]');
    await expect(graph).toBeVisible();
    await expect(graph).toHaveAttribute('data-seed-id', source.id);

    // Two nodes and the one edge between them: the seed at the centre and the page it links
    // to one hop out.
    await expect(graph).toHaveAttribute('data-node-count', '2');
    await expect(graph).toHaveAttribute('data-edge-count', '1');
    await expect(graph.locator(`[data-testid="graph-node-${source.id}"]`)).toHaveAttribute(
      'data-distance',
      '0',
    );
    const targetNode = graph.locator(`[data-testid="graph-node-${target.id}"]`);
    await expect(targetNode).toBeVisible();
    await expect(targetNode).toHaveAttribute('data-distance', '1');
    await expect(targetNode).toHaveAttribute('aria-label', `Open ${target.title}`);
    // The edge is identified by the link row it came from, not by its endpoints, so this
    // fails if the panel invents an edge rather than drawing the one main sent.
    await expect(graph.locator(`[data-testid="graph-edge-${edge.id}"]`)).toBeVisible();
    await expect(window.locator('[data-testid="graph-elision"]')).toHaveCount(0);
  });

  test('[W09] opens the document behind a node when the node is clicked', async ({
    window,
    workspace,
  }) => {
    const { documents } = await waitForWikilinkEdge(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    const target = documents.find((row) => row.slug === workspace.corpusPage.resolvedLinkText);
    if (source === undefined || target === undefined) {
      throw new Error('the corpus did not produce both pages');
    }

    await openFromLibrary(window, source.id);
    await window.locator('[data-testid="activity-graph"]').click();
    await expect(window.locator('[data-testid="graph-panel"]')).toBeVisible();

    // The page behind the node is not open yet: what follows is the click opening it.
    await expect(
      window.locator(`[data-testid="markdown-reader"][data-document-id="${target.id}"]`),
    ).toHaveCount(0);

    await window.locator(`[data-testid="graph-node-${target.id}"]`).click();

    const reader = window.locator(
      `[data-testid="markdown-reader"][data-document-id="${target.id}"]`,
    );
    await expect(reader).toBeVisible();
    await expect(reader.locator('[data-testid="markdown-body"]')).toContainText(
      'Retention decays',
    );
    // A tab of its own, labelled with the page's title, beside the page it was linked from —
    // the node opened the document rather than replacing the one already open with it.
    await expect(window.locator('[data-testid="dockview-container"] .dv-tab')).toContainText([
      source.title,
      target.title,
      'Graph',
    ]);
    // And the graph is still there to click again: navigating from it does not close it.
    await expect(window.locator('[data-testid="graph-panel"]')).toBeVisible();
  });

  test('[G01] the graph pans and zooms, and the view survives reopening the panel', async ({
    window,
    workspace,
  }) => {
    const { documents } = await waitForWikilinkEdge(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    if (source === undefined) throw new Error('the corpus did not produce its page');

    await openGraphOnSource(window, source.id);

    // Nobody has moved this graph yet.
    expect(await readViewport(window)).toEqual({ panX: '0', panY: '0', zoom: '1' });

    const canvas = window.locator('[data-testid="graph-canvas"]');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('the graph canvas has no box to gesture over');
    // The seed sits at the centre and its one neighbour is above it, so the lower-left of the
    // canvas is empty: a drag from here is a pan and not a mis-aimed click on a node.
    const emptyX = box.x + box.width * 0.15;
    const emptyY = box.y + box.height * 0.85;

    // A real wheel gesture, not a call into the panel's state.
    await window.mouse.move(emptyX, emptyY);
    await window.mouse.wheel(0, -300);
    await expect
      .poll(async () => Number((await readViewport(window)).zoom), {
        message: 'the wheel gesture did not zoom the graph in',
      })
      .toBeGreaterThan(1);

    // And a real drag across the background.
    await window.mouse.move(emptyX, emptyY);
    await window.mouse.down();
    await window.mouse.move(emptyX + 120, emptyY - 70, { steps: 10 });
    await window.mouse.up();
    await expect
      .poll(async () => Number((await readViewport(window)).panX), {
        message: 'the drag did not pan the graph',
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => Number((await readViewport(window)).panY))
      .toBeLessThan(0);

    const moved = await readViewport(window);

    // Close the graph tab outright — the panel and everything it was holding are gone.
    await window
      .locator('.dv-tab', { hasText: 'Graph' })
      .locator('.dv-default-tab-action')
      .click();
    await expect(window.locator('[data-testid="graph-panel"]')).toHaveCount(0);

    // A second panel, on the same paper. The view it opens on is the one that was left.
    await openGraphOnSource(window, source.id);
    await expect
      .poll(async () => readViewport(window), {
        message: 'the reopened graph did not come back where it was left',
      })
      .toEqual(moved);
    // And the gestures actually moved it: a viewport that came back as the resting one would
    // satisfy the comparison above while proving nothing.
    expect(Number(moved.zoom)).toBeGreaterThan(1);
    expect(Number(moved.panX)).toBeGreaterThan(0);
  });

  test('[G02] graph settings — spacing, labels, depth — are changed and persist', async ({
    workspace,
  }) => {
    // Ids minted by the first process's corpus scan, and the placement the first process drew;
    // both are compared in the second, and nothing here can predict them from outside.
    let recorded: { sourceId: string; targetId: string; spread: string } | undefined;

    const first: LaunchedApp = await launchApp(workspace);
    try {
      const window = first.window;
      const { documents } = await waitForWikilinkEdge(workspace.databasePath);
      const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
      const target = documents.find((row) => row.slug === workspace.corpusPage.resolvedLinkText);
      if (source === undefined || target === undefined) {
        throw new Error('the corpus did not produce both pages');
      }

      const graph = await openGraphOnSource(window, source.id);
      const neighbour = graph.locator(`[data-testid="graph-node-${target.id}"]`);

      // The defaults, before anything is touched.
      await expect(graph).toHaveAttribute('data-depth', '1');
      await expect(graph).toHaveAttribute('data-spacing', '1');
      await expect(graph).toHaveAttribute('data-labels', 'on');
      await expect(graph.locator('.wr-graph__label')).toHaveCount(2);
      const tightPlacement = await neighbour.getAttribute('transform');

      // Depth, through the control a reader would use.
      await window.locator('[data-testid="graph-setting-depth"]').selectOption('2');
      await expect(graph).toHaveAttribute('data-depth', '2');
      // The header reports the depth the *answer* came back with, so this fails if the panel
      // recorded the setting without re-asking for a wider neighbourhood.
      await expect(graph.locator('.wr-graph__title')).toContainText('2 hops');

      // Spacing, four steps of the slider from 1 to 2.
      const spacing = window.locator('[data-testid="graph-setting-spacing"]');
      for (let step = 0; step < 4; step += 1) await spacing.press('ArrowRight');
      await expect(graph).toHaveAttribute('data-spacing', '2');
      // Not just recorded — drawn. The neighbour is further out than it was.
      await expect
        .poll(async () => neighbour.getAttribute('transform'), {
          message: 'raising the spacing did not move the nodes apart',
        })
        .not.toBe(tightPlacement);
      recorded = {
        sourceId: source.id,
        targetId: target.id,
        spread: (await neighbour.getAttribute('transform')) ?? '',
      };

      // Labels off.
      await window.locator('[data-testid="graph-setting-labels"]').uncheck();
      await expect(graph).toHaveAttribute('data-labels', 'off');
      await expect(graph.locator('.wr-graph__label')).toHaveCount(0);
    } finally {
      await first.app.close();
    }
    if (recorded === undefined) {
      throw new Error('the first run recorded nothing to compare against');
    }

    const second: LaunchedApp = await launchApp(workspace);
    try {
      const window = second.window;
      const graph = await openGraphOnSource(window, recorded.sourceId);

      await expect(graph).toHaveAttribute('data-depth', '2');
      await expect(graph).toHaveAttribute('data-spacing', '2');
      await expect(graph).toHaveAttribute('data-labels', 'off');
      // The controls agree with what is drawn, so the settings were read back rather than
      // being defaults that happen to look the same.
      await expect(window.locator('[data-testid="graph-setting-depth"]')).toHaveValue('2');
      await expect(window.locator('[data-testid="graph-setting-spacing"]')).toHaveValue('2');
      await expect(window.locator('[data-testid="graph-setting-labels"]')).not.toBeChecked();
      await expect(graph.locator('.wr-graph__label')).toHaveCount(0);
      await expect(graph.locator('.wr-graph__title')).toContainText('2 hops');
      await expect(
        graph.locator(`[data-testid="graph-node-${recorded.targetId}"]`),
      ).toHaveAttribute('transform', recorded.spread);
    } finally {
      await second.app.close();
    }
  });

  test('[G06] draws a document’s highlights grouped with it, and edges across groups', async ({
    workspace,
  }) => {
    // Highlighting selects the highlight, and the graph opens on whatever is selected — so the
    // reading and the graphing are two sittings, which is also how a reader gets here: mark up
    // the papers, come back later, look at what is connected to what.
    const reading: LaunchedApp = await launchApp(workspace);
    try {
      const { documents } = await waitForWikilinkEdge(workspace.databasePath);
      const first = documents.find((row) => row.slug === workspace.corpusPage.slug);
      const second = documents.find((row) => row.slug === workspace.corpusPage.resolvedLinkText);
      if (first === undefined || second === undefined) {
        throw new Error('the corpus did not produce both pages');
      }
      // A highlight on each page, made by selecting its prose. Two papers, one link between
      // them, and a highlight inside each — the arrangement the criterion is about.
      await highlight(reading.window, first.id);
      await highlight(reading.window, second.id);
    } finally {
      await reading.app.close();
    }

    // Everything the assertions use is read out of the database the first process wrote, not
    // carried out of the window that wrote it.
    const { documents } = readGraph(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    const target = documents.find((row) => row.slug === workspace.corpusPage.resolvedLinkText);
    if (source === undefined || target === undefined) {
      throw new Error('the corpus did not produce both pages');
    }
    const [here] = annotationIds(workspace.databasePath, source.id);
    const [there] = annotationIds(workspace.databasePath, target.id);
    if (here === undefined || there === undefined) {
      throw new Error('the highlights were not written to the database');
    }
    const marked = { here, there };

    const graphing: LaunchedApp = await launchApp(workspace);
    try {
      const window = graphing.window;
      const graph = await openGraphOnSource(window, source.id);
      // Two hops: the far paper's highlight is one past that paper, and the whole point is
      // where it is drawn rather than how far out its hop count would put it.
      await window.locator('[data-testid="graph-setting-depth"]').selectOption('2');
      await expect(graph).toHaveAttribute('data-depth', '2');
      await expect(graph.locator(`[data-testid="graph-node-${marked.there}"]`)).toBeVisible();

      // Each highlight says which paper holds it, and the paper is nobody's content.
      await expect(graph.locator(`[data-testid="graph-node-${marked.here}"]`)).toHaveAttribute(
        'data-parent-id',
        source.id,
      );
      await expect(graph.locator(`[data-testid="graph-node-${marked.there}"]`)).toHaveAttribute(
        'data-parent-id',
        target.id,
      );
      await expect(graph.locator(`[data-testid="graph-node-${source.id}"]`)).toHaveAttribute(
        'data-parent-id',
        '',
      );

      // Drawn inside, not merely labelled as belonging: each box encloses its paper and the
      // highlight made in it, and neither box has swallowed the other paper.
      const boxes = {
        source: await drawnAt(graph.locator(`[data-testid="graph-group-${source.id}"]`)),
        target: await drawnAt(graph.locator(`[data-testid="graph-group-${target.id}"]`)),
      };
      const points = {
        source: await drawnAt(graph.locator(`[data-testid="graph-node-${source.id}"]`)),
        target: await drawnAt(graph.locator(`[data-testid="graph-node-${target.id}"]`)),
        here: await drawnAt(graph.locator(`[data-testid="graph-node-${marked.here}"]`)),
        there: await drawnAt(graph.locator(`[data-testid="graph-node-${marked.there}"]`)),
      };
      expect(boxes.source.width).toBeGreaterThan(0);
      expect(encloses(boxes.source, points.source)).toBe(true);
      expect(encloses(boxes.source, points.here)).toBe(true);
      expect(encloses(boxes.target, points.target)).toBe(true);
      expect(encloses(boxes.target, points.there)).toBe(true);
      expect(encloses(boxes.source, points.target)).toBe(false);
      expect(encloses(boxes.target, points.here)).toBe(false);

      // The edge between the two papers runs between the two groups. Its id is read *now*,
      // from this process's own scan: the corpus is re-derived on every start, so an id kept
      // from the first window names a row that has since been replaced.
      const { edges } = await waitForWikilinkEdge(workspace.databasePath);
      const wikilink = edges[0];
      if (wikilink === undefined) throw new Error('the wikilink edge was not re-derived');
      const crossing = graph.locator(`[data-testid="graph-edge-${wikilink.id}"]`);
      await expect(crossing).toHaveAttribute('data-source-group', `document ${source.id}`);
      await expect(crossing).toHaveAttribute('data-target-group', `document ${target.id}`);
      await expect(crossing).toHaveAttribute('data-crosses-groups', 'true');
      // …and a highlight's own edge stays inside the group it belongs to, so "crosses" is a
      // distinction the drawing makes rather than a label on every edge.
      const inside = graph.locator(
        `[data-link-type="annotation-belongs-to-document"][data-source-group="document ${source.id}"]`,
      );
      await expect(inside).toHaveAttribute('data-target-group', `document ${source.id}`);
      await expect(inside).toHaveAttribute('data-crosses-groups', 'false');
    } finally {
      await graphing.app.close();
    }
  });

  test('[G04] a node takes an icon from a local image, served over rrfile://', async ({
    window,
    workspace,
  }) => {
    // An image where the researcher keeps it: outside the Zotero directory, outside the wiki,
    // outside every root this app was configured with.
    const inbox = join(workspace.dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const picture = join(inbox, 'induction-head.png');
    copyFileSync(FIXTURE_IMAGE, picture);

    const { documents } = await waitForWikilinkEdge(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    if (source === undefined) throw new Error('the corpus did not produce its page');

    // The picture goes into the library first, by drop — the renderer has no way to name a
    // file on the disk, and the icon channel takes a file id for exactly that reason.
    await openLibrary(window);
    await dropFileOn(window, '[data-testid="library-drop-hint"]', picture);
    await expect
      .poll(() => imageFileId(workspace.databasePath, 'induction-head.png'), {
        timeout: 30_000,
        message: 'the dropped image never became a file the library holds',
      })
      .not.toBeNull();
    const fileId = imageFileId(workspace.databasePath, 'induction-head.png');
    if (fileId === null) throw new Error('the image file id vanished between polls');

    const graph = await openGraphOnSource(window, source.id);
    const node = graph.locator(`[data-testid="graph-node-${source.id}"]`);
    // Bare first, or nothing below distinguishes an icon from a default.
    await expect(node).toHaveAttribute('data-icon-file-id', '');

    await window.locator('[data-testid="graph-node-icon"]').selectOption(fileId);

    // The id came out of the database the app is writing, not from the DOM it rendered.
    await expect(node).toHaveAttribute('data-icon-file-id', fileId);
    await expect(node.locator('image')).toHaveAttribute('href', `rrfile://${fileId}`);
    // …and the bytes actually arrived. The element reports a load only once Chromium fetched
    // it over `rrfile://`, which means the handler resolved the id through the database,
    // checked the path against the allowed roots and streamed the file.
    await expect(node).toHaveAttribute('data-icon-loaded', 'true');

    // Nothing in the drawn graph says where that picture is. The renderer addressed it by id
    // and was never told the rest.
    const markup = await graph.evaluate((element) => element.outerHTML);
    expect(markup).not.toContain('induction-head.png');
    expect(markup).not.toContain(workspace.dir);
    expect(markup).not.toContain('/inbox');

    // The picture belongs to the node and not to the panel: closing the tab and opening a
    // second graph on the same paper brings it back.
    await window
      .locator('.dv-tab', { hasText: 'Graph' })
      .locator('.dv-default-tab-action')
      .click();
    await expect(window.locator('[data-testid="graph-panel"]')).toHaveCount(0);

    const reopened = await openGraphOnSource(window, source.id);
    const again = reopened.locator(`[data-testid="graph-node-${source.id}"]`);
    await expect(again).toHaveAttribute('data-icon-file-id', fileId);
    await expect(again).toHaveAttribute('data-icon-loaded', 'true');
    // The picture is a label, not a rename: the node is still the document it was.
    await expect(again).toHaveAttribute('data-display-name', '');
    await expect(reopened.locator('.wr-graph__title')).toContainText(source.title);

    // And it comes off again through the same control.
    await window.locator('[data-testid="graph-node-icon"]').selectOption('');
    await expect(again).toHaveAttribute('data-icon-file-id', '');
    await expect(again.locator('image')).toHaveCount(0);
  });
});

test.describe('searching the neighbourhood in place', () => {
  /**
   * The same gesture on the other surface a person navigates by.
   *
   * `V02` is asserted end to end on the wiki page, which is the map of everything; this is the
   * panel opened *on* something, where two hops out of a busy paper is the density at which
   * reading every label to find one is the thing a person stops doing. One filter, one rule,
   * one implementation — `SceneFilter` and `matchesNeedle` in `graph-canvas`.
   */
  test('[V02] the neighbourhood panel dims what does not match and moves to what does', async ({
    window,
    workspace,
  }) => {
    const { documents } = await waitForWikilinkEdge(workspace.databasePath);
    const source = documents.find((row) => row.slug === workspace.corpusPage.slug);
    const target = documents.find((row) => row.slug === workspace.corpusPage.resolvedLinkText);
    if (source === undefined || target === undefined) {
      throw new Error('the corpus did not produce both pages');
    }

    const graph = await openGraphOnSource(window, source.id);
    const viewport = graph.locator('[data-testid="graph-viewport"]');
    await expect(viewport).toHaveAttribute('data-pan-x', '0');
    const neighbour = graph.locator(`[data-testid="graph-node-${target.id}"]`);
    await expect(neighbour).toHaveAttribute('data-match', 'true');
    const at = await drawnAt(neighbour);

    // The neighbour, by a word of its own title. The seed is the one thing that certainly does
    // not match it — it is a different page — so it is what "dimmed" is asserted on.
    const word = target.title.split(/\s+/u)[0] ?? target.title;
    await window.locator('[data-testid="graph-filter"]').fill(word.toLowerCase());

    await expect(graph.locator('[data-testid="graph-filter-count"]')).toHaveAttribute(
      'data-matches',
      '1',
    );
    await expect(neighbour).toHaveAttribute('data-match', 'true');
    await expect(graph.locator(`[data-testid="graph-node-${source.id}"]`)).toHaveAttribute(
      'data-match',
      'false',
    );
    // Dimmed, not dropped: the seed is still drawn, and the neighbour has not moved.
    await expect(graph.locator(`[data-testid="graph-node-${source.id}"]`)).toBeVisible();
    expect(await drawnAt(neighbour)).toEqual(at);

    // And the view went to it, keeping the zoom the researcher was reading at.
    const panX = Number(await viewport.getAttribute('data-pan-x'));
    const panY = Number(await viewport.getAttribute('data-pan-y'));
    const zoom = Number(await viewport.getAttribute('data-zoom'));
    expect(zoom).toBe(1);
    expect(panX + at.x * zoom).toBeCloseTo(500, 0);
    expect(panY + at.y * zoom).toBeCloseTo(350, 0);

    await window.locator('[data-testid="graph-filter"]').fill('');
    await expect(graph.locator('[data-testid^="graph-node-"][data-match="false"]')).toHaveCount(0);
  });
});

