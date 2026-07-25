/**
 * The DOM half of selection capture: read a live `Selection` and hand the pure layer in
 * `selection.ts` the numbers it needs. Everything here touches the DOM and nothing here
 * makes a decision, so the interesting logic stays testable without a browser.
 */
import type { PdfReaderSelection } from '@wr/shared-types';
import {
  buildPdfSelection,
  estimateNormalizedStart,
  normalizeRects,
  type PixelRect,
} from './selection.js';

/** Marks the elements that carry one PDF.js text item. Set by the text layer renderer. */
export const TEXT_ITEM_ATTRIBUTE = 'data-wr-item';

function toPixelRect(rect: DOMRect): PixelRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/** The text-layer element containing a node, or `null` when the node is outside the layer. */
function itemElementFor(node: Node, layer: HTMLElement): HTMLElement | null {
  const start = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  const element = start?.closest(`[${TEXT_ITEM_ATTRIBUTE}]`) ?? null;
  return element !== null && layer.contains(element) ? (element as HTMLElement) : null;
}

export interface CaptureSelectionInput {
  readonly selection: Selection;
  readonly pageIndex: number;
  readonly pageText: string;
  /** The element whose box defines 0..1 — the rendered page, not the scroll container. */
  readonly pageElement: HTMLElement;
  readonly textLayer: HTMLElement;
}

/**
 * Capture the current selection as a `PdfReaderSelection`.
 *
 * Returns `null` for anything not anchorable: a collapsed caret, a selection that starts
 * outside this page's text layer, or one that normalizes away to nothing. A selection
 * spanning two pages is captured against the page it *starts* on — the anchor model is
 * page-scoped, and truncating is more honest than silently anchoring to the wrong page.
 */
export function captureSelection(input: CaptureSelectionInput): PdfReaderSelection | null {
  const { selection, textLayer, pageElement } = input;
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!textLayer.contains(range.startContainer)) return null;

  const items = [...textLayer.querySelectorAll<HTMLElement>(`[${TEXT_ITEM_ATTRIBUTE}]`)];
  const itemTexts = items.map((item) => item.textContent ?? '');

  const startElement = itemElementFor(range.startContainer, textLayer);
  const startItemIndex = startElement === null ? 0 : items.indexOf(startElement);

  const hintStart = estimateNormalizedStart({
    itemTexts,
    startItemIndex: Math.max(0, startItemIndex),
    startOffsetInItem: range.startOffset,
  });

  const rects = normalizeRects(
    [...range.getClientRects()].map(toPixelRect),
    toPixelRect(pageElement.getBoundingClientRect()),
  );

  return buildPdfSelection({
    pageIndex: input.pageIndex,
    pageText: input.pageText,
    selectedText: selection.toString(),
    rects,
    hintStart,
  });
}
