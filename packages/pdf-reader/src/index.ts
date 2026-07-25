/**
 * @wr/pdf-reader — PDF presentation, selection capture, and highlight painting.
 *
 * This package is the *only* place in the application allowed to know about PDF.js
 * coordinates, viewports, or text-layer geometry (an invariant `CLAUDE.md` states and
 * `docs/SPEC.md` requires). Everything it exposes to the rest of the app is expressed in
 * `PdfLocation` / `PdfReaderSelection` terms.
 */
export { PdfReaderView, type PdfReaderViewProps } from './PdfReaderView.js';
export { PdfPageView, type PageHighlight, type PdfPageViewProps } from './PdfPageView.js';
export {
  captureSelection,
  TEXT_ITEM_ATTRIBUTE,
  type CaptureSelectionInput,
} from './dom-selection.js';
export {
  buildPageText,
  buildPdfSelection,
  estimateNormalizedStart,
  normalizeRects,
  type BuildSelectionInput,
  type PdfTextItemLike,
  type PixelRect,
  type SelectionOffsetInput,
} from './selection.js';
export { createPdfAnchorFromSelection } from './anchoring.js';
