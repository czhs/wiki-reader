/**
 * Selection -> anchor, kept beside the reader that produced the selection.
 *
 * The panel does not build anchors itself: the reader knows what its offsets mean, so the
 * conversion lives with it, exactly as `@wr/pdf-reader` does for a PDF.
 */
import { createMarkdownAnchor } from '@wr/document-model';
import type { MarkdownAnchor, MarkdownReaderSelection } from '@wr/shared-types';

export function createMarkdownAnchorFromSelection(
  selection: MarkdownReaderSelection,
  sourceHash: string,
): MarkdownAnchor {
  return createMarkdownAnchor({ selection, sourceHash });
}
