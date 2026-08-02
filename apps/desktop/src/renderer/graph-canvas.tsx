/**
 * The drawing parts the graph surfaces share.
 *
 * Three bodies draw nodes and edges: the neighbourhood panel a graph is opened *on*, and the two
 * states of the wiki — whole (`F01`) and focused on one file (`F02`, `F05`). They answer
 * different questions and are deliberately different views — but a node is a node, and three
 * hand-written copies of "a disc, a picture clipped into it, a label under it, focusable and
 * keyboard-activatable" would drift apart in exactly the details a test cannot see. The same
 * goes for the gestures over them: pan and zoom are one implementation here, and where the
 * resulting viewport is *kept* is the surface's own business.
 *
 * The panel itself is measured here too, because the `viewBox` is its own size in CSS pixels and
 * the scene's fit inside it is *held* rather than recomputed on every resize (`F04`) — see
 * `SceneFit`. Three surfaces recomputing that would be three answers to "how big is a disc".
 *
 * What is *not* here is anything about what to draw. Layout comes from `@wr/graph`, the data
 * from a bounded channel, and the decision of what a click means belongs to the surface: on the
 * wiki page a node opens the thing, in the focused view a file at the edge refocuses the view.
 *
 * Nothing in this module talks to the main process, and it never sees a filesystem path — an
 * icon is a file id, addressed as `rrfile://<id>`, exactly as the neighbourhood panel does it.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { collapseWhitespace, ellipsize } from '@wr/document-model';
import { classNames } from '@wr/shared-ui';
import type { GraphViewport } from '@wr/shared-types';

/**
 * The extra facts a surface hangs on an element it drew, as `data-*` attributes.
 *
 * A node, an edge and a group box all take one of these, and each had its own copy of the same
 * spread. The three surfaces differ in *what* they can say about a thing they draw — a
 * neighbourhood knows a node's distance, the focused view knows whether a far end is a sentence
 * or a paper — and that difference belongs in the surface. The prefixing does not.
 */
function dataAttrs(data: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(data).map(([name, value]) => [`data-${name}`, value]));
}

/** How much of a label fits under a disc before it starts drawing over its neighbour's. */
const LABEL_LIMIT = 28;

/**
 * How much of a marked sentence the map draws (`F06`).
 *
 * One line was not enough to know what a highlight was. Twenty-eight characters of a sentence
 * is a fragment — "the model appears to have le…" — and a map full of fragments makes the
 * researcher click every disc to find the one they meant, which is the opposite of what a map
 * is for. The words already arrive: `graph:overview` sends up to 120 characters of the
 * highlight. So the label wraps onto its own lines instead of being cut to fit one.
 *
 * Three lines and not more, because a label is drawn *under* its disc and a fourth line starts
 * writing over whatever is beneath it. The width is a little narrower than a title's for the
 * same reason a column of prose is narrower than a heading: three stacked lines of 28 would be
 * a block wide enough to collide with the discs either side of it.
 */
const QUOTE_LINE_LIMIT = 24;
const QUOTE_LINES = 3;
/** Baseline-to-baseline for the wrapped lines, in scene units. */
const QUOTE_LINE_HEIGHT = 13;

/** The logical drawing area. The scene is laid out in these units on every surface. */
export const VIEW_WIDTH = 1000;
export const VIEW_HEIGHT = 700;

/**
 * A quotation broken into the lines the map will draw (`F06`).
 *
 * Greedy word wrapping, because the alternative — measuring text in the SVG — would make the
 * label depend on a font that has loaded, and a label that reflows when a font arrives is a map
 * that moves under the pointer. A word too long for a line is cut rather than allowed to run
 * over its neighbours, and a sentence that does not fit in the lines allowed ends in an
 * ellipsis, so "there is more of this" is on the page rather than inferred from a full line.
 */
export function quoteLines(
  text: string,
  width: number = QUOTE_LINE_LIMIT,
  maxLines: number = QUOTE_LINES,
): readonly string[] {
  const collapsed = collapseWhitespace(text);
  const words = collapsed.split(' ').filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    if (lines.length === maxLines) {
      current = '';
      break;
    }
    current = word.length <= width ? word : ellipsize(word, width);
  }
  if (current !== '' && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) return [''];
  const shown = lines.join(' ');
  if (shown.length >= collapsed.length) return lines;
  const last = lines[lines.length - 1] ?? '';
  lines[lines.length - 1] = last.endsWith('…')
    ? last
    : last.length + 1 <= width
      ? `${last}…`
      : ellipsize(last, width);
  return lines;
}

