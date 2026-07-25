/**
 * Opening a markdown page from the wiki corpus, against a real Electron process.
 *
 * Nothing here pre-inserts a row. The workspace writes ordinary `.md` files into a folder and
 * points the app at it with `WR_MARKDOWN_ROOT`; the main process walks that folder at startup
 * with the real `MarkdownCorpusImporter`. So a document appearing in the sidebar means
 * ingestion ran, and the text on screen means the file was read back over `rrfile://` and
 * rendered — not that a fixture was copied into the assertions.
 */
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';
import { openDatabase } from '@wr/database';

interface CorpusRow {
  readonly id: string;
  readonly title: string;
  readonly docType: string;
  readonly slug: string | null;
}

/**
 * Read the corpus documents back out of the database the app is writing to.
 *
 * Read-only and `migrate: false`, for the reasons `reader.spec.ts` gives: the assertion is
 * about what ingestion persisted, and a second connection must not touch a file the app owns.
 */
function readCorpusDocuments(databasePath: string): readonly CorpusRow[] {
  const { db } = openDatabase({ file: databasePath, readonly: true, migrate: false });
  try {
    const rows = db.sqlite
      .prepare(
        `SELECT id, title, doc_type, slug
           FROM documents
          WHERE doc_type = 'markdown' AND deleted_at IS NULL
          ORDER BY slug`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row['id']),
      title: String(row['title']),
      docType: String(row['doc_type']),
      slug: row['slug'] === null ? null : String(row['slug']),
    }));
  } finally {
    db.close();
  }
}

/** Wait for the startup corpus scan to have committed the page under test, and return it. */
async function waitForCorpusPage(databasePath: string, slug: string): Promise<CorpusRow> {
  await expect
    .poll(() => readCorpusDocuments(databasePath).some((row) => row.slug === slug), {
      timeout: 30_000,
      message: `the corpus scan never imported "${slug}"`,
    })
    .toBe(true);
  const page = readCorpusDocuments(databasePath).find((row) => row.slug === slug);
  if (page === undefined) throw new Error(`unreachable: "${slug}" vanished after polling`);
  return page;
}

/** Open a corpus page from the library sidebar and wait for its body to render. */
async function openFromLibrary(window: Page, documentId: string): Promise<void> {
  const row = window.locator(
    `[data-testid="library-sidebar"] [data-testid="library-item-${documentId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const reader = window.locator(`[data-testid="markdown-reader"][data-document-id="${documentId}"]`);
  await expect(reader).toBeVisible();
  await expect(reader.locator('[data-testid="markdown-body"]')).not.toBeEmpty();
}

test.describe('reading markdown', () => {
  test('[W01] opens a markdown page from the corpus in a tab and renders its content', async ({
    window,
    workspace,
  }) => {
    const expected = workspace.corpusPage;
    const page = await waitForCorpusPage(workspace.databasePath, expected.slug);

    // Ingestion derived both of these: the title from the file's first heading, the slug from
    // its filename. Neither was written into the database by the test.
    expect(page.docType).toBe('markdown');
    expect(page.title).toBe(expected.title);

    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeVisible();
    await openFromLibrary(window, page.id);

    // It opened as a tab in the Dockview centre, labelled with the page's title.
    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeHidden();
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('1 panel');
    const tabs = window.locator('[data-testid="dockview-container"] .dv-tab');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toContainText(expected.title);

    // The file was rendered, structure and all: the heading became a heading, the prose became
    // prose, and the fenced block became code rather than being parsed for links.
    const reader = window.locator('[data-testid="markdown-reader"]');
    await expect(reader.locator('[data-testid="markdown-heading-spaced-repetition"]')).toHaveText(
      expected.title,
    );
    await expect(reader.locator('[data-testid="markdown-body"]')).toContainText(expected.bodyText);
    await expect(reader.locator('[data-testid="markdown-code"]')).toContainText('fenced-link');
    await expect(reader.locator('[data-testid="wikilink-fenced-link"]')).toHaveCount(0);

    // A `[[link]]` to a page the corpus contains is offered as a link; one to a page nobody has
    // written yet is shown as wanted rather than as an error or a dead end.
    const resolved = reader.locator(`[data-testid="wikilink-${expected.resolvedLinkText}"]`);
    await expect(resolved).toBeVisible();
    await expect(resolved).toHaveAttribute('data-wanted', 'false');
    const wanted = reader.locator(`[data-testid="wikilink-${expected.wantedLinkText}"]`);
    await expect(wanted).toBeVisible();
    await expect(wanted).toHaveAttribute('data-wanted', 'true');
  });

  test('[W01] renders markdown from bytes fetched over rrfile:// without exposing a path', async ({
    window,
    workspace,
  }) => {
    const page = await waitForCorpusPage(workspace.databasePath, workspace.corpusPage.slug);
    await openFromLibrary(window, page.id);

    // The reader is handed a `rrfile://` URL and nothing else — no `path` field, and nothing
    // from which the renderer could reconstruct one.
    const files = await window.evaluate(async (documentId: string) => {
      const bridge = (globalThis as unknown as {
        rr: { invoke: (channel: string, request: unknown) => Promise<unknown> };
      }).rr;
      const result = (await bridge.invoke('library:getDocument', { documentId })) as
        | { ok: true; value: { item: { files: { url: string; path?: string }[] } } }
        | { ok: false; error: { message: string } };
      if (!result.ok) throw new Error(`library:getDocument failed: ${result.error.message}`);
      return result.value.item.files;
    }, page.id);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.url).toMatch(/^rrfile:\/\//);
      expect(file.path).toBeUndefined();
      expect(file.url).not.toContain(workspace.dir);
    }

    // Neither the corpus root nor the workspace directory reached the document.
    const html = await window.content();
    expect(html).not.toContain(workspace.corpusRoot);
    expect(html).not.toContain(workspace.dir);
  });
});
