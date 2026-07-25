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
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';
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
});
