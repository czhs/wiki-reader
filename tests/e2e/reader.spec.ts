/**
 * Opening PDFs and highlighting them, against a real Electron process.
 *
 * The PDFs here are real bytes on disk, reached the renderer through the `rrfile://`
 * protocol, and are rendered by PDF.js. Nothing about the reader is stubbed, which is what
 * makes the page count and the text layer meaningful assertions rather than decoration.
 */
import { test, expect } from './support/app.js';
import type { Page } from '@playwright/test';
import { openDatabase } from '@wr/database';

/** Open a document from the library sidebar and wait for PDF.js to finish its first page. */
async function openFromLibrary(
  window: Page,
  documentId: string,
  options: { readonly toSide?: boolean } = {},
): Promise<void> {
  const row = window.locator(`[data-testid="library-sidebar"] [data-testid="library-item-${documentId}"]`);
  await expect(row).toBeVisible();
  // Cmd/Ctrl-click is the workbench's "open beside" gesture, the same one `ListRow` maps to
  // `openToSide`.
  await row.click(options.toSide === true ? { modifiers: ['Meta'] } : {});

  const reader = window.locator(`[data-testid="pdf-reader"][data-document-id="${documentId}"]`);
  await expect(reader).toBeVisible();
  // "N pages" rather than "loading…" only after PDF.js has actually parsed the document.
  await expect(reader.locator('[data-testid="pdf-total-pages"]')).toHaveText(/^\d+ pages$/);
  await expect(reader.locator('[data-testid="pdf-page-0"] canvas')).toBeVisible();
}

