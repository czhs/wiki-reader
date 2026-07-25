/**
 * Selection -> anchor, kept beside the reader that produced the selection.
 *
 * The panel does not build anchors itself: the reader knows what its offsets mean, so the
 * conversion lives with it, exactly as `@wr/pdf-reader` and `@wr/markdown-reader` do.
 *
 * What a saved page's offsets mean is the extracted text of the snapshot under one particular
 * rendering, which is why `HtmlReaderSelection` carries `readerMode` and why it is passed
 * through rather than defaulted here.
 */
import { createHtmlAnchor } from '@wr/document-model';
import type { HtmlAnchor, HtmlReaderSelection } from '@wr/shared-types';

export function createHtmlAnchorFromSelection(
  selection: HtmlReaderSelection,
  snapshotHash: string,
): HtmlAnchor {
  return createHtmlAnchor({ selection, snapshotHash });
}
