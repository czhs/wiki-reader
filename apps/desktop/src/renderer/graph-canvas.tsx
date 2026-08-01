/**
 * The drawing parts the graph surfaces share.
 *
 * Three surfaces draw nodes and edges: the neighbourhood panel a graph is opened *on*, the wiki
 * page (`F01`) and the focused view (`F02`). They answer different questions and are deliberately
 * different views — but a node is a node, and three hand-written copies of "a disc, a picture
 * clipped into it, a label under it, focusable and keyboard-activatable" would drift apart in
 * exactly the details a test cannot see. The same goes for the gestures over them: pan and zoom
 * are one implementation here, and where the resulting viewport is *kept* is the surface's own
 * business.
 *
 * What is *not* here is anything about what to draw. Layout comes from `@wr/graph`, the data
 * from a bounded channel, and the decision of what a click means belongs to the surface: on the
 * wiki page a node opens the thing, in the focused view a file at the edge refocuses the view.
 *
 * Nothing in this module talks to the main process, and it never sees a filesystem path — an
 * icon is a file id, addressed as `rrfile://<id>`, exactly as the neighbourhood panel does it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { GraphViewport } from '@wr/shared-types';

/** The logical drawing area. The SVG scales it to whatever the panel is; nothing measures. */
export const VIEW_WIDTH = 1000;
export const VIEW_HEIGHT = 700;

/** The same bounds `GraphViewportSchema` states, so a gesture cannot lose the picture. */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;

export const RESTING_VIEW: GraphViewport = { x: 0, y: 0, zoom: 1 };

const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/**
 * Rounded and clamped, so a viewport read back out of the database compares equal to the one
 * written and no gesture can push the picture past what the channel will accept.
 */
export const roundViewport = (view: GraphViewport): GraphViewport => ({
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

/** Spread onto the `<svg>`: pan, and the ref the wheel listener needs. */
export interface SceneSvgProps {
  readonly ref: (element: SVGSVGElement | null) => void;
  readonly onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
  readonly onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
  readonly onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
  readonly onPointerCancel: (event: React.PointerEvent<SVGSVGElement>) => void;
}

export interface SceneView {
  readonly view: GraphViewport;
  readonly reset: () => void;
  readonly svgProps: SceneSvgProps;
}

/**
 * Pan and zoom over a drawn scene, reporting every move to whoever owns the viewport.
 *
 * Controlled rather than stateful, because the three surfaces disagree about *where* the
 * viewport lives and about nothing else. `G01` persists the neighbourhood panel's, because that
 * view is opened on a seed and coming back to it is coming back to the same picture; the wiki
 * page and the focused view keep theirs in the panel, because the wiki redraws as the library
 * grows and a focused view is re-seated every time it is crawled. That is one decision, and it
 * does not justify two copies of the pointer arithmetic — a drag that pans by the wrong scale
 * on one surface and not the other is exactly the drift a shared hook prevents.
 *
 * `onView` is read through a ref, so a caller whose handler identity changes — one that saves
 * through a debounce keyed on the seed, say — does not re-register the wheel listener mid-gesture.
 */
export function useSceneGestures(view: GraphViewport, onView: (next: GraphViewport) => void): SceneSvgProps {
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const current = useRef(view);
  current.current = view;
  const report = useRef(onView);
  report.current = onView;

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
      report.current(
        roundViewport({
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
    report.current(
      roundViewport({
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

  return {
    ref: setSvgEl,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };
}

/**
 * Pan and zoom held for as long as the panel is showing the same thing, and no longer.
 *
 * What the wiki page and the focused view want: a remembered pan would put the next file's
 * picture somewhere the reader left the last one's.
 *
 * `subject` is what the scene is *of* — the focused view passes the file it is seated on. A
 * crawl (`F03`) re-seats one panel rather than opening a second, so React keeps the component
 * mounted and this state would survive onto a file it was never taken for: every focused file
 * is laid out at the middle of the scene, so a viewport panned to the last file's edge draws
 * the new one off the panel entirely. The rule belongs here, where it is written down, and not
 * in each caller remembering to reset. Omit it for a surface with one subject for its whole
 * life, like the wiki page.
 */
export function useSceneView(subject?: string): SceneView {
  const [view, setView] = useState<GraphViewport>(RESTING_VIEW);
  const svgProps = useSceneGestures(view, setView);
  const reset = useCallback(() => {
    setView(RESTING_VIEW);
  }, []);
  const seated = useRef(subject);
  if (seated.current !== subject) {
    // During render rather than in an effect: the scene is drawn from `view` in this same pass,
    // and a reset one frame later is a visible jump from the old viewport to the new one.
    seated.current = subject;
    if (view !== RESTING_VIEW) setView(RESTING_VIEW);
  }
  return { view, reset, svgProps };
}

/**
 * The group everything drawn is inside, moved and scaled by the viewport.
 *
 * A `<g>` transform rather than a changing `viewBox`, so the arrangement `@wr/graph` computed
 * is what the elements carry and panning is not a re-layout. The three `data-*` are how a test
 * reads where the view is without measuring pixels, which is also why the transform and the
 * attributes are written in one place: a surface whose attributes disagreed with its transform
 * would pass its own assertions while showing something else.
 */
export function SceneViewportGroup({
  testId,
  view,
  children,
}: {
  readonly testId: string;
  readonly view: GraphViewport;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <g
      data-testid={testId}
      data-pan-x={String(view.x)}
      data-pan-y={String(view.y)}
      data-zoom={String(view.zoom)}
      transform={`translate(${String(view.x)} ${String(view.y)}) scale(${String(view.zoom)})`}
    >
      {children}
    </g>
  );
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
  /**
   * Read by the assertions and by anyone reading the DOM: what activating this node does.
   *
   * `pick` is the link picker's (`H04`) — the same nodes, chosen as the other end of an edge
   * rather than navigated to. A third value on the path the other two already take, so that
   * "what does clicking this do" stays one question with one answer per surface.
   */
  readonly action: 'open' | 'refocus' | 'pick';
  readonly onActivate: () => void;
  /** Extra `data-*` the surface wants on the node, for what only it knows. */
  readonly data?: Readonly<Record<string, string>>;
}

/** How each action reads in the node's accessible name. */
const ACTION_VERBS: Readonly<Record<SceneNodeProps['action'], string>> = {
  open: 'Open',
  refocus: 'Focus on',
  pick: 'Link to',
};

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
      aria-label={`${ACTION_VERBS[action]} ${label}`}
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
