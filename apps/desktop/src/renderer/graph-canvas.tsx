/**
 * The drawing parts the graph surfaces share.
 *
 * Three surfaces now draw nodes and edges: the neighbourhood panel a graph is opened *on*, the
 * wiki page (`F01`) and the focused view (`F02`). They answer different questions and are
 * deliberately different views — but a node is a node, and three hand-written copies of "a disc,
 * a picture clipped into it, a label under it, focusable and keyboard-activatable" would drift
 * apart in exactly the details a test cannot see.
 *
 * What is *not* here is anything about what to draw. Layout comes from `@wr/graph`, the data
 * from a bounded channel, and the decision of what a click means belongs to the surface: on the
 * wiki page a node opens the thing, in the focused view a file at the edge refocuses the view.
 *
 * Nothing in this module talks to the main process, and it never sees a filesystem path — an
 * icon is a file id, addressed as `rrfile://<id>`, exactly as the neighbourhood panel does it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** The logical drawing area. The SVG scales it to whatever the panel is; nothing measures. */
export const VIEW_WIDTH = 1000;
export const VIEW_HEIGHT = 700;

/** The same bounds `GraphViewportSchema` states, so a gesture cannot lose the picture. */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;

export interface SceneViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const RESTING_VIEW: SceneViewport = { x: 0, y: 0, zoom: 1 };

const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

const round = (view: SceneViewport): SceneViewport => ({
  x: Math.round(view.x * 10) / 10,
  y: Math.round(view.y * 10) / 10,
  zoom: Math.round(clampZoom(view.zoom) * 1000) / 1000,
});

/**
 * Client pixels to the SVG's own units.
 *
 * `preserveAspectRatio="xMidYMid meet"` letterboxes the viewBox inside whatever the panel is,
 * so the mapping is one scale and two offsets — getting it wrong shows up as a graph that
 * slides away from the pointer while it zooms.
 */
function toViewBox(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const scale = Math.min(rect.width / VIEW_WIDTH, rect.height / VIEW_HEIGHT) || 1;
  return {
    x: (clientX - rect.left - (rect.width - VIEW_WIDTH * scale) / 2) / scale,
    y: (clientY - rect.top - (rect.height - VIEW_HEIGHT * scale) / 2) / scale,
  };
}

function viewBoxScale(svg: SVGSVGElement): number {
  const rect = svg.getBoundingClientRect();
  return Math.min(rect.width / VIEW_WIDTH, rect.height / VIEW_HEIGHT) || 1;
}

export interface SceneView {
  readonly view: SceneViewport;
  readonly reset: () => void;
  /** Spread onto the `<svg>`: pan, and the ref the wheel listener needs. */
  readonly svgProps: {
    readonly ref: (element: SVGSVGElement | null) => void;
    readonly onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
    readonly onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
    readonly onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
    readonly onPointerCancel: (event: React.PointerEvent<SVGSVGElement>) => void;
  };
}

/**
 * Pan and zoom over a drawn scene, held for as long as the panel is.
 *
 * Deliberately *not* persisted. `G01` persists the neighbourhood panel's viewport because that
 * view is opened on a seed and coming back to it is coming back to the same picture. A wiki page
 * and a focused view are not: the wiki redraws as the library grows, and a focused view is
 * re-seated on a different file every time it is crawled, so a remembered pan would put the next
 * file's picture somewhere the reader left the last one.
 */
