/**
 * Extracted text -> indexable chunks.
 *
 * A chunk is the unit a search result points at, so its granularity decides how precisely a
 * hit can be revealed. For PDFs the page is the natural unit: it is what the reader can
 * scroll to, and `PdfLocation.pageIndex` addresses it directly. Long pages are split further
 * so that one hit does not drag a whole page of context into the snippet, and every split
 * carries the character offsets it covers within the page so a hit still maps back to an
 * exact `textRange`.
 */
import type { ChunkInput } from '@wr/database';

/** A page of extracted PDF text, in page order. */
export interface ExtractedPage {
  readonly pageIndex: number;
  readonly text: string;
}

export interface ChunkOptions {
  /**
   * Split a page once it exceeds this many characters. Pages under the limit stay whole so
   * that the common case keeps a 1:1 chunk-to-page mapping.
   */
  readonly maxChunkChars?: number;
  /**
   * Characters repeated from the end of the previous chunk, so a phrase that straddles a
   * split is still matchable as a phrase in at least one chunk.
   */
  readonly overlapChars?: number;
}

export const DEFAULT_MAX_CHUNK_CHARS = 2000;
export const DEFAULT_OVERLAP_CHARS = 160;

/**
 * Prefer to break at a paragraph, then a sentence, then a word, before resorting to a hard
 * cut mid-word. Searching for a term that a hard cut bisected would otherwise miss it.
 */
function findBreakPoint(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf(' ')];
  for (const candidate of candidates) {
    // Refuse a break so early that it would make near-empty chunks and never terminate.
    if (candidate > (to - from) * 0.5) return from + candidate;
  }
  return to;
}

/** Split one page's text into `[start, end)` ranges over that page's own text. */
export function splitPageText(
  text: string,
  options: ChunkOptions = {},
): Array<{ start: number; end: number }> {
  const maxChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlap = Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 2));
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [{ start: 0, end: text.length }];

  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;

  while (start < text.length) {
    const hardEnd = Math.min(start + maxChars, text.length);
    const end = hardEnd === text.length ? hardEnd : findBreakPoint(text, start, hardEnd);
    ranges.push({ start, end });
    if (end >= text.length) break;
    // Step back by `overlap` so a phrase straddling the break survives whole in the next
    // chunk. `start + 1` only guards termination; it must never be allowed to cancel the
    // overlap, which is why the floor is the old start and not the break point.
    start = Math.max(end - overlap, start + 1);
  }

  return ranges;
}

/**
 * Build the chunk rows for a PDF's extracted pages.
 *
 * `charStart`/`charEnd` are offsets **within the page**, not within the document: a PDF hit
 * is revealed by page plus an offset into that page's normalized text, and page-relative
 * offsets stay valid when an unrelated page is re-extracted.
 */
export function chunkPdfPages(
  pages: readonly ExtractedPage[],
  options: ChunkOptions = {},
): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    for (const range of splitPageText(page.text, options)) {
      const text = page.text.slice(range.start, range.end);
      if (text.trim().length === 0) continue;
      chunks.push({
        chunkIndex,
        kind: 'pdf-page',
        pageIndex: page.pageIndex,
        charStart: range.start,
        charEnd: range.end,
        text,
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}
