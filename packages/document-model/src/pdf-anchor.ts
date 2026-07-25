import type {
  PdfAnchor,
  PdfLocation,
  PdfReaderSelection,
  ResolvedLocation,
} from '@wr/shared-types';
import { PdfAnchorSchema } from '@wr/shared-types';
import { taggedTextHash } from './hash.js';
import { normalizeText } from './normalize.js';
import { createQuoteSelector, resolveTextQuote } from './text-quote.js';

/**
 * PDF anchor construction and resolution.
 *
 * An anchor persists page index, normalized rectangles, the selected text, the text
 * immediately before and after it, a hash of the page's normalized text, and the content
 * hash of the document revision. Viewport pixel coordinates are never persisted: the
 * rectangles are page-relative 0..1, so they survive zoom, window size, and DPI changes.
 *
 * Resolution prefers text evidence over geometry. Geometry is used for painting the
 * highlight, but if the page text changed, the quote is what relocates the anchor.
 */

export const PDF_ANCHOR_VERSION = 1;

export interface CreatePdfAnchorOptions {
  selection: PdfReaderSelection;
  /** Content hash of the document revision the selection was made against. */
  contentHash: string;
  contextLength?: number;
}

export function createPdfAnchor(options: CreatePdfAnchorOptions): PdfAnchor {
  const { selection, contentHash, contextLength } = options;

  // The renderer may hand us raw page text; normalize before deriving anything from it so
  // offsets and hashes agree with what resolution will later compute.
  const pageText = normalizeText(selection.pageText);
  const exact = normalizeText(selection.text);

  // Re-derive offsets against the normalized page text. The renderer's offsets refer to
  // its own view of the text, which may include whitespace we just collapsed.
  const derived = locateInPage(pageText, exact, selection.position.start);

  const quote = createQuoteSelector(pageText, derived.start, derived.end, contextLength);

  return PdfAnchorSchema.parse({
    kind: 'pdf',
    version: PDF_ANCHOR_VERSION,
    pageIndex: selection.pageIndex,
    rects: selection.rects,
    quote: { ...quote, exact },
    position: derived,
    pageTextHash: taggedTextHash(pageText),
    contentHash,
  } satisfies PdfAnchor);
}

/**
 * Find `exact` in `pageText`, preferring the occurrence nearest `hintStart`. Falls back to
 * the hint offsets when the text is absent, which keeps anchor creation total; resolution
 * will then report a degraded match.
 */
function locateInPage(
  pageText: string,
  exact: string,
  hintStart: number,
): { start: number; end: number } {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = 0;
  for (;;) {
    const index = pageText.indexOf(exact, from);
    if (index === -1) break;
    const distance = Math.abs(index - hintStart);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
    from = index + 1;
  }
  if (best === -1) {
    const start = Math.min(hintStart, Math.max(0, pageText.length - exact.length));
    return { start, end: start + exact.length };
  }
  return { start: best, end: best + exact.length };
}

export interface ResolvePdfAnchorOptions {
  anchor: PdfAnchor;
  /** Raw or normalized text of the anchored page in the current revision. */
  pageText: string;
  /** Content hash of the revision being rendered. */
  contentHash?: string;
}

/**
 * Resolve an anchor against the current page text.
 *
 * Returns `null` when the quote cannot be found with acceptable confidence. A `null` here
 * means "broken anchor" and must be shown to the user, not hidden.
 */
export function resolvePdfAnchor(options: ResolvePdfAnchorOptions): ResolvedLocation | null {
  const { anchor, contentHash } = options;
  const pageText = normalizeText(options.pageText);

  const pageUnchanged = taggedTextHash(pageText) === anchor.pageTextHash;
  const revisionUnchanged = contentHash === undefined || contentHash === anchor.contentHash;

  // Unchanged page: the recorded offsets and rectangles are authoritative.
  if (pageUnchanged && revisionUnchanged) {
    const location: PdfLocation = {
      kind: 'pdf',
      pageIndex: anchor.pageIndex,
      rects: anchor.rects,
      textRange: anchor.position,
    };
    return { location, strategy: 'exact-position', confidence: 1 };
  }

  const resolution = resolveTextQuote(pageText, anchor.quote, anchor.position);
  if (resolution === null) return null;

  // Geometry is only trustworthy when the text did not move.
  const geometryValid = resolution.strategy === 'exact-position';
  const location: PdfLocation = geometryValid
    ? {
        kind: 'pdf',
        pageIndex: anchor.pageIndex,
        rects: anchor.rects,
        textRange: resolution.position,
      }
    : {
        kind: 'pdf',
        pageIndex: anchor.pageIndex,
        textRange: resolution.position,
      };

  return {
    location,
    strategy: resolution.strategy,
    confidence: resolution.confidence,
  };
}

/** Round-trip an anchor through JSON, validating on the way back in. */
export function serializePdfAnchor(anchor: PdfAnchor): string {
  return JSON.stringify(PdfAnchorSchema.parse(anchor));
}

export function deserializePdfAnchor(json: string): PdfAnchor {
  return PdfAnchorSchema.parse(JSON.parse(json));
}
