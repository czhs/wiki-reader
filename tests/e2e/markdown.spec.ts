/**
 * Opening a markdown page from the wiki corpus, against a real Electron process.
 *
 * Nothing here pre-inserts a row. The workspace writes ordinary `.md` files into a folder and
 * points the app at it with `WR_MARKDOWN_ROOT`; the main process walks that folder at startup
 * with the real `MarkdownCorpusImporter`. So a document appearing in the sidebar means
 * ingestion ran, and the text on screen means the file was read back over `rrfile://` and
 * rendered — not that a fixture was copied into the assertions.
 */
import { test, expect, showLibrary } from './support/app.js';
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
  await showLibrary(window);
  const row = window.locator(
    `[data-testid="library-panel"] [data-testid="library-item-${documentId}"]`,
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

    await expect(window.locator('[data-testid="library-panel"]')).toBeVisible();
    await openFromLibrary(window, page.id);

    // It opened as a tab in the Dockview centre, labelled with the page's title.
    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeHidden();
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('2 panels');
    const tabs = window.locator('[data-testid="dockview-container"] .dv-tab');
    await expect(tabs).toHaveCount(2);
    // The second: the first is the library the app opened on (`U15`).
    await expect(tabs.nth(1)).toContainText(expected.title);

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

  /**
   * A sentence with mathematics in it, marked the way any other sentence is marked.
   *
   * `S02` put `$…$` into the renderer every markdown page is drawn with, and the projection an
   * anchor is measured against did not learn about it. Two things broke and neither said so:
   * dragging over such a sentence produced no Highlight button at all, because the words on
   * screen appear nowhere in the document's text; and a highlight that did exist over one
   * stopped being painted, because the folded block spells the formula as its TeX and the
   * quote spelled it with dollars around it. Both are M02/M03 regressions rather than S02
   * failures, which is why every milestone-6 spec was green through them — the notebook page
   * is the only surface those specs render a formula on, and nothing anchors there.
   */
  test('[S02] marks a sentence containing a formula, and paints it over the formula', async ({
    window,
    workspace,
  }) => {
    const expected = workspace.corpusPage;
    const page = await waitForCorpusPage(workspace.databasePath, expected.mathSlug);
    await openFromLibrary(window, page.id);

    const reader = window.locator(`[data-testid="markdown-reader"][data-document-id="${page.id}"]`);
    await expect(reader.locator('[data-testid="markdown-math"]').first()).toBeVisible();

    // Drag over the whole paragraph the formula sits in, the way a reader would.
    await window.evaluate(() => {
      const paragraph = [...document.querySelectorAll('[data-testid="markdown-body"] p')].find(
        (node) => node.querySelector('[data-testid="markdown-math"]') !== null,
      );
      if (paragraph === undefined) throw new Error('no paragraph with a formula in it');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      if (selection === null) throw new Error('no selection');
      selection.removeAllRanges();
      selection.addRange(range);
      document
        .querySelector('[data-testid="markdown-scroll"]')
        ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // The affordance appears at all — this is the half that silently did nothing.
    const highlight = window.locator('[data-testid="create-highlight"]');
    await expect(highlight).toBeVisible({ timeout: 10_000 });
    await highlight.click();

    // And the mark is drawn on the page, over the sentence, with the formula inside it and no
    // <mark> opened within the MathML.
    const marks = reader.locator('[data-testid^="markdown-highlight-"]');
    await expect(marks.first()).toBeVisible({ timeout: 30_000 });
    const painted = (await marks.allTextContents()).join('');
    expect(painted).toContain('Fitted, retention is');
    expect(painted).toContain('is the strength of the memory.');
    expect(
      await reader.locator('[data-testid="markdown-math"] mark').count(),
      'a mark was opened inside the MathML',
    ).toBe(0);
    expect(
      await reader.locator('mark [data-testid="markdown-math"]').count(),
      'the formula was left outside the highlight',
    ).toBeGreaterThan(0);

    // What was stored is the sentence as the *document* spells it, so the same quote is what
    // re-anchors the highlight in the main process after a restart.
    const quotes = await window.evaluate(async (documentId: string) => {
      const bridge = (globalThis as unknown as {
        rr: { invoke: (channel: string, request: unknown) => Promise<unknown> };
      }).rr;
      const result = (await bridge.invoke('annotation:listByDocument', { documentId })) as
        | { ok: true; value: { annotations: { anchor: { quote?: { exact: string } } }[] } }
        | { ok: false; error: { message: string } };
      if (!result.ok) throw new Error(`annotation:listByDocument failed: ${result.error.message}`);
      return result.value.annotations.map((annotation) => annotation.anchor.quote?.exact ?? '');
    }, page.id);
    expect(quotes).toContain(workspace.corpusPage.mathSentence);
  });
});
