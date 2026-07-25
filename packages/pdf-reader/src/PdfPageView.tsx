import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { NormalizedRect } from '@wr/shared-types';
import type { PDFPageProxy } from './pdfjs.js';
import { TEXT_ITEM_ATTRIBUTE } from './dom-selection.js';

/** A highlight to paint over the page, already reduced to page-relative rectangles. */
export interface PageHighlight {
  readonly id: string;
  readonly color: string;
  readonly rects: readonly NormalizedRect[];
  readonly selected: boolean;
  readonly label: string;
}

export interface PdfPageViewProps {
  readonly page: PDFPageProxy;
  readonly pageIndex: number;
  readonly scale: number;
  /** Rendering is deferred until the page is near the viewport. */
  readonly active: boolean;
  readonly highlights: readonly PageHighlight[];
  readonly registerElement: (pageIndex: number, element: HTMLDivElement | null) => void;
}

/**
 * One rendered page: a canvas, a selectable text layer on top of it, and the highlight
 * overlay between them.
 *
 * The canvas and the text layer are rendered only while `active`, which the scroller drives
 * from an IntersectionObserver. A 400-page PDF otherwise allocates 400 canvases at once and
 * the renderer runs out of memory before the user has read the abstract. The placeholder
 * keeps the page's real height so the scrollbar does not jump as pages materialise.
 */
export function PdfPageView({
  page,
  pageIndex,
  scale,
  active,
  highlights,
  registerElement,
}: PdfPageViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(false);

  const viewport = page.getViewport({ scale });
  const width = Math.floor(viewport.width);
  const height = Math.floor(viewport.height);

  useEffect(() => {
    registerElement(pageIndex, containerRef.current);
    return () => {
      registerElement(pageIndex, null);
    };
  }, [pageIndex, registerElement]);

  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    const textLayerElement = textLayerRef.current;
    if (canvas === null || textLayerElement === null) return undefined;

    let cancelled = false;
    const pageViewport = page.getViewport({ scale });
    // Render at device resolution; CSS pixels stay at the layout size so the text layer,
    // which is positioned in CSS pixels, keeps lining up on a HiDPI display.
    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    canvas.width = Math.floor(pageViewport.width * ratio);
    canvas.height = Math.floor(pageViewport.height * ratio);

    const context = canvas.getContext('2d');
    if (context === null) return undefined;

    const task = page.render({
      canvasContext: context,
      viewport: pageViewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });

    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerElement,
      viewport: pageViewport,
    });

    void (async () => {
      try {
        await task.promise;
        await textLayer.render();
        if (cancelled) return;
        // Index every item element so a selection can be mapped back to item order.
        textLayer.textDivs.forEach((div, index) => {
          div.setAttribute(TEXT_ITEM_ATTRIBUTE, String(index));
        });
        setRendered(true);
      } catch {
        // A page that will not render is left as a placeholder rather than taking the
        // document down; the rest of the PDF stays readable.
      }
    })();

    return () => {
      cancelled = true;
      task.cancel();
      textLayer.cancel();
      textLayerElement.replaceChildren();
      setRendered(false);
    };
  }, [active, page, scale]);

  return (
    <div
      ref={containerRef}
      className="wr-pdf-page"
      data-testid={`pdf-page-${String(pageIndex)}`}
      data-page-index={pageIndex}
      data-rendered={rendered ? 'true' : 'false'}
      style={{ width: `${String(width)}px`, height: `${String(height)}px` }}
    >
      <canvas ref={canvasRef} className="wr-pdf-page__canvas" style={{ width, height }} />

      {/*
        Painted under the text layer and never interactive: the text layer has to receive
        every pointer event for selection to work, and a highlight that swallowed clicks
        would make the text under it unselectable. Selecting an annotation is done from the
        annotations panel, which is also where its comment lives.
      */}
      <div className="wr-pdf-page__highlights" aria-hidden="true">
        {highlights.map((highlight) =>
          highlight.rects.map((rect, index) => (
            <div
              key={`${highlight.id}-${String(index)}`}
              className={
                highlight.selected
                  ? 'wr-pdf-highlight wr-pdf-highlight--selected'
                  : 'wr-pdf-highlight'
              }
              data-testid={`pdf-highlight-${highlight.id}`}
              data-annotation-id={highlight.id}
              title={highlight.label}
              style={{
                left: `${String(rect.x1 * 100)}%`,
                top: `${String(rect.y1 * 100)}%`,
                width: `${String((rect.x2 - rect.x1) * 100)}%`,
                height: `${String((rect.y2 - rect.y1) * 100)}%`,
                background: highlight.color,
              }}
            />
          )),
        )}
      </div>

      {/*
        PDF.js positions every text span with `calc(var(--scale-factor) * Npx)`, where N is
        in unscaled PDF units. The variable therefore has to track the viewport scale
        exactly, or the invisible text drifts off the glyphs it is supposed to cover and
        selections come back wrong.
      */}
      <div
        ref={textLayerRef}
        className="wr-pdf-page__text-layer"
        style={{ '--scale-factor': scale } as CSSProperties}
      />

      <div className="wr-pdf-page__number" aria-hidden="true">
        {pageIndex + 1}
      </div>
    </div>
  );
}
