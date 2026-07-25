import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnnotationWithAnchor,
  PdfLocation,
  PdfReaderSelection,
  ResolvedLocation,
} from '@wr/shared-types';
import { resolvePdfAnchor } from '@wr/document-model';
import { loadPdf, pageTextItems, type PDFDocumentProxy, type PDFPageProxy } from './pdfjs.js';
import { PdfPageView, type PageHighlight } from './PdfPageView.js';
import { captureSelection } from './dom-selection.js';
import { buildPageText } from './selection.js';

export interface PdfReaderViewProps {
  readonly documentId: string;
  /** Always an `rrfile://` URL. The renderer never holds a filesystem path. */
  readonly fileUrl: string;
  /** Content hash of the revision being displayed, used to validate anchors. */
  readonly contentHash: string;
  readonly annotations: readonly AnnotationWithAnchor[];
  readonly selectedAnnotationId?: string | null;
  /** Where to scroll on mount — a restored reading position or a search hit. */
  readonly initialLocation?: PdfLocation | null;
  /** Changes to this land the reader on a new location without remounting. */
  readonly revealLocation?: PdfLocation | null;
  readonly onSelection?: (selection: PdfReaderSelection | null) => void;
  readonly onLocationChange?: (location: PdfLocation) => void;
  readonly onReady?: (pageCount: number) => void;
  readonly onError?: (message: string) => void;
  /**
   * Where each anchor actually resolved on the rendered pages, `null` for one that could
   * not be relocated. The reader is the only component that has the page text, so it is
   * the only one that can answer this — and the annotations panel is where the answer is
   * shown to the user.
   */
  readonly onResolutions?: (resolutions: ReadonlyMap<string, ResolvedLocation | null>) => void;
}

/** How far outside the viewport a page starts rendering. One screen in each direction. */
const RENDER_MARGIN_PX = 900;

/**
 * The PDF reader.
 *
 * Owns exactly one thing the rest of the application is not allowed to know about: PDF.js
 * coordinates. Everything leaving this component is a `PdfLocation` or a
 * `PdfReaderSelection` — page indices and 0..1 ratios — which is what lets search results,
 * annotations and navigation be written without a notion of a viewport.
 */