/**
 * How the scene sits inside the panel: a scale and the offsets that centre it.
 *
 * This used to be `preserveAspectRatio="xMidYMid meet"` — the browser recomputing the fit on
 * every resize, which is exactly what `F04` forbids. A docked wiki is meant to be a *smaller
 * window onto the same map*, not the same map drawn smaller, so the **scale** is captured when
 * the surface is first measured and then held: the viewBox grows and shrinks with the panel
 * while the scale stays put, and what changes is how much of the scene is inside it.
 *
 * The two offsets are not held with it, and holding them was a bug a resize made visible. They
 * are measured from the panel's top-left corner, so a panel that grew kept the map where it had
 * been and put every new pixel down the right-hand side: widen the window, or drag a docked
 * wiki back into the middle of the workspace, and the map sat in the corner with half the panel
 * empty beside it — and the file a focused view is *centred on* (`F09`) was two hundred pixels
 * off centre. So the window onto the map opens and closes around its own middle: same scale,
 * same picture, still centred.
 */
export interface SceneFit {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** The panel as the scene sees it: its own size in CSS pixels, and the fit held inside it. */
export interface SceneCanvas {
  readonly width: number;
  readonly height: number;
  readonly fit: SceneFit;
}

/** A scale, centred in a panel of this size. */
function centredFit(scale: number, width: number, height: number): SceneFit {
  return {
    scale: Math.round(scale * 1000) / 1000,
    x: Math.round(((width - VIEW_WIDTH * scale) / 2) * 10) / 10,
    y: Math.round(((height - VIEW_HEIGHT * scale) / 2) * 10) / 10,
  };
}

function fitInto(width: number, height: number): SceneFit {
  return centredFit(Math.min(width / VIEW_WIDTH, height / VIEW_HEIGHT) || 1, width, height);
}

const RESTING_CANVAS: SceneCanvas = {
  width: VIEW_WIDTH,
  height: VIEW_HEIGHT,
  fit: { scale: 1, x: 0, y: 0 },
};

/**
 * What a thing is called inside a scene: `<entityType> <entityId>`.
 *
 * Positions, containment, the filter's matches and Cytoscape's own model are all keyed on it,
 * and all three surfaces had their own copy of the same one-liner. One spelling, because these
 * keys are compared *across* those structures — a surface that keyed its positions one way and
 * its matches another would dim the right nodes and pan to nothing.
 */
export const sceneKey = (entityType: string, entityId: string): string =>
  `${entityType} ${entityId}`;

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
 * Client pixels to the scene's own units.
 *
 * The viewBox is the panel's own size, so one SVG unit is one CSS pixel and the whole of the
 * mapping is the held fit: one scale and two offsets. Getting it wrong shows up as a graph that
 * slides away from the pointer while it zooms, which is why the arithmetic is written once here
 * rather than in each surface.
 */
function toScene(
  fit: SceneFit,
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  return {
    x: (clientX - rect.left - fit.x) / fit.scale,
    y: (clientY - rect.top - fit.y) / fit.scale,
  };
}

/**
 * Searching a graph in place (`V02`).
 *
 * A map is not a list, so the answer to "where is the thing I am thinking of" cannot be a list
 * of results: what the researcher wants is *this map, with that thing found on it*. So a filter
 * here neither hides nor re-lays-out anything — the arrangement is what makes a map a place,
 * and a map that rearranges itself as you type is a different map each keystroke. It dims what
 * does not match and moves the view to what does.
 *
 * The matching rule is the file palette's, deliberately: `Cmd+P` and this box are one gesture
 * with two vocabularies, and a researcher who has learned that typing part of a title finds a
 * file should not discover that the map wants something else.
 */
export function filterNeedle(query: string): string {
  return query.trim().toLowerCase();
}

/** True when any of the texts contains the needle. An empty needle matches everything. */
export function matchesNeedle(
  needle: string,
  ...texts: readonly (string | null | undefined)[]
): boolean {
  if (needle === '') return true;
  return texts.some((text) => (text ?? '').toLowerCase().includes(needle));
}

/** Somewhere in the scene's own units. Where `@wr/graph` puts a node, and what a pan aims at. */
export interface ScenePoint {
  readonly x: number;
  readonly y: number;
}

/** Where every drawn thing is, keyed by `sceneKey`. What a layout answers with. */
export type ScenePositions = ReadonlyMap<string, ScenePoint>;

/**
 * A viewport that brings these scene points into the middle of the view.
 *
 * The zoom is left alone: the researcher set it, and a filter that also zoomed would answer a
 * question nobody asked. The middle of the matches' bounding box is what is centred, so one
 * match lands in the middle and a scattered handful are framed between them.
 */
export function centredOn(
  points: readonly ScenePoint[],
  zoom: number,
): GraphViewport | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return roundViewport({
    x: VIEW_WIDTH / 2 - ((minX + maxX) / 2) * zoom,
    y: VIEW_HEIGHT / 2 - ((minY + maxY) / 2) * zoom,
    zoom,
  });
}

