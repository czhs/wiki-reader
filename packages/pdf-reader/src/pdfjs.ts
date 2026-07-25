/**
 * The single place PDF.js is configured.
 *
 * The worker URL is resolved through the bundler (`?url`), so the worker script is emitted
 * as an asset next to the renderer bundle and is therefore *same-origin*. That matters: the
 * renderer is served from `app://bundle/`, and a cross-origin worker would be refused by the
 * CSP. If the worker cannot start for any reason, PDF.js falls back to parsing on the main
 * thread rather than failing the document.
 *
 * `isEvalSupported: false` matches the extractor: PDF.js otherwise compiles embedded font
 * programs with `eval`, which the renderer's CSP forbids and which is not a facility an
 * untrusted document should have.
 */
import { GlobalWorkerOptions, getDocument, PixelsPerInch } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerSrc;

export { PixelsPerInch };
export type { PDFDocumentProxy, PDFPageProxy };

export interface LoadedPdf {
  readonly document: PDFDocumentProxy;
  readonly pageCount: number;
}

/**
 * Load a PDF by URL. The URL is always an `rrfile://` one: the renderer addresses documents
 * by file ID and never learns a filesystem path.
 */
export async function loadPdf(url: string, signal?: AbortSignal): Promise<LoadedPdf> {
  const task = getDocument({
    url,
    isEvalSupported: false,
    useSystemFonts: false,
    // Range requests are what the `rrfile://` handler's 206 support exists for: opening a
    // large PDF should not read the whole file.
    disableRange: false,
    disableStream: false,
  });

  signal?.addEventListener('abort', () => void task.destroy(), { once: true });

  const document = await task.promise;
  return { document, pageCount: document.numPages };
}

/** Text items for one page, in reading order. */
export async function pageTextItems(page: PDFPageProxy): Promise<{ str: string; hasEOL?: boolean }[]> {
  const content = await page.getTextContent();
  const items: { str: string; hasEOL?: boolean }[] = [];
  for (const item of content.items) {
    if ('str' in item && typeof item.str === 'string') {
      items.push({ str: item.str, hasEOL: item.hasEOL });
    }
  }
  return items;
}