export function PdfReaderView({
  documentId,
  fileUrl,
  contentHash,
  annotations,
  selectedAnnotationId = null,
  initialLocation = null,
  revealLocation = null,
  onSelection,
  onLocationChange,
  onReady,
  onError,
  onResolutions,
}: PdfReaderViewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageElements = useRef(new Map<number, HTMLDivElement>());
  const pageTexts = useRef(new Map<number, string>());
  const didRestore = useRef(false);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<readonly PDFPageProxy[]>([]);
  const [activePages, setActivePages] = useState<ReadonlySet<number>>(new Set([0]));
  const [scale, setScale] = useState(1.2);
  const [failure, setFailure] = useState<string | null>(null);
  // Page text arrives page by page into a ref, which nothing re-renders on. This counter
  // is what turns "we now know what page 4 says" into a repaint, so a highlight whose text
  // moved is drawn in its new place instead of wherever it was when the page first mounted.
  const [textVersion, setTextVersion] = useState(0);

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    didRestore.current = false;
    pageTexts.current.clear();

    void (async () => {
      try {
        const { document, pageCount } = await loadPdf(fileUrl, controller.signal);
        if (disposed) {
          void document.destroy();
          return;
        }
        const loadedPages = await Promise.all(
          Array.from({ length: pageCount }, (_, index) => document.getPage(index + 1)),
        );
        if (disposed) {
          void document.destroy();
          return;
        }
        setPdf(document);
        setPages(loadedPages);
        setFailure(null);
        onReady?.(pageCount);
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setFailure(message);
        onError?.(message);
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
    // Keyed on `fileUrl` alone. `onReady`/`onError` are event callbacks, and depending on
    // them would reload and re-parse the whole PDF every time the parent re-rendered with
    // a fresh closure.
  }, [fileUrl]);

  useEffect(() => {
    return () => {
      if (pdf !== null) void pdf.destroy();
    };
  }, [pdf]);

  // --- which pages are worth rendering ------------------------------------
  const recomputeActive = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const top = scroller.scrollTop - RENDER_MARGIN_PX;
    const bottom = scroller.scrollTop + scroller.clientHeight + RENDER_MARGIN_PX;

    const next = new Set<number>();
    for (const [index, element] of pageElements.current) {
      const elementTop = element.offsetTop;
      const elementBottom = elementTop + element.offsetHeight;
      if (elementBottom >= top && elementTop <= bottom) next.add(index);
    }
    if (next.size === 0) next.add(0);
    setActivePages((previous) =>
      previous.size === next.size && [...next].every((index) => previous.has(index))
        ? previous
        : next,
    );
  }, []);

  const registerElement = useCallback(
    (pageIndex: number, element: HTMLDivElement | null) => {
      if (element === null) pageElements.current.delete(pageIndex);
      else pageElements.current.set(pageIndex, element);
      recomputeActive();
    },
    [recomputeActive],
  );

  // --- reading position ----------------------------------------------------
  const reportLocation = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null || onLocationChange === undefined) return;

    let best: { index: number; ratio: number } | null = null;
    for (const [index, element] of pageElements.current) {
      const top = element.offsetTop - scroller.scrollTop;
      const bottom = top + element.offsetHeight;
      if (bottom <= 0 || top >= scroller.clientHeight) continue;
      if (best === null || index < best.index) {
        const ratio = element.offsetHeight === 0 ? 0 : Math.min(1, Math.max(0, -top / element.offsetHeight));
        best = { index, ratio };
      }
    }
    if (best !== null) {
      onLocationChange({ kind: 'pdf', pageIndex: best.index, pageOffsetRatio: best.ratio });
    }
  }, [onLocationChange]);

  const handleScroll = useCallback(() => {
    recomputeActive();
    reportLocation();
  }, [recomputeActive, reportLocation]);

  // --- revealing a location -------------------------------------------------
  const reveal = useCallback((location: PdfLocation) => {
    const scroller = scrollRef.current;
    const element = pageElements.current.get(location.pageIndex);
    if (scroller === null || element === undefined) return false;
    const offset = (location.pageOffsetRatio ?? 0) * element.offsetHeight;
    scroller.scrollTo({ top: element.offsetTop + offset, behavior: 'auto' });
    return true;
  }, []);

  // Restore once, after the pages exist and have been measured.
  useEffect(() => {
    if (didRestore.current || pages.length === 0 || initialLocation === null) return;
    if (reveal(initialLocation)) {
      didRestore.current = true;
      recomputeActive();
    }
  }, [pages, initialLocation, reveal, recomputeActive]);

  useEffect(() => {
    if (revealLocation === null || pages.length === 0) return;
    if (reveal(revealLocation)) recomputeActive();
  }, [revealLocation, pages, reveal, recomputeActive]);

  // --- page text, for anchoring ---------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let learned = false;
      for (const [index, page] of pages.entries()) {
        if (cancelled) return;
        if (pageTexts.current.has(index)) continue;
        if (!activePages.has(index)) continue;
        const items = await pageTextItems(page);
        if (cancelled) return;
        pageTexts.current.set(index, buildPageText(items));
        learned = true;
      }
      if (learned && !cancelled) setTextVersion((value) => value + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [pages, activePages]);

  // --- selection -------------------------------------------------------------
  const handleMouseUp = useCallback(() => {
    if (onSelection === undefined) return;
    const selection = window.getSelection();
    if (selection === null) {
      onSelection(null);
      return;
    }

    for (const [index, element] of pageElements.current) {
      const textLayer = element.querySelector<HTMLElement>('.wr-pdf-page__text-layer');
      if (textLayer === null || selection.rangeCount === 0) continue;
      if (!textLayer.contains(selection.getRangeAt(0).startContainer)) continue;

      const pageText = pageTexts.current.get(index);
      if (pageText === undefined) continue;

      onSelection(
        captureSelection({
          selection,
          pageIndex: index,
          pageText,
          pageElement: element,
          textLayer,
        }),
      );
      return;
    }
    onSelection(null);
  }, [onSelection]);

  // --- highlights ------------------------------------------------------------
  const painted = useMemo(() => {
    const byPage = new Map<number, PageHighlight[]>();
    const resolutions = new Map<string, ResolvedLocation | null>();
    for (const annotation of annotations) {
      const anchor = annotation.anchor;
      if (anchor.kind !== 'pdf') continue;

      // Resolution decides *where* to paint. An anchor whose page text still hashes the
      // same keeps its original rectangles; one whose page changed is relocated by quote,
      // and if it cannot be relocated it is not painted at all — a highlight drawn over
      // arbitrary text would be worse than a missing one. The annotations panel is where
      // a broken anchor is reported.
      const pageText = pageTexts.current.get(anchor.pageIndex);
      let rects = anchor.rects;
      if (pageText !== undefined) {
        const resolved = resolvePdfAnchor({ anchor, pageText, contentHash });
        resolutions.set(annotation.id, resolved);
        if (resolved === null) continue;
        if (resolved.location.kind === 'pdf' && resolved.location.rects !== undefined) {
          rects = resolved.location.rects;
        }
      }
      if (rects.length === 0) continue;

      const list = byPage.get(anchor.pageIndex) ?? [];
      list.push({
        id: annotation.id,
        color: annotation.color,
        rects,
        selected: annotation.id === selectedAnnotationId,
        label: annotation.selectedText,
      });
      byPage.set(anchor.pageIndex, list);
    }
    return { byPage, resolutions };
    // `textVersion` is the dependency that matters: page text lives in a ref, so without it
    // the highlights would keep the positions they were given before the page was read.
  }, [annotations, selectedAnnotationId, contentHash, textVersion]);

  useEffect(() => {
    onResolutions?.(painted.resolutions);
    // Keyed on the computed map only. Including the callback would re-report on every
    // parent render, and the parent typically sets state from it.
  }, [painted]);

  if (failure !== null) {
    return (
      <div className="wr-pdf" data-testid="pdf-reader-error" role="alert">
        <p>This PDF could not be opened.</p>
        <p className="wr-state__hint">{failure}</p>
      </div>
    );
  }

  return (
    <div className="wr-pdf" data-testid="pdf-reader" data-document-id={documentId}>
      <div className="wr-pdf__toolbar">
        <button
          type="button"
          className="wr-button wr-button--icon"
          aria-label="Zoom out"
          onClick={() => setScale((value) => Math.max(0.5, Number((value - 0.2).toFixed(2))))}
        >
          −
        </button>
        <span className="wr-pdf__zoom">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="wr-button wr-button--icon"
          aria-label="Zoom in"
          onClick={() => setScale((value) => Math.min(4, Number((value + 0.2).toFixed(2))))}
        >
          +
        </button>
        <span className="wr-pdf__pages" data-testid="pdf-page-count">
          {pages.length === 0 ? 'loading…' : `${String(pages.length)} pages`}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="wr-pdf__scroll"
        data-testid="pdf-scroll"
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
      >
        {pages.map((page, index) => (
          <PdfPageView
            key={index}
            page={page}
            pageIndex={index}
            scale={scale}
            active={activePages.has(index)}
            highlights={painted.byPage.get(index) ?? []}
            registerElement={registerElement}
          />
        ))}
      </div>
    </div>
  );
}