/**
 * Move the view onto whatever the filter just found (`V02`).
 *
 * All three surfaces had this, written out three times, down to the comment explaining the
 * refs. It is fiddly in exactly the way a copied thing should not be: the *matches* have to be
 * a change detector rather than a dependency, because a set is rebuilt on every render and an
 * effect keyed on one would pan on every keystroke of the page around it; and the joined keys
 * are only ever compared, never split, because a key is `<type> <id>` and taking a joined list
 * of them back apart is a bug waiting for the first id with a separator in it.
 *
 * `positions` is read through a ref for the same reason each surface said so in its own words:
 * a redraw of the library must not yank the view back to a filter the researcher has since
 * panned away from. Only a change in what *matched* moves anything.
 *
 * Where the resulting viewport goes is still the surface's — the wiki keeps its own in the
 * panel, the neighbourhood saves it against its seed (`G01`) — so this takes a `panTo` rather
 * than reaching for one.
 */
export function usePanToMatches(
  matched: ReadonlySet<string>,
  positions: ScenePositions | null,
  panTo: (points: readonly ScenePoint[]) => void,
): void {
  const matchedNow = useRef(matched);
  matchedNow.current = matched;
  const positionsNow = useRef(positions);
  positionsNow.current = positions;
  const destination = [...matched].sort().join('|');
  useEffect(() => {
    if (destination === '') return;
    const at = positionsNow.current;
    if (at === null) return;
    panTo(
      [...matchedNow.current].flatMap((id) => {
        const point = at.get(id);
        return point === undefined ? [] : [point];
      }),
    );
  }, [destination, panTo]);
}

/**
 * The box a graph surface is searched with.
 *
 * One control, drawn the same way on every surface that has one, because "type to find it" has
 * to mean the same thing on all of them. It reports how many of how many matched rather than
 * only dimming: a needle that matches nothing looks exactly like a needle that matches
 * something off-screen, and the count is the difference.
 */
