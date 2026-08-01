import type {
  AnnotationAnchor,
  DocumentChunk,
  DocumentLocation,
  HtmlAnchor,
  HtmlLocation,
  MarkdownAnchor,
  MarkdownLocation,
  PdfAnchor,
  PdfLocation,
} from '@wr/shared-types';

/**
 * Anchor -> location projection.
 *
 * An anchor is *evidence* (quote, offsets, hashes); a location is *where to scroll*.
 * This derives the naive location an anchor claims, without attempting to resolve it
 * against the current text — that is `resolvePdfAnchor` / `resolveTextQuote`. Use this
 * for link targets and search results, where re-resolution happens in the reader.
 */

export function pdfAnchorToLocation(anchor: PdfAnchor): PdfLocation {
  return {
    kind: 'pdf',
    pageIndex: anchor.pageIndex,
    rects: anchor.rects,
    textRange: anchor.position,
  };
}

export function htmlAnchorToLocation(anchor: HtmlAnchor): HtmlLocation {
  // No `textRange` when the anchor recorded no offsets: `HtmlLocation` says where to scroll,
  // and an anchor that could not find its words in the extracted text does not know.
  const base: HtmlLocation = {
    kind: 'html',
    readerMode: anchor.readerMode,
    ...(anchor.position === undefined ? {} : { textRange: anchor.position }),
    quote: anchor.quote,
  };
  return anchor.sectionPath === undefined ? base : { ...base, sectionPath: anchor.sectionPath };
}

export function markdownAnchorToLocation(anchor: MarkdownAnchor): MarkdownLocation {
  return {
    kind: 'markdown',
    textRange: anchor.position,
    quote: anchor.quote,
    ...(anchor.headingPath === undefined ? {} : { headingPath: anchor.headingPath }),
  };
}

export function anchorToLocation(anchor: AnnotationAnchor): DocumentLocation {
  switch (anchor.kind) {
    case 'pdf':
      return pdfAnchorToLocation(anchor);
    case 'html':
      return htmlAnchorToLocation(anchor);
    case 'markdown':
      return markdownAnchorToLocation(anchor);
  }
}

/**
 * The location a search hit inside a chunk should open.
 *
 * This is what makes "search result -> exact page" work: the chunk records which page or
 * section its text came from, so the result carries a location rather than only a
 * document id.
 */
export function chunkToLocation(
  chunk: Pick<DocumentChunk, 'kind' | 'pageIndex' | 'sectionPath' | 'chunkIndex'>,
): DocumentLocation {
  switch (chunk.kind) {
    case 'pdf-page':
      return { kind: 'pdf', pageIndex: chunk.pageIndex ?? 0 };
    case 'html-section': {
      const base: HtmlLocation = { kind: 'html', readerMode: 'readability' };
      return chunk.sectionPath === null ? base : { ...base, sectionPath: chunk.sectionPath };
    }
    case 'markdown-section': {
      const base: MarkdownLocation = { kind: 'markdown' };
      return chunk.sectionPath === null ? base : { ...base, headingPath: chunk.sectionPath };
    }
    case 'note-block':
      return { kind: 'note', blockIndex: chunk.chunkIndex };
  }
}

/** Human-readable label for a location, used in link results and the peek widget. */
export function describeLocation(location: DocumentLocation | null): string {
  if (location === null) return '';
  switch (location.kind) {
    case 'pdf':
      return `page ${location.pageIndex + 1}`;
    case 'html':
      return location.sectionPath ?? 'article';
    case 'markdown':
      return location.headingPath ?? 'document';
    case 'note':
      return location.blockIndex === undefined ? 'note' : `block ${location.blockIndex + 1}`;
  }
}
