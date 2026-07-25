/**
 * Turning a live DOM selection in the PDF text layer into a durable `PdfReaderSelection`.
 *
 * The hard part is offsets. The text layer contains one element per PDF.js text item, with
 * whatever spacing the PDF happened to encode; the *anchor* is expressed as offsets into the
 * page's normalized text, which is what the extractor indexed and what a highlight is later
 * resolved against. Mapping between the two exactly would mean reimplementing normalization
 * as an offset-preserving transform, and getting it subtly wrong would silently misplace
 * highlights.
 *
 * Instead this module produces a *hint*: the normalized length of everything before the
 * selection. `createPdfAnchor` then locates the selected text in the page and picks the
 * occurrence nearest the hint. That is exact whenever the text appears once (the common
 * case), correct-by-proximity when it repeats, and degrades to the hint itself when the
 * text cannot be found at all — never to a wrong-but-confident offset.
 */
import type { NormalizedRect, PdfReaderSelection } from '@wr/shared-types';
import { joinPdfTextItems, normalizeText } from '@wr/document-model';

/** The subset of the PDF.js text-item shape the reader depends on. */
export interface PdfTextItemLike {
  readonly str: string;
  readonly hasEOL?: boolean;
}

/**
 * Build a page's canonical text.
 *
 * Identical to what `@wr/text-extraction-worker` does at index time, and that is not a
 * coincidence to be maintained by hand: both call the same two functions from
 * `@wr/document-model`. If they ever diverged, every anchor created in the reader would
 * carry offsets into a string the index has never seen.
 */
export function buildPageText(items: readonly PdfTextItemLike[]): string {
  return normalizeText(joinPdfTextItems(items));
}

/** A rectangle as the DOM reports it, in viewport pixels. */
export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Convert viewport rectangles to page-relative 0..1 coordinates.
 *
 * Persisting pixels would tie a highlight to the zoom level, window size and device pixel
 * ratio it was created at. Ratios survive all three, which is why `PdfAnchor.rects` is
 * defined this way.
 *
 * Zero-area rectangles are dropped: `getClientRects` emits them for collapsed ranges and
 * line boundaries, and they would render as invisible highlight fragments.
 */
export function normalizeRects(
  rects: readonly PixelRect[],
  pageRect: PixelRect,
): NormalizedRect[] {
  const width = pageRect.right - pageRect.left;
  const height = pageRect.bottom - pageRect.top;
  if (width <= 0 || height <= 0) return [];

  const out: NormalizedRect[] = [];
  for (const rect of rects) {
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) continue;
    out.push({
      x1: clamp01((rect.left - pageRect.left) / width),
      y1: clamp01((rect.top - pageRect.top) / height),
      x2: clamp01((rect.right - pageRect.left) / width),
      y2: clamp01((rect.bottom - pageRect.top) / height),
    });
  }
  return out;
}

export interface SelectionOffsetInput {
  /** Raw text of every text-layer element on the page, in reading order. */
  readonly itemTexts: readonly string[];
  /** Index of the element the selection starts in. */
  readonly startItemIndex: number;
  /** Character offset within that element's raw text. */
  readonly startOffsetInItem: number;
}

/**
 * Estimate where a selection starts within the page's *normalized* text.
 *
 * Normalizing the prefix rather than the whole page and slicing means the estimate absorbs
 * the same whitespace collapsing the full text underwent, so it stays close even on pages
 * with heavy inter-item spacing.
 */
export function estimateNormalizedStart(input: SelectionOffsetInput): number {
  const { itemTexts, startItemIndex, startOffsetInItem } = input;
  const before = itemTexts.slice(0, Math.max(0, startItemIndex));
  const partial = itemTexts[startItemIndex]?.slice(0, Math.max(0, startOffsetInItem)) ?? '';
  return normalizeText([...before, partial].join(' ')).length;
}

export interface BuildSelectionInput {
  readonly pageIndex: number;
  /** The page's canonical text, from `buildPageText`. */
  readonly pageText: string;
  /** What the user actually selected, as the DOM reports it. */
  readonly selectedText: string;
  readonly rects: readonly NormalizedRect[];
  readonly hintStart: number;
}

/**
 * Assemble the reader selection, or `null` when there is nothing anchorable.
 *
 * An empty or whitespace-only selection is not an error — it is what a stray click
 * produces — so it yields `null` rather than throwing.
 */
export function buildPdfSelection(input: BuildSelectionInput): PdfReaderSelection | null {
  const exact = normalizeText(input.selectedText);
  if (exact.length === 0) return null;
  if (input.rects.length === 0) return null;

  const start = Math.min(Math.max(0, input.hintStart), Math.max(0, input.pageText.length));
  return {
    kind: 'pdf',
    pageIndex: input.pageIndex,
    rects: [...input.rects],
    text: exact,
    pageText: input.pageText,
    position: { start, end: start + exact.length },
  };
}
