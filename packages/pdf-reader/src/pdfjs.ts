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

/**
 * Where PDF.js finds the data it does not embed.
 *
 * Resolved against the document rather than hard-coded, so this is `app://bundle/…` in the
 * built app and the dev server's origin under `pnpm dev` — both same-origin, which the
 * renderer's `default-src 'self'` requires. The build emits both directories next to the
 * bundle (`pdfjsAssets` in `electron.vite.config.ts`).
 *
 * Both are needed for a document to render *as itself*:
 *   - `standard_fonts/`: a PDF may reference the 14 standard fonts without embedding them.
 *     With no font data PDF.js substitutes, and the substitute has different metrics — the
 *     text reflows, line breaks move, and the page is no longer the page.
 *   - `cmaps/`: a CID-keyed font needs its character map to turn codes into glyphs. Without
 *     it a CJK document renders as the wrong characters rather than as nothing, which is
 *     worse: it looks like it worked.
 */
const STANDARD_FONT_DATA_URL = new URL('standard_fonts/', document.baseURI).href;
const CMAP_URL = new URL('cmaps/', document.baseURI).href;

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
    // Left false deliberately: a local system font with the right *name* is not the font the
    // document was set in, and silently swapping one in is the same class of infidelity as
    // substituting extracted text for the page. The bundled standard fonts are the real
    // Foxit metrics PDF.js ships for exactly this case.
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
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
