import type { PdfAnchor, PdfReaderSelection } from '@wr/shared-types';
import { createPdfAnchor } from '@wr/document-model';

/**
 * Turn a live reader selection into the durable anchor that gets persisted.
 *
 * A one-line wrapper on purpose: it is the seam that keeps `contentHash` from being
 * forgotten at a call site. An anchor without the revision hash it was made against cannot
 * tell "the page is unchanged, trust the rectangles" from "the document was re-imported,
 * relocate by quote" — which is the whole reason anchors survive a re-import.
 */
export function createPdfAnchorFromSelection(
  selection: PdfReaderSelection,
  contentHash: string,
): PdfAnchor {
  return createPdfAnchor({ selection, contentHash });
}