export function SceneFilter({
  testIdPrefix,
  query,
  onQuery,
  matches,
  total,
}: {
  /** `data-testid` is `<testIdPrefix>-filter`, and the count `<testIdPrefix>-filter-count`. */
  readonly testIdPrefix: string;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly matches: number;
  readonly total: number;
}): JSX.Element {
  const searching = filterNeedle(query) !== '';
  return (
    <label className="wr-graph__setting wr-graph__filter">
      <span>Find</span>
      <input
        className="wr-input"
        type="search"
        placeholder="a title, or words you marked"
        aria-label="Find on this graph"
        data-testid={`${testIdPrefix}-filter`}
        data-control="graph.find"
        value={query}
        onChange={(event) => {
          onQuery(event.target.value);
        }}
      />
      {searching && (
        <span
          className="wr-graph__filter-count"
          data-testid={`${testIdPrefix}-filter-count`}
          data-matches={String(matches)}
        >
          {matches === 0 ? 'nothing matches' : `${String(matches)} of ${String(total)}`}
        </span>
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Drawing a link between two discs (`H09`)
// ---------------------------------------------------------------------------

/** One end of a link being drawn, as the scene knows it. */
export interface SceneEntityRef {
  readonly entityType: string;
  readonly entityId: string;
}

/**
 * A link being drawn, in the SVG's own units.
 *
 * Reported to the surface rather than drawn here, because only the surface knows what else is
 * on its canvas and in what order — but the *arithmetic* is here, for the reason the viewport
 * group gives: a surface computing its own coordinates passes its own assertions while the
 * published attributes say otherwise.
 */
export interface SceneLinkDrag {
  readonly from: SceneEntityRef;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** `sceneKey` of the node under the pointer, or null over empty canvas. */
  readonly over: string | null;
}

export interface SceneLinking {
  /** Both ends chosen. The surface runs the command; nothing here writes anything. */
  readonly onLink: (from: SceneEntityRef, to: SceneEntityRef) => void;
  /** Where the gesture is now, or null when there is none. */
  readonly onDrag: (drag: SceneLinkDrag | null) => void;
}

/**
 * How far the pointer travels before a press becomes a drag rather than a click.
 *
 * A node's click navigates and a line's click singles it out, so on this canvas every gesture
 * shares its first event with a click and they are told apart by this distance alone — the same
 * shape the block grip uses. Too small and every slightly shaky click draws a line or shifts
 * the map; too large and a link between two neighbouring discs is unmakeable.
 *
 * One number for all three gestures (a link off a disc, `H09`; a pan off the canvas; a pan off
 * an edge's hit band, `H07`), because a researcher's hand does not know which one it is on.
 */
const DRAG_THRESHOLD_PX = 6;

/** Which thing a `.wr-graph__node` stands for, read back off the element the surface drew. */
function entityOf(node: Element | null): SceneEntityRef | null {
  const entityType = node?.getAttribute('data-entity-type') ?? '';
  const entityId = node?.getAttribute('data-entity-id') ?? '';
  if (entityType === '' || entityId === '') return null;
  return { entityType, entityId };
}

/**
 * Press one disc, drag to another, let go: the two are linked (`H09`).
 *
 * Window listeners rather than pointer capture, deliberately. Capturing on the `<svg>` would
 * redirect the pointer stream here and take the *click* with it — and a node's click is how
 * these views are navigated, so a gesture that made every press on a disc stop opening things
 * would have cost more than it bought. Without capture the browser's own rule does the work:
 * a press and release on the same disc is a click on it, and a press on one and a release on
 * another is a click on neither.
 */
function useLinkDrag(
  fit: SceneFit,
  linking: SceneLinking | undefined,
): { readonly begin: (event: React.PointerEvent<SVGSVGElement>) => void } {
  const report = useRef(linking);
  report.current = linking;
  const held = useRef(fit);
  held.current = fit;
  const active = useRef<{
    svg: SVGSVGElement;
    from: SceneEntityRef;
    origin: { x: number; y: number };
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  useEffect(
    () => () => {
      active.current = null;
    },
    [],
  );

  const begin = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const linkingNow = report.current;
    if (linkingNow === undefined || event.button !== 0) return;
    const node = event.target instanceof Element ? event.target.closest('.wr-graph__node') : null;
    const from = entityOf(node);
    if (node === null || from === null) return;

    const svg = event.currentTarget;
    // The disc's own centre, not the group's box: the label under a node is part of the same
    // element, so a bounding box would start the line below the disc it comes out of.
    const disc = node.querySelector('.wr-graph__disc') ?? node;
    const box = disc.getBoundingClientRect();
    const origin = toScene(held.current, svg, box.left + box.width / 2, box.top + box.height / 2);
    active.current = {
      svg,
      from,
      origin,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };

    const onMove = (move: PointerEvent): void => {
      const now = active.current;
      if (now === null) return;
      if (
        !now.moved &&
        Math.hypot(move.clientX - now.startX, move.clientY - now.startY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      now.moved = true;
      const at = toScene(held.current, now.svg, move.clientX, move.clientY);
      const under = document.elementFromPoint(move.clientX, move.clientY);
      const over = entityOf(under?.closest('.wr-graph__node') ?? null);
      report.current?.onDrag({
        from: now.from,
        x1: now.origin.x,
        y1: now.origin.y,
        x2: at.x,
        y2: at.y,
        over:
          over === null || sameEnd(over, now.from) ? null : sceneKey(over.entityType, over.entityId),
      });
    };

    const onUp = (up: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const now = active.current;
      active.current = null;
      report.current?.onDrag(null);
      if (now === null || !now.moved) return;
      const under = document.elementFromPoint(up.clientX, up.clientY);
      const to = entityOf(under?.closest('.wr-graph__node') ?? null);
      // A line let go over nothing, or back over the disc it started on, is a gesture the
      // researcher abandoned. Nothing is written and nothing is said about it.
      if (to === null || sameEnd(to, now.from)) return;
      report.current?.onLink(now.from, to);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  return { begin };
}

const sameEnd = (a: SceneEntityRef, b: SceneEntityRef): boolean =>
  a.entityType === b.entityType && a.entityId === b.entityId;

/** Spread onto the `<svg>`: pan, and the ref the wheel listener needs. */
export interface SceneSvgProps {
  readonly ref: (element: SVGSVGElement | null) => void;
  readonly onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
  readonly onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
  readonly onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
  readonly onPointerCancel: (event: React.PointerEvent<SVGSVGElement>) => void;
  /** Eats the click a pan ends with, so the line it passed over is not also singled out. */
  readonly onClickCapture: (event: ReactMouseEvent<SVGSVGElement>) => void;
}

/** What `useSceneGestures` hands back: the props for the `<svg>`, and the panel it measured. */
export interface SceneGestures {
  readonly svgProps: SceneSvgProps;
  readonly canvas: SceneCanvas;
  /** Fit the scene to the panel as it is now, discarding the fit that was being held (`F04`). */
  readonly refit: () => void;
}

export interface SceneView {
  readonly view: GraphViewport;
  readonly canvas: SceneCanvas;
  readonly reset: () => void;
  /**
   * Move the view onto these scene points, keeping the zoom (`V02`).
   *
   * Here rather than in the surface, for the reason `SceneViewportGroup` gives: a surface that
   * computed its own transform would pass its own assertions while disagreeing with the
   * attributes the view publishes. Nothing outside this module rounds or clamps a viewport.
   */
  readonly panTo: (points: readonly ScenePoint[]) => void;
  readonly svgProps: SceneSvgProps;
  /** The link being drawn over this scene, or null (`H09`). Drawn by the surface. */
  readonly linkDrag: SceneLinkDrag | null;
}

/**
 * Pan and zoom over a drawn scene, reporting every move to whoever owns the viewport.
 *
 * Controlled rather than stateful, because the surfaces disagree about *where* the viewport
 * lives and about nothing else. `G01` persists the neighbourhood panel's, because that view is
 * opened on a seed and coming back to it is coming back to the same picture; the wiki keeps
 * its own in the panel, because it redraws as the library grows and is re-seated every time it
 * is crawled. That is one decision, and it
 * does not justify two copies of the pointer arithmetic — a drag that pans by the wrong scale
 * on one surface and not the other is exactly the drift a shared hook prevents.
 *
 * `onView` is read through a ref, so a caller whose handler identity changes — one that saves
 * through a debounce keyed on the seed, say — does not re-register the wheel listener mid-gesture.
 */
export function useSceneGestures(
  view: GraphViewport,
  onView: (next: GraphViewport) => void,
  linking?: SceneLinking | undefined,
): SceneGestures {
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const current = useRef(view);
  current.current = view;
  const report = useRef(onView);
  report.current = onView;

  /**
   * The panel, measured, and the fit held inside it (`F04`).
   *
   * The size follows the panel on every resize — it is the viewBox, so it has to. The *scale*
   * is captured the first time the panel is measured with a real size and then left alone,
   * which is the whole of "docked keeps its scale": narrowing the panel narrows the window onto
   * the scene and changes nothing about how big the scene is drawn. The window narrows and
   * widens around its own middle (`centredFit`), so the picture stays where the eye is.
   *
   * A measurement of nothing is ignored rather than captured. Dockview hides an inactive tab,
   * so a panel opened in the background is measured at zero before it is ever seen, and a fit
   * captured from that would be the one the surface then held on to.
   */
  const [canvas, setCanvas] = useState<SceneCanvas>(RESTING_CANVAS);
  const held = useRef(canvas);
  held.current = canvas;
  useEffect(() => {
    const svg = svgEl;
    if (svg === null) return;
    const measure = (): void => {
      const rect = svg.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 1 || height < 1) return;
      setCanvas((now) =>
        now.width === width && now.height === height
          ? now
          : {
              width,
              height,
              fit:
                now === RESTING_CANVAS
                  ? fitInto(width, height)
                  : centredFit(now.fit.scale, width, height),
            },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => {
      observer.disconnect();
    };
  }, [svgEl]);

  const refit = useCallback(() => {
    setCanvas((now) => ({ ...now, fit: fitInto(now.width, now.height) }));
  }, []);

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
      const at = toScene(held.current.fit, svg, event.clientX, event.clientY);
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

  const drag = useRef<{
    pointerId: number;
    /** Where the last move was, so a pan is reported as a delta. */
    clientX: number;
    clientY: number;
    /** Where the press was, so the threshold is measured from the start and not per event. */
    fromX: number;
    fromY: number;
    /** True once the threshold is passed: before that this is a click, not a pan. */
    panning: boolean;
  } | null>(null);
  /** Set when a pan happened, so the click it ends with does not also select what is under it. */
  const panned = useRef(false);

  const link = useLinkDrag(canvas.fit, linking);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      // A drag that starts on a node is not a pan: nodes are how these views are navigated, and
      // capturing the pointer here would swallow the click that follows one. It is, when the
      // surface asked for it, the start of a link (`H09`) — which is why this early return is
      // where that gesture begins rather than a second handler competing with this one.
      if (event.target instanceof Element && event.target.closest('.wr-graph__node') !== null) {
        link.begin(event);
        return;
      }
      if (event.button !== 0) return;
      // A press on an edge's hit band starts a pan too, and this used to be an early return.
      // The bands are 12 scene units wide, invisible, and there is one over every line: on the
      // wiki's own defaults — 150 discs and up to 1,500 lines over a 1000×700 scene — they
      // cover the map several times over, so most of the apparently empty canvas simply could
      // not be dragged. Nothing was wrong with the *reason* for the early return, only with
      // where it acted: capturing the pointer is what retargets the click onto the canvas, so
      // the capture waits until the gesture is a drag rather than a click. Same threshold and
      // same argument as `H08`/`H09`, which is why 6px is one constant.
      drag.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        fromX: event.clientX,
        fromY: event.clientY,
        panning: false,
      };
    },
    [link],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    if (!active.panning) {
      const travelled = Math.hypot(event.clientX - active.fromX, event.clientY - active.fromY);
      if (travelled < DRAG_THRESHOLD_PX) return;
      active.panning = true;
      panned.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const scale = held.current.fit.scale;
    const now = current.current;
    report.current(
      roundViewport({
        x: now.x + (event.clientX - active.clientX) / scale,
        y: now.y + (event.clientY - active.clientY) / scale,
        zoom: now.zoom,
      }),
    );
    active.clientX = event.clientX;
    active.clientY = event.clientY;
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /**
   * Swallow the click a pan ends with, once, in the capture phase.
   *
   * Pointer capture already retargets it onto the `<svg>`, so in Chromium the band below never
   * sees it — but that is a property of the retargeting rather than of this code, and the cost
   * of being wrong about it is a link singled out by a drag that was aimed past it. Capture
   * phase, so it is stopped before the band's own handler runs.
   */
  const onClickCapture = useCallback((event: ReactMouseEvent<SVGSVGElement>) => {
    if (!panned.current) return;
    panned.current = false;
    event.stopPropagation();
  }, []);

  return {
    svgProps: {
      ref: setSvgEl,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onClickCapture,
    },
    canvas,
    refit,
  };
}

/**
 * The `<svg>` attributes every graph surface shares.
 *
 * The viewBox is the panel's own size rather than a fixed logical box, so one unit is one CSS
 * pixel and the fit inside it is the surface's to hold (`F04`). Published as `data-*` for the
 * same reason the viewport group publishes its transform: a test that measured pixels would be
 * asserting about a window size, and a surface that wrote its own viewBox would drift from the
 * arithmetic the gestures use.
 */
export function sceneCanvasProps(canvas: SceneCanvas): Record<string, string> {
  return {
    viewBox: `0 0 ${String(canvas.width)} ${String(canvas.height)}`,
    preserveAspectRatio: 'xMidYMid meet',
    'data-view-width': String(canvas.width),
    'data-view-height': String(canvas.height),
    'data-fit': String(canvas.fit.scale),
  };
}

/**
 * Pan and zoom held for as long as the panel is showing the same thing, and no longer.
 *
 * What the wiki wants in both its states: a remembered pan would put the next file's picture
 * somewhere the reader left the last one's.
 *
 * `subject` is what the scene is *of* — the focused wiki passes the file it is seated on. A
 * crawl (`F03`) re-seats one panel rather than opening a second, so React keeps the component
 * mounted and this state would survive onto a file it was never taken for: every focused file
 * is laid out at the middle of the scene, so a viewport panned to the last file's edge draws
 * the new one off the panel entirely. The rule belongs here, where it is written down, and not
 * in each caller remembering to reset. Omit it for a surface with one subject for its whole
 * life, like the wiki page.
 */
export function useSceneView(
  subject?: string,
  /** What to do when two discs are joined. Omit on a surface where a link cannot be made. */
  onLink?: (from: SceneEntityRef, to: SceneEntityRef) => void,
): SceneView {
  const [view, setView] = useState<GraphViewport>(RESTING_VIEW);
  const [linkDrag, setLinkDrag] = useState<SceneLinkDrag | null>(null);
  // The callback is read through a ref inside the hook, so an inline handler here does not
  // re-register anything mid-gesture; the object is rebuilt only when a surface gains or loses
  // the ability to link at all.
  const linking = useMemo<SceneLinking | undefined>(
    () => (onLink === undefined ? undefined : { onLink, onDrag: setLinkDrag }),
    [onLink],
  );
  const { svgProps, canvas, refit } = useSceneGestures(view, setView, linking);
  const reset = useCallback(() => {
    setView(RESTING_VIEW);
    // The fit as well as the pan: "back to the resting view" means the map as it would be drawn
    // if the panel were opened at this size now, which is the way out of a fit held from before
    // the panel was docked (`F04`).
    refit();
  }, [refit]);
  const panTo = useCallback((points: readonly ScenePoint[]) => {
    setView((now) => centredOn(points, now.zoom) ?? now);
  }, []);
  const seated = useRef(subject);
  if (seated.current !== subject) {
    // During render rather than in an effect: the scene is drawn from `view` in this same pass,
    // and a reset one frame later is a visible jump from the old viewport to the new one.
    seated.current = subject;
    if (view !== RESTING_VIEW) setView(RESTING_VIEW);
  }
  return { view, canvas, reset, panTo, svgProps, linkDrag };
}

/**
 * The line the pointer is dragging between two discs, drawn over everything (`H09`).
 *
 * Outside the viewport group on purpose: both ends are already in the scene's own units — one
 * measured off the disc it left, one off the pointer — so putting it inside the pan-and-zoom
 * group would apply that transform to numbers that have already been through it. It is still
 * inside the *fit*, because scene units are what the fit turns into pixels.
 */
export function SceneLinkLine({
  testId,
  fit,
  drag,
}: {
  readonly testId: string;
  readonly fit: SceneFit;
  readonly drag: SceneLinkDrag | null;
}): JSX.Element | null {
  if (drag === null) return null;
  return (
    <g transform={fitTransform(fit)}>
      <line
        className="wr-graph__link-drag"
        data-testid={testId}
        data-from={sceneKey(drag.from.entityType, drag.from.entityId)}
        data-over={drag.over ?? ''}
        x1={drag.x1}
        y1={drag.y1}
        x2={drag.x2}
        y2={drag.y2}
      />
    </g>
  );
}

const fitTransform = (fit: SceneFit): string =>
  `translate(${String(fit.x)} ${String(fit.y)}) scale(${String(fit.scale)})`;

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
  fit,
  children,
}: {
  readonly testId: string;
  readonly view: GraphViewport;
  /**
   * How the scene sits in the panel (`F04`), held rather than recomputed on every resize.
   *
   * Outside the viewport rather than folded into it, because the two are different facts: the
   * fit is where the map is drawn and how big, and the viewport is where the researcher has
   * moved to inside it. Multiplying them together would make "the panel got narrower" and "you
   * zoomed out" the same number, and then nothing could tell a docked map from a small one.
   */
  readonly fit: SceneFit;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <g className="wr-graph__fit" data-testid={`${testId}-fit`} transform={fitTransform(fit)}>
      <g
        data-testid={testId}
        data-pan-x={String(view.x)}
        data-pan-y={String(view.y)}
        data-zoom={String(view.zoom)}
        transform={`translate(${String(view.x)} ${String(view.y)}) scale(${String(view.zoom)})`}
      >
        {children}
      </g>
    </g>
  );
}

/**
 * One line between two drawn things.
 *
 * The three surfaces draw the same element and differ only in what they can say about it: the
 * neighbourhood panel knows which container each end sits in, the focused view knows whether
 * the far end is a sentence or a paper, and the wiki knows neither. So the extra facts arrive
 * as `data`, exactly as they do on a node, and the class, the dimming and the geometry are
 * written once — a line that dimmed on one surface and not on another would be `V02` working
 * on two maps out of three.
 *
 * `lit` is false only when a filter is running and neither end matched. A line is as bright as
 * the *brighter* of its two ends: a line into the dark from a match is the answer to "and what
 * does this one reach", which is what searching a map is for.
 */
export function SceneEdge({
  testId,
  linkType,
  from,
  to,
  lit = true,
  faded = false,
  data = {},
  chosen = false,
  onChoose,
  onDelete,
  deleteRefusal = null,
}: {
  readonly testId: string;
  /** The typed relationship, published for the assertions. Absent on a drawn containment. */
  readonly linkType?: string | undefined;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly lit?: boolean;
  /** A line of the corpus behind a focused view rather than one of its own (`F09`). */
  readonly faded?: boolean;
  readonly data?: Readonly<Record<string, string>>;
  /** True when this is the line the surface has picked out. Only meaningful with `onChoose`. */
  readonly chosen?: boolean;
  /**
   * Press the line to single it out (`H07`). Absent on a surface where an edge is not a row in
   * `links` — a drawn containment has no id and nothing to take away.
   */
  readonly onChoose?: (() => void) | undefined;
  /** Take this edge away. Drawn as a × on the middle of the line, once it is chosen. */
  readonly onDelete?: (() => void) | undefined;
  /**
   * Why this one cannot go, from `unlinkRefusal`, or null when it can.
   *
   * The × is still drawn, dead, with the reason on it — same argument as the list surfaces'
   * `UnlinkButton`. A map where some lines have a × and some do not would be read as a fact
   * about the *lines*, which is exactly what it is not: it is a fact about who wrote them.
   */
  readonly deleteRefusal?: string | null;
}): JSX.Element {
  const line = (
    <line
      className={classNames(
        'wr-graph__edge',
        faded && 'wr-graph__edge--faded',
        !lit && 'wr-graph__edge--dimmed',
        chosen && 'wr-graph__edge--chosen',
      )}
      data-testid={testId}
      {...(linkType === undefined ? {} : { 'data-link-type': linkType })}
      data-match={lit ? 'true' : 'false'}
      data-chosen={chosen ? 'true' : 'false'}
      {...dataAttrs(data)}
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
    />
  );
  if (onChoose === undefined) return line;

  // The drawn line keeps `pointer-events: none` and an invisible band beside it takes the
  // press. Widening the visible stroke to make it hittable would change the picture in order
  // to make it clickable, and the picture is what the researcher navigates by.
  return (
    <g className="wr-graph__link">
      {line}
      <line
        className="wr-graph__edge-hit"
        data-testid={`${testId}-hit`}
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        onClick={(event) => {
          event.stopPropagation();
          onChoose();
        }}
      />
      {chosen && onDelete !== undefined && (
        <g
          className={classNames(
            'wr-graph__edge-delete',
            deleteRefusal !== null && 'wr-graph__edge-delete--refused',
          )}
          data-testid={`${testId}-delete`}
          data-refusal={deleteRefusal === null ? 'false' : 'true'}
          role="button"
          tabIndex={0}
          aria-disabled={deleteRefusal === null ? undefined : true}
          aria-label={deleteRefusal ?? 'Take this link away'}
          transform={`translate(${String((from.x + to.x) / 2)}, ${String((from.y + to.y) / 2)})`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onDelete();
            }
          }}
        >
          <title>{deleteRefusal ?? 'Take this link away'}</title>
          <circle r={9} />
          <text>×</text>
        </g>
      )}
    </g>
  );
}

/**
 * The box drawn round a container and what it holds (`G06`).
 *
 * Under everything else, so a line crossing out of a group is drawn over the boundary it
 * crosses. The geometry is published as rounded `data-*` because that is how a test reads
 * where a box is without measuring pixels — and the rounding has to be the same on both
 * surfaces that draw one, or "the highlight is inside its paper" means two different things.
 */
export function SceneGroupBox({
  testId,
  box,
  radius,
  data = {},
}: {
  readonly testId: string;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Corner rounding. The two surfaces box different things and chose different curves. */
  readonly radius: number;
  readonly data?: Readonly<Record<string, string>>;
}): JSX.Element {
  return (
    <rect
      className="wr-graph__group-box"
      data-testid={testId}
      data-x={String(Math.round(box.x))}
      data-y={String(Math.round(box.y))}
      data-width={String(Math.round(box.width))}
      data-height={String(Math.round(box.height))}
      {...dataAttrs(data)}
      x={box.x}
      y={box.y}
      width={box.width}
      height={box.height}
      rx={radius}
    />
  );
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
  /**
   * A right-click on the node (`R01`). The surface says which thing was clicked; what can be
   * done to it is the command registry's answer, so a disc on the map offers the same actions
   * its row in the library does.
   */
  readonly onContextMenu?: ((event: ReactMouseEvent) => void) | undefined;
  /** Extra `data-*` the surface wants on the node, for what only it knows. */
  readonly data?: Readonly<Record<string, string>>;
  /**
   * A marked sentence's own words, drawn in quotation marks instead of a title (`V01`).
   *
   * The researcher's reason: a highlight on a map of files has to be *told apart* from a file
   * at a glance, and a disc with a name under it cannot do that however the disc is coloured.
   * Quoted text can, because a quotation is not a title — so the words are the label rather
   * than a decoration beside one, and they are published as `data-snippet` so a test reads
   * what the reader reads. It runs onto as many lines as it takes to be a sentence rather than
   * a fragment (`F06`) — see `quoteLines`.
   */
  readonly quote?: string | null;
  /**
   * Whether this node answers the surface's filter (`V02`).
   *
   * `true` when nothing is being searched for, so the ordinary map is the unfiltered one. A
   * node that does not match is dimmed rather than removed: taking it away would change the
   * shape of the picture, and the shape is what the researcher is navigating by.
   */
  readonly matches?: boolean;
  /**
   * Drawn as the ground the surface stands on rather than as its subject (`F09`).
   *
   * The focused wiki's answer to "do not hide the rest of the library": everything that is not
   * the file in the middle or one of the things touching it is still on the map, still where
   * the layout put it, still clickable — and paler than the two bands, so the eye reads the
   * middle first. Deliberately a *different* dimming from the filter's: `matches` says "this
   * is not what you asked for", and this says "this is not what the view is about". A node can
   * be both, and neither is the other's spelling.
   */
  readonly faded?: boolean;
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
  onContextMenu,
  data = {},
  quote = null,
  matches = true,
  faded = false,
}: SceneNodeProps): JSX.Element {
  // A rename still wins: a node the researcher named is called what they named it, whatever
  // kind of thing it is. Otherwise a marked sentence is drawn as its words and everything else
  // as its title.
  const label = displayName ?? (quote ?? title);
  const [iconLoaded, setIconLoaded] = useState(false);
  return (
    <g
      className={classNames(
        'wr-graph__node',
        primary && 'wr-graph__node--seed',
        quote !== null && 'wr-graph__node--quote',
        faded && 'wr-graph__node--faded',
        !matches && 'wr-graph__node--dimmed',
      )}
      data-testid={`${testIdPrefix}-${entityId}`}
      data-entity-type={entityType}
      data-entity-id={entityId}
      data-snippet={quote ?? ''}
      data-match={matches ? 'true' : 'false'}
      data-faded={faded ? 'true' : 'false'}
      data-x={String(Math.round(x))}
      data-y={String(Math.round(y))}
      data-action={action}
      data-display-name={displayName ?? ''}
      data-icon-file-id={iconFileId ?? ''}
      data-icon-loaded={iconFileId !== null && iconLoaded ? 'true' : 'false'}
      {...dataAttrs(data)}
      role="button"
      tabIndex={0}
      aria-label={`${ACTION_VERBS[action]} ${label}`}
      transform={`translate(${String(x)}, ${String(y)})`}
      onClick={onActivate}
      onContextMenu={onContextMenu}
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
      {showLabel &&
        (quote === null || displayName !== null ? (
          <text className="wr-graph__label" y={radius + 18} textAnchor="middle">
            {ellipsize(label, LABEL_LIMIT)}
          </text>
        ) : (
          /*
           * A marked sentence's own words, over as many lines as it takes to know what it is
           * (`F06`). One line cut at twenty-eight characters was a fragment, and a map of
           * fragments has to be clicked through disc by disc — which is the thing a map exists
           * to save you. The quotation marks stay on the outside of the whole thing rather than
           * on each line, because three separately-quoted lines would read as three quotations.
           */
          <text className="wr-graph__label wr-graph__label--quote" y={radius + 16} textAnchor="middle">
            {quoteLines(label).map((line, index, all) => (
              <tspan
                key={`${String(index)} ${line}`}
                className="wr-graph__label-line"
                x={0}
                dy={index === 0 ? 0 : QUOTE_LINE_HEIGHT}
              >
                {`${index === 0 ? '“' : ''}${line}${index === all.length - 1 ? '”' : ''}`}
              </tspan>
            ))}
          </text>
        ))}
    </g>
  );
}
