/**
 * The wiki page and the focused view, against a real Electron process (F01, F02, F03).
 *
 * Two surfaces, deliberately not one with a toggle. The wiki is the library seen at once and has
 * no subject; the focused view has exactly one file and is how a person crawls from it. Both are
 * driven here the way a reader drives them — the activity bar, then the nodes themselves — and
 * every id an assertion uses is read back out of the database the app is writing.
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
});