export function useSceneView(): SceneView {
  const [view, setView] = useState<SceneViewport>(RESTING_VIEW);
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const current = useRef(view);
  current.current = view;

  // A native listener rather than `onWheel`: React registers wheel passively on the root, so
  // `preventDefault` from a synthetic handler is ignored and the panel scrolls under the
  // gesture instead of zooming.
  useEffect(() => {
    const svg = svgEl;
    if (svg === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const now = current.current;
      const zoom = clampZoom(now.zoom * Math.exp(-event.deltaY * 0.002));
      if (zoom === now.zoom) return;
      // Anchored on the pointer: what is under the cursor stays under the cursor.
      const at = toViewBox(svg, event.clientX, event.clientY);
      setView(
        round({
          x: at.x - (at.x - now.x) * (zoom / now.zoom),
          y: at.y - (at.y - now.y) * (zoom / now.zoom),
          zoom,
        }),
      );
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
    };
  }, [svgEl]);

  const drag = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    // A drag that starts on a node is not a pan: nodes are how these views are navigated, and
    // capturing the pointer here would swallow the click that follows one.
    if (event.target instanceof Element && event.target.closest('.wr-graph__node') !== null) return;
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    const scale = viewBoxScale(event.currentTarget);
    const now = current.current;
    setView(
      round({
        x: now.x + (event.clientX - active.clientX) / scale,
        y: now.y + (event.clientY - active.clientY) / scale,
        zoom: now.zoom,
      }),
    );
    drag.current = { ...active, clientX: event.clientX, clientY: event.clientY };
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const reset = useCallback(() => {
    setView(RESTING_VIEW);
  }, []);

  return {
    view,
    reset,
    svgProps: {
      ref: setSvgEl,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}

export function truncateLabel(text: string, max = 28): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface SceneNodeProps {
  /** `data-testid` is `<testIdPrefix>-<entityId>`; each surface names its own nodes. */
  readonly testIdPrefix: string;
  readonly entityType: string;
  readonly entityId: string;
  /** What the thing is called. Stays on the node as its tooltip even when renamed. */
  readonly title: string;
  readonly displayName: string | null;
  readonly iconFileId: string | null;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Marks the node the view is *about*, which the surfaces style as the seed. */
  readonly primary?: boolean;
  readonly showLabel?: boolean;
  /** The clip path this surface registered for this radius, addressed by id. */
  readonly clipPathId: string;
  /** Read by the assertions and by anyone reading the DOM: what activating this node does. */
  readonly action: 'open' | 'refocus';
  readonly onActivate: () => void;
  /** Extra `data-*` the surface wants on the node, for what only it knows. */
  readonly data?: Readonly<Record<string, string>>;
}

/**
 * One node: a disc, whatever picture it wears, and its label.
 *
 * A real focusable element rather than a shape on a canvas, for the reason the neighbourhood
 * panel gives — a node has to be reachable by keyboard and nameable by a test, and on a canvas
 * "click the node for this file" is a pixel calculation.
 */
export function SceneNode({
  testIdPrefix,
  entityType,
  entityId,
  title,
  displayName,
  iconFileId,
  x,
  y,
  radius,
  primary = false,
  showLabel = true,
  clipPathId,
  action,
  onActivate,
  data = {},
}: SceneNodeProps): JSX.Element {
  const label = displayName ?? title;
  const [iconLoaded, setIconLoaded] = useState(false);
  return (
    <g
      className={primary ? 'wr-graph__node wr-graph__node--seed' : 'wr-graph__node'}
      data-testid={`${testIdPrefix}-${entityId}`}
      data-entity-type={entityType}
      data-entity-id={entityId}
      data-x={String(Math.round(x))}
      data-y={String(Math.round(y))}
      data-action={action}
      data-display-name={displayName ?? ''}
      data-icon-file-id={iconFileId ?? ''}
      data-icon-loaded={iconFileId !== null && iconLoaded ? 'true' : 'false'}
      {...Object.fromEntries(Object.entries(data).map(([name, value]) => [`data-${name}`, value]))}
      role="button"
      tabIndex={0}
      aria-label={`${action === 'refocus' ? 'Focus on' : 'Open'} ${label}`}
      transform={`translate(${String(x)}, ${String(y)})`}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      <circle className="wr-graph__disc" r={radius} />
      {iconFileId !== null && (
        // `rrfile://<file id>` — built here, from an id the main process sent. A picture that
        // fails to load draws nothing and leaves the disc, which is why the disc is underneath
        // rather than replaced.
        <image
          className="wr-graph__icon"
          data-testid={`${testIdPrefix}-icon-${entityId}`}
          href={`rrfile://${iconFileId}`}
          x={-radius}
          y={-radius}
          width={radius * 2}
          height={radius * 2}
          preserveAspectRatio="xMidYMid slice"
          clipPath={`url(#${clipPathId})`}
          onLoad={() => {
            setIconLoaded(true);
          }}
          onError={() => {
            setIconLoaded(false);
          }}
        />
      )}
      <title>{title}</title>
      {showLabel && (
        <text className="wr-graph__label" y={radius + 18} textAnchor="middle">
          {truncateLabel(label)}
        </text>
      )}
    </g>
  );
}
