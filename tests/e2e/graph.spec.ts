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
import { test, expect, launchApp, type LaunchedApp } from './support/app.js';
import type { Locator, Page } from '@playwright/test';
import { openDatabase } from '@wr/database';

interface CorpusRow {
  readonly id: string;
  readonly title: string;
  readonly slug: string | null;
}

interface EdgeRow {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
}

/** Read-only, `migrate: false`: a second connection must not touch a file the app owns. */
function readGraph(databasePath: string): {
  documents: readonly CorpusRow[];
  edges: readonly EdgeRow[];
} {
  const { db } = openDatabase({ file: databasePath, readonly: true, migrate: false });
  try {
    const documents = (
      db.sqlite
        .prepare(
          `SELECT id, title, slug FROM documents
            WHERE doc_type = 'markdown' AND deleted_at IS NULL
            ORDER BY slug`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row['id']),
      title: String(row['title']),
      slug: row['slug'] === null ? null : String(row['slug']),
    }));

    const edges = (
      db.sqlite
        .prepare(
          `SELECT id, type, source_id, target_id FROM links
            WHERE generator = 'wikilink' ORDER BY created_at, id`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row['id']),
      type: String(row['type']),
      sourceId: String(row['source_id']),
      targetId: String(row['target_id']),
    }));

    return { documents, edges };
  } finally {
    db.close();
  }
}

/** Wait for the startup corpus scan to have derived the wikilink edge, then return the graph. */
async function waitForWikilinkEdge(
  databasePath: string,
): Promise<{ documents: readonly CorpusRow[]; edges: readonly EdgeRow[] }> {
  await expect
    .poll(() => readGraph(databasePath).edges.length, {
      timeout: 30_000,
      message: 'the corpus scan never derived a wikilink edge',
    })
    .toBeGreaterThan(0);
  return readGraph(databasePath);
}

async function openFromLibrary(window: Page, documentId: string): Promise<void> {
  const row = window.locator(
    `[data-testid="library-sidebar"] [data-testid="library-item-${documentId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(
    window.locator(`[data-testid="markdown-reader"][data-document-id="${documentId}"]`),
  ).toBeVisible();
}

/** Open the graph on the corpus page, and hand back the panel once it has drawn. */
async function openGraphOnSource(window: Page, sourceId: string): Promise<Locator> {
  await openFromLibrary(window, sourceId);
  await window.locator('[data-testid="activity-graph"]').click();
  const graph = window.locator('[data-testid="graph-panel"]');
  await expect(graph).toBeVisible();
  await expect(graph).toHaveAttribute('data-seed-id', sourceId);
  return graph;
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
});
