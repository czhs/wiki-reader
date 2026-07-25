/**
 * @wr/text-extraction-worker — PDF text extraction (criterion M09).
 *
 * Runs in a utility process, never in the renderer: PDF.js parsing an arbitrary file is
 * exactly the kind of work that should not share an address space with anything privileged,
 * and extracting a large paper would otherwise block whichever thread it ran on.
 *
 * The output contract is one entry per page, in page order, holding that page's *normalized*
 * text. Normalization happens here rather than at index time because annotation anchors store
 * offsets into this same normalized text — if the two ever diverged, a highlight would
 * silently resolve to the wrong span.
 */
import { joinPdfTextItems, normalizeText } from '@wr/document-model';

export const PACKAGE_NAME = '@wr/text-extraction-worker' as const;

/** One page of extracted text. `pageIndex` is 0-based, matching `PdfLocation.pageIndex`. */
export interface ExtractedPage {
  readonly pageIndex: number;
  readonly text: string;
}

export interface ExtractionResult {
  readonly pageCount: number;
  readonly pages: readonly ExtractedPage[];
  /** Pages that yielded no text at all — the signature of a scanned, un-OCRed document. */
  readonly emptyPageIndexes: readonly number[];
  readonly characterCount: number;
}

export interface ExtractionLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

const silentLogger: ExtractionLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export interface ExtractOptions {
  readonly logger?: ExtractionLogger | undefined;
  /** Stop after this many pages. Bounds work on pathologically large files. */
  readonly maxPages?: number | undefined;
}

/** The subset of the PDF.js text-item shape this worker depends on. */
interface TextItemLike {
  readonly str: string;
  readonly hasEOL?: boolean;
}

function isTextItem(value: unknown): value is TextItemLike {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'str') === 'string'
  );
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup(): void;
}

interface PdfDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(src: {
    data: Uint8Array;
    isEvalSupported: boolean;
    useSystemFonts: boolean;
  }): { promise: Promise<PdfDocumentLike> };
}

/**
 * PDF.js ships a browser build and a `legacy` build; only the latter runs on Node without a
 * DOM. Imported lazily so that merely importing this module — which the job runner does at
 * startup to register its handler — does not pay for loading the whole parser.
 */
async function loadPdfjs(): Promise<PdfjsModule> {
  const loaded: unknown = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return loaded as PdfjsModule;
}

/**
 * Extract every page's text from a PDF held in memory.
 *
 * A page that throws is recorded as empty rather than aborting the document: one malformed
 * page in a 300-page scan should cost that page's text, not the whole document's
 * searchability.
 */
export async function extractPdfText(
  data: Uint8Array,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const logger = options.logger ?? silentLogger;
  const pdfjs = await loadPdfjs();

  // `isEvalSupported: false` stops PDF.js compiling embedded font programs via `eval`.
  const document = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const pageCount = document.numPages;
  const limit = Math.min(options.maxPages ?? pageCount, pageCount);
  const pages: ExtractedPage[] = [];
  const emptyPageIndexes: number[] = [];
  let characterCount = 0;

  try {
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const pageIndex = pageNumber - 1;
      let text = '';

      try {
        const page = await document.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          text = normalizeText(joinPdfTextItems(content.items.filter(isTextItem)));
        } finally {
          page.cleanup();
        }
      } catch (error) {
        logger.warn('page extraction failed', {
          pageIndex,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (text.length === 0) emptyPageIndexes.push(pageIndex);
      characterCount += text.length;
      pages.push({ pageIndex, text });
    }
  } finally {
    await document.destroy();
  }

  logger.info('extracted pdf text', {
    pageCount,
    extractedPages: pages.length,
    emptyPages: emptyPageIndexes.length,
    characterCount,
  });

  if (pages.length > 0 && emptyPageIndexes.length === pages.length) {
    // Every page empty is the scanned-document signature. A warning rather than an error:
    // the import still succeeded, but the document will never match a query.
    logger.warn('pdf yielded no text on any page; it may be a scan requiring OCR', { pageCount });
  }

  return { pageCount, pages, emptyPageIndexes, characterCount };
}