test.describe('reading PDFs', () => {
  test('[M06] opens a Zotero PDF attachment in a tab without handing the renderer a path', async ({
    window,
    workspace,
  }) => {
    const document = workspace.pdfDocuments[0];
    expect(document).toBeDefined();
    if (document === undefined) return;

    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeVisible();
    await openFromLibrary(window, document.id);

    // It opened as a tab in the Dockview centre, so the watermark is gone and the shell
    // agrees that exactly one panel is open.
    await expect(window.locator('[data-testid="workspace-watermark"]')).toBeHidden();
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('1 panel');
    await expect(window.locator('[data-testid="dockview-container"] .dv-tab')).toHaveCount(1);

    // The bytes arrived over `rrfile://`. Ask the bridge for the same file reference the
    // reader was given: it carries an opaque protocol URL and no `path` field at all, so the
    // renderer is never told — and cannot construct — where the file actually lives.
    const files = await window.evaluate(async (documentId: string) => {
      const bridge = (globalThis as unknown as {
        rr: { invoke: (channel: string, request: unknown) => Promise<unknown> };
      }).rr;
      // Every reply is the `IpcResult` envelope the router produces, so a failure arrives as
      // `{ ok: false }` rather than as a rejected promise — unwrap it the way the renderer's
      // own `call()` does instead of reading through it.
      const result = (await bridge.invoke('library:getDocument', { documentId })) as
        | { ok: true; value: { item: { files: { url: string; path?: string }[] } } }
        | { ok: false; error: { message: string } };
      if (!result.ok) throw new Error(`library:getDocument failed: ${result.error.message}`);
      return result.value.item.files;
    }, document.id);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.url).toMatch(/^rrfile:\/\//);
      expect(file.path).toBeUndefined();
      expect(file.url).not.toContain(workspace.dir);
    }

    // And nothing leaked into the rendered document either.
    const html = await window.content();
    expect(html).not.toContain(workspace.zoteroDataDir);
    expect(html).not.toContain(workspace.dir);
  });

  test('[M06] renders one page container per page of the opened PDF and reports that count', async ({
    window,
    workspace,
  }) => {
    const document = workspace.pdfDocuments[0];
    expect(document).toBeDefined();
    if (document === undefined) return;

    await openFromLibrary(window, document.id);
    const label = await window.locator('[data-testid="pdf-total-pages"]').textContent();
    const pages = Number(/^(\d+) pages$/.exec(label ?? '')?.[1] ?? '0');
    expect(pages).toBeGreaterThan(0);
    // One page container per page PDF.js parsed, whether or not it has been rasterised yet.
    await expect(window.locator('[data-testid^="pdf-page-"]')).toHaveCount(pages);
    // The count the toolbar shows is the document's, not the viewport's: it survives
    // scrolling to the end, where the first page has been recycled out of the render window.
    await window.locator('[data-testid="pdf-scroll"]').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(window.locator('[data-testid="pdf-total-pages"]')).toHaveText(label ?? '');
  });

  test('[M07] opens two PDFs side by side in separate groups', async ({ window, workspace }) => {
    const [first, second] = workspace.pdfDocuments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await openFromLibrary(window, first.id);
    await openFromLibrary(window, second.id, { toSide: true });

    // Both readers are on screen at once — not one tab hiding behind another.
    await expect(
      window.locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`),
    ).toBeVisible();
    await expect(
      window.locator(`[data-testid="pdf-reader"][data-document-id="${second.id}"]`),
    ).toBeVisible();
    await expect(window.locator('[data-testid="status-panel-count"]')).toHaveText('2 panels');

    // Side by side, not stacked: Dockview has two groups, and the second sits to the right
    // of the first.
    const groups = window.locator('[data-testid="dockview-container"] .dv-groupview');
    await expect(groups).toHaveCount(2);

    const left = await window
      .locator(`[data-testid="pdf-reader"][data-document-id="${first.id}"]`)
      .boundingBox();
    const right = await window
      .locator(`[data-testid="pdf-reader"][data-document-id="${second.id}"]`)
      .boundingBox();
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    if (left === null || right === null) return;
    expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  });

  test('[M11] turns a real text selection into a highlight that is painted and stored', async ({
    window,
    workspace,
  }) => {
    const document = workspace.pdfDocuments[0];
    expect(document).toBeDefined();
    if (document === undefined) return;

    await openFromLibrary(window, document.id);

    const textLayer = window.locator('[data-testid="pdf-page-0"] .wr-pdf-page__text-layer');
    await expect(textLayer.locator('span').first()).toBeAttached();

    const selectedText = await selectSomeText(window);
    expect(selectedText.trim().length).toBeGreaterThan(3);

    // The selection toolbar is the reader's own reaction to `window.getSelection()`, so its
    // appearance proves the selection was seen by the application, not just by Chromium.
    const toolbar = window.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible();
    await window.locator('[data-testid="create-highlight"]').click();

    // Painted over the page…
    const highlight = window.locator('[data-testid^="pdf-highlight-"]');
    await expect(highlight.first()).toBeVisible();
    await expect(toolbar).toBeHidden();

    // …listed in the annotations sidebar, which creating a highlight opens…
    const sidebar = window.locator('[data-testid="annotations-sidebar"]');
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator('[data-testid^="annotation-"]').first()).toBeVisible();

    // …and written through to SQLite with the text it was made from, rather than living in
    // renderer state until the window closes.
    const stored = readAnnotations(workspace.databasePath, document.id);
    expect(stored).toHaveLength(1);
    const only = stored[0];
    expect(only).toBeDefined();
    if (only === undefined) return;
    expect(only.kind).toBe('highlight');
    expect(normalize(only.selectedText)).toBe(normalize(selectedText));
    expect(only.anchor.kind).toBe('pdf');
    // Text-based evidence, not only pixel rectangles — the invariant the anchor design rests
    // on. The quote is what the user selected, the offsets say where on the page it was, and
    // the two hashes say which page text and which revision it was taken against; a
    // re-extracted document can be searched for the quote again from these alone.
    expect(normalize(only.anchor.quote.exact)).toBe(normalize(selectedText));
    expect(only.anchor.position.end).toBeGreaterThan(only.anchor.position.start);
    expect(only.anchor.pageTextHash.length).toBeGreaterThan(0);
    expect(only.anchor.contentHash.length).toBeGreaterThan(0);
    expect(only.anchor.rects.length).toBeGreaterThan(0);
  });
});

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Select real text on the first rendered page and return what was selected.
 *
 * A mouse drag across the text layer is what a reader actually does, so that is what is
 * attempted first. PDF.js positions its text spans absolutely and a drag can land between
 * two of them; when that happens the selection is placed over the same real spans with a DOM
 * Range and a real `mouseup` is dispatched. Either way the application sees a genuine
 * `window.getSelection()` over genuinely extracted PDF text — only the gesture differs.
 */
async function selectSomeText(window: Page): Promise<string> {
  const span = window.locator('[data-testid="pdf-page-0"] .wr-pdf-page__text-layer span').first();
  const box = await span.boundingBox();

  if (box !== null && box.width > 4) {
    await window.mouse.move(box.x + 1, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
    await window.mouse.up();

    const dragged = await window.evaluate(() => window.getSelection()?.toString() ?? '');
    if (dragged.trim().length > 3) return dragged;
  }

  return window.evaluate(() => {
    const layer = document.querySelector('[data-testid="pdf-page-0"] .wr-pdf-page__text-layer');
    const spans = [...(layer?.querySelectorAll('span') ?? [])].filter(
      (element) => (element.textContent ?? '').trim().length > 3,
    );
    const first = spans[0];
    if (first === undefined) return '';

    const range = document.createRange();
    range.selectNodeContents(first);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const scroll = document.querySelector('[data-testid="pdf-scroll"]');
    scroll?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    return selection?.toString() ?? '';
  });
}

interface StoredAnnotation {
  readonly kind: string;
  readonly selectedText: string;
  readonly anchor: {
    readonly kind: string;
    readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
    readonly position: { readonly start: number; readonly end: number };
    readonly rects: readonly unknown[];
    readonly pageTextHash: string;
    readonly contentHash: string;
  };
}

/**
 * Read the annotations back out of the database the app is writing to.
 *
 * Read from the file rather than asked over IPC, so the assertion is about what was
 * persisted rather than about what the renderer believes it persisted. The read happens in
 * this process, not in the main process: `electronApplication.evaluate` runs its function
 * through the inspector, where the app's ES module scope — and so `require` and dynamic
 * `import()` — is unavailable. A second read-only connection is safe while the app holds the
 * database open because it is in WAL mode, and `migrate: false` keeps this reader from
 * writing anything to a file the app owns.
 */
function readAnnotations(databasePath: string, documentId: string): readonly StoredAnnotation[] {
  const { db } = openDatabase({ file: databasePath, readonly: true, migrate: false });
  let rows: Record<string, unknown>[];
  try {
    rows = db.sqlite
      .prepare(
        `SELECT a.kind, a.selected_text, n.anchor_json
           FROM annotations a
           JOIN annotation_anchors n ON n.annotation_id = a.id
          WHERE a.document_id = ? AND a.deleted_at IS NULL`,
      )
      .all(documentId) as Record<string, unknown>[];
  } finally {
    db.close();
  }

  return rows.map((row) => {
    const anchor = JSON.parse(String(row['anchor_json'])) as { kind: string; exact: string };
    return {
      kind: String(row['kind']),
      selectedText: String(row['selected_text']),
      anchor,
    };
  });
}
