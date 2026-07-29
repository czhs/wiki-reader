/**
 * The graph panel (criteria W09, W10, G01, G02).
 *
 * The renderer never holds the graph. It holds *a* graph: the bounded neighbourhood the main
 * process answered with, which arrives already capped by seed, radius and node count. This
 * module asks `graph:neighbourhood` and nothing else — there is no path here to the link
 * tables, because a panel that queried them directly would quietly undo that bound.
 *
 * Drawn as SVG rather than onto Cytoscape's canvas. Cytoscape holds the model and the
 * traversal — the same module the main process bounds the query with — and a node stays a
 * real element: focusable, keyboard-activatable, and nameable by a test. A canvas would make
 * "click the node for this document" a pixel calculation.
 *
 * Pan, zoom and the drawing settings are persisted by the main process, not by the panel:
 * the panel's own state dies with its tab, and both `G01` and `G02` are about what is still
 * true after that tab is gone. Which one they are keyed by differs, and deliberately —
 * settings are one view of graphs in general, a viewport is where *this* seed's graph was
 * left.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { createGraph, layoutPositions } from '@wr/graph';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import {
  LinkableEntityTypeSchema,
  type GraphNeighbourhood,
  type GraphViewSettings,
  type GraphViewport,
  type LinkableEntityType,
} from '@wr/shared-types';
import type { PanelDescriptor } from '@wr/workbench';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** The logical drawing area. The SVG scales it to whatever the panel is; nothing measures. */
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 700;

/** How many nodes a neighbourhood view asks for. The contract caps it lower than it can go. */
const NODE_LIMIT = 60;

/** The same bounds `GraphViewportSchema` states. A gesture cannot leave the panel unusable. */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;

/** Untouched: no pan, no zoom. What a seed nobody has moved the graph on starts at. */
const RESTING_VIEWPORT: GraphViewport = { x: 0, y: 0, zoom: 1 };

/**
 * How long a gesture settles before it is written.
 *
 * A wheel gesture is dozens of events; each one is a viewport. Writing every one would put a
 * transaction on the main process per animation frame for a value only the last of which is
 * ever read. Short enough that closing the tab straight after a gesture still saves it — and
 * unmount flushes whatever is still pending regardless.
 */
const SAVE_DELAY_MS = 150;

const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** Radius of a node's disc, and of the picture clipped into it. */
const SEED_RADIUS = 16;
const NODE_RADIUS = 11;

/** How many of the library's images the icon picker offers. */
const ICON_CHOICE_LIMIT = 50;

/** Rounded, so a viewport read back out of the database compares equal to the one written. */
const roundViewport = (viewport: GraphViewport): GraphViewport => ({
  x: Math.round(viewport.x * 10) / 10,
  y: Math.round(viewport.y * 10) / 10,
  zoom: Math.round(clampZoom(viewport.zoom) * 1000) / 1000,
});

function truncate(text: string, max = 28): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Client pixels to the SVG's own units.
 *
 * `preserveAspectRatio="xMidYMid meet"` letterboxes the viewBox inside whatever the panel is,
 * so the mapping is one scale and two offsets — and getting it wrong shows up as a graph that
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

/** Client-pixel distance to SVG units, for a drag that moves the whole scene. */
function viewBoxScale(svg: SVGSVGElement): number {
  const rect = svg.getBoundingClientRect();
  return Math.min(rect.width / VIEW_WIDTH, rect.height / VIEW_HEIGHT) || 1;
}

interface GraphPanelBodyProps {
  readonly seedEntityId: string;
  readonly seedEntityType: string;
}

export function GraphPanelBody({
  seedEntityId,
  seedEntityType,
}: GraphPanelBodyProps): JSX.Element {
  const { store, workbench } = useWorkspace();
  const [graph, setGraph] = useState<GraphNeighbourhood | null>(null);
  /** Bumped to re-ask after something the panel itself changed, like a node's name. */
  const [reload, setReload] = useState(0);
  const [settings, setSettings] = useState<GraphViewSettings | null>(null);
  const [viewport, setViewport] = useState<GraphViewport>(RESTING_VIEWPORT);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const seedType = useMemo((): LinkableEntityType | null => {
    const parsed = LinkableEntityTypeSchema.safeParse(seedEntityType);
    return parsed.success ? parsed.data : null;
  }, [seedEntityType]);

  // --- what was persisted about this view -----------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await call('graph:getView', {
          seedType,
          seedId: seedType === null ? null : seedEntityId,
        });
        if (cancelled) return;
        setSettings(view.settings);
        setViewport(view.viewport ?? RESTING_VIEWPORT);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seedEntityId, seedType]);

  // --- the neighbourhood itself ---------------------------------------------
  const depth = settings?.depth ?? null;
  useEffect(() => {
    if (seedType === null) {
      setError(`Not something the graph can open on: ${seedEntityType}`);
      setLoading(false);
      return;
    }
    if (depth === null) return;

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const neighbourhood = await call('graph:neighbourhood', {
          seedType,
          seedId: seedEntityId,
          depth,
          nodeLimit: NODE_LIMIT,
        });
        if (cancelled) return;
        setGraph(neighbourhood);
        setError(null);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [depth, reload, seedEntityId, seedEntityType, seedType]);

  // --- persisting the viewport ----------------------------------------------
  // The pending value and the timer are refs rather than state: a gesture must not re-render
  // once per event just to remember that it still owes a write.
  const pending = useRef<GraphViewport | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const next = pending.current;
    pending.current = null;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (next === null || seedType === null) return;
    void call('graph:setViewport', {
      seedType,
      seedId: seedEntityId,
      viewport: next,
    }).catch(() => {
      // A viewport that failed to save is not worth interrupting reading for. The graph on
      // screen is unaffected; the next gesture tries again.
    });
  }, [seedEntityId, seedType]);

  // Flushed on unmount, so closing the tab immediately after a gesture still saves it —
  // which is exactly what `G01` closes the panel to check.
  useEffect(() => flush, [flush]);

  const moveView = useCallback(
    (next: GraphViewport) => {
      const rounded = roundViewport(next);
      setViewport(rounded);
      pending.current = rounded;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        flush();
      }, SAVE_DELAY_MS);
    },
    [flush],
  );

  // --- zooming ---------------------------------------------------------------
  // A native listener rather than `onWheel`, because React registers wheel passively on the
  // root: `preventDefault` from a synthetic handler is ignored and the panel scrolls under
  // the gesture instead of zooming.
  // State rather than a ref, because the canvas only mounts once the neighbourhood has
  // arrived: an effect keyed on a ref would have run while it was still null and never
  // attached anything.
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  useEffect(() => {
    const svg = svgEl;
    if (svg === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const current = viewportRef.current;
      const zoom = clampZoom(current.zoom * Math.exp(-event.deltaY * 0.002));
      if (zoom === current.zoom) return;
      // Anchored on the pointer: what is under the cursor stays under the cursor.
      const at = toViewBox(svg, event.clientX, event.clientY);
      moveView({
        x: at.x - (at.x - current.x) * (zoom / current.zoom),
        y: at.y - (at.y - current.y) * (zoom / current.zoom),
        zoom,
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
    };
  }, [moveView, svgEl]);

  // --- panning ---------------------------------------------------------------
  const drag = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    // A drag that starts on a node is not a pan. Nodes are how the graph is navigated, and
    // capturing the pointer here would swallow the click that opens one.
    if (event.target instanceof Element && event.target.closest('.wr-graph__node') !== null) {
      return;
    }
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const active = drag.current;
      if (active === null || active.pointerId !== event.pointerId) return;
      const scale = viewBoxScale(event.currentTarget);
      const current = viewportRef.current;
      moveView({
        x: current.x + (event.clientX - active.clientX) / scale,
        y: current.y + (event.clientY - active.clientY) / scale,
        zoom: current.zoom,
      });
      drag.current = { ...active, clientX: event.clientX, clientY: event.clientY };
    },
    [moveView],
  );

  const endDrag = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // --- the drawing settings ---------------------------------------------------
  const changeSettings = useCallback(
    (patch: Partial<GraphViewSettings>) => {
      setSettings((current) => {
        if (current === null) return current;
        const next = { ...current, ...patch };
        void call('graph:setViewSettings', next).catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
        return next;
      });
    },
    [store],
  );

  // Cytoscape's model, built from what main sent, laid out by the same package that bounded
  // it. Rebuilt only when the neighbourhood or the spacing changes: a re-layout on every
  // render would move the graph under the pointer.
  const spacing = settings?.spacing ?? 1;
  const laidOut = useMemo(() => {
    if (graph === null) return null;
    const keyOf = (entityType: string, entityId: string): string => `${entityType} ${entityId}`;
    const model = createGraph(
      graph.nodes.map((node) => ({ id: keyOf(node.entityType, node.entityId) })),
      graph.edges.map((edge) => ({
        id: edge.id,
        source: keyOf(edge.sourceType, edge.sourceId),
        target: keyOf(edge.targetType, edge.targetId),
      })),
    );
    const distances = new Map(
      graph.nodes.map((node) => [keyOf(node.entityType, node.entityId), node.distance]),
    );
    const laid = layoutPositions(model, { width: VIEW_WIDTH, height: VIEW_HEIGHT }, distances);
    // Spacing pushes the rings apart from the centre rather than re-laying out, so raising it
    // spreads the same arrangement instead of producing a different one.
    const positions = new Map(
      [...laid.entries()].map(([id, at]) => [
        id,
        {
          x: VIEW_WIDTH / 2 + (at.x - VIEW_WIDTH / 2) * spacing,
          y: VIEW_HEIGHT / 2 + (at.y - VIEW_HEIGHT / 2) * spacing,
        },
      ]),
    );
    return { keyOf, positions };
  }, [graph, spacing]);

  // What the seed node is called here now, and the field that changes it. The field is a draft
  // rather than a live write: renaming on every keystroke would put a database write and a
  // re-query behind each letter.
  const seedDisplayName =
    graph?.nodes.find(
      (node) =>
        node.entityType === graph.seed.entityType && node.entityId === graph.seed.entityId,
    )?.displayName ?? null;
  const [nameDraft, setNameDraft] = useState('');
  useEffect(() => {
    setNameDraft(seedDisplayName ?? '');
  }, [seedDisplayName]);

  /**
   * Rename the node the graph is open on.
   *
   * The seed and not an arbitrary node, because the seed is the one the panel already knows
   * the reader is looking at — and because reaching any other node is one click away: opening
   * it and pressing Graph re-seeds on it. An empty field means "no name of its own", not a
   * node called nothing.
   */
  const rename = useCallback(
    (name: string) => {
      if (seedType === null) return;
      const trimmed = name.trim();
      void call('graph:setNodeName', {
        entityType: seedType,
        entityId: seedEntityId,
        displayName: trimmed === '' ? null : trimmed.slice(0, 120),
      })
        .then(() => {
          setReload((count) => count + 1);
        })
        .catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
    },
    [seedEntityId, seedType, store],
  );

  // --- the picture on the seed node -------------------------------------------
  // What the library holds that could go on a node. Re-asked when the library changes, so an
  // image dropped in while the graph is open is offered without reopening the panel.
  const [iconChoices, setIconChoices] = useState<readonly { fileId: string; title: string }[]>(
    [],
  );
  const loadChoices = useCallback(() => {
    void call('graph:iconChoices', { limit: ICON_CHOICE_LIMIT })
      .then((answer) => {
        setIconChoices(answer.choices);
      })
      .catch(() => {
        // A picker that could not be filled is an empty picker, not a broken graph.
      });
  }, []);
  useEffect(() => {
    loadChoices();
    return subscribe('library:changed', () => {
      loadChoices();
    });
  }, [loadChoices]);

  const seedIconFileId =
    graph?.nodes.find(
      (node) =>
        node.entityType === graph.seed.entityType && node.entityId === graph.seed.entityId,
    )?.iconFileId ?? null;

  /**
   * Put a picture on the node the graph is open on, or take it off.
   *
   * A file id chosen from what the library already holds — the renderer has no way to name a
   * file on the disk and this is not the place that changes it. Getting an image *into* the
   * library is a drop, which is handled in the preload and never crosses a channel.
   */
  const illustrate = useCallback(
    (fileId: string | null) => {
      if (seedType === null) return;
      void call('graph:setNodeIcon', { entityType: seedType, entityId: seedEntityId, fileId })
        .then(() => {
          setReload((count) => count + 1);
        })
        .catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
    },
    [seedEntityId, seedType, store],
  );

  // Which icons actually arrived over `rrfile://`. Kept because a picture that failed to load
  // leaves the disc bare and the panel should say so rather than look identical to a node
  // nobody illustrated.
  const [iconsLoaded, setIconsLoaded] = useState<Readonly<Record<string, boolean>>>({});
  const noteIcon = useCallback((fileId: string, loaded: boolean) => {
    setIconsLoaded((current) => (current[fileId] === loaded ? current : { ...current, [fileId]: loaded }));
  }, []);

  // Clip paths are addressed by id, and two graph panels share one document. `useId` keeps
  // the second panel from clipping against the first one's shapes.
  const clipId = useId();

  const open = useCallback(
    (entityType: string, entityId: string) => {
      const parsed = LinkableEntityTypeSchema.safeParse(entityType);
      if (!parsed.success) return;
      // Through the workbench, like every other way of opening something — the graph panel
      // never reaches into a reader panel. To the side, so the graph is still there to click
      // again: it is a way of getting around, not a dialog that closes behind you.
      void workbench.navigate({ entityId, entityType: parsed.data }, 'side').catch(
        (failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        },
      );
    },
    [store, workbench],
  );

  if (error !== null) return <ErrorState message={error} testId="graph-panel-error" />;
  // Only the settings are worth waiting on: they decide what is asked for. Once a graph has
  // arrived it stays on screen through the next query, so changing a setting adjusts the view
  // rather than blanking it and drawing a second one.
  if (settings === null || (graph === null && loading)) {
    return <EmptyState message="Reading the graph…" testId="graph-panel-loading" />;
  }
  if (graph === null || laidOut === null) {
    return <EmptyState message="Nothing to graph." testId="graph-panel-empty" />;
  }

  const { keyOf, positions } = laidOut;
  const seedKey = keyOf(graph.seed.entityType, graph.seed.entityId);

  return (
    <div
      className="wr-graph"
      data-testid="graph-panel"
      data-seed-id={graph.seed.entityId}
      data-node-count={String(graph.nodes.length)}
      data-edge-count={String(graph.edges.length)}
      data-depth={String(settings.depth)}
      data-spacing={String(settings.spacing)}
      data-labels={settings.showLabels ? 'on' : 'off'}
    >
      <header className="wr-graph__header">
        <span className="wr-graph__title">
          {graph.seed.title} · {graph.depth === 1 ? '1 hop' : `${String(graph.depth)} hops`}
        </span>
        {graph.truncated && (
          <span className="wr-graph__elided" data-testid="graph-elision">
            {graph.elidedNodes} more not shown
          </span>
        )}
      </header>
      <div className="wr-graph__settings" data-testid="graph-settings">
        <label className="wr-graph__setting">
          <span>Name</span>
          <input
            data-testid="graph-node-name"
            className="wr-graph__name"
            type="text"
            maxLength={120}
            // The document's own title, so an empty field reads as "called what it is called"
            // rather than as a name that has been lost.
            placeholder={graph.seed.title}
            value={nameDraft}
            onChange={(event) => {
              setNameDraft(event.target.value);
            }}
            onBlur={() => {
              if (nameDraft !== (seedDisplayName ?? '')) rename(nameDraft);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                rename(nameDraft);
              }
            }}
          />
        </label>
        <label className="wr-graph__setting">
          <span>Icon</span>
          <select
            data-testid="graph-node-icon"
            value={seedIconFileId ?? ''}
            onChange={(event) => {
              illustrate(event.target.value === '' ? null : event.target.value);
            }}
          >
            <option value="">No picture</option>
            {/* An icon set from a bigger library than the picker offers is still what the node
                wears; listing it keeps the control honest rather than showing "No picture". */}
            {seedIconFileId !== null &&
              !iconChoices.some((choice) => choice.fileId === seedIconFileId) && (
                <option value={seedIconFileId}>The picture it has</option>
              )}
            {iconChoices.map((choice) => (
              <option key={choice.fileId} value={choice.fileId}>
                {choice.title}
              </option>
            ))}
          </select>
        </label>
        <label className="wr-graph__setting">
          <span>Hops</span>
          <select
            data-testid="graph-setting-depth"
            value={String(settings.depth)}
            onChange={(event) => {
              changeSettings({ depth: Number(event.target.value) });
            }}
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <label className="wr-graph__setting">
          <span>Spacing</span>
          <input
            data-testid="graph-setting-spacing"
            type="range"
            min="0.5"
            max="2.5"
            step="0.25"
            value={String(settings.spacing)}
            onChange={(event) => {
              changeSettings({ spacing: Number(event.target.value) });
            }}
          />
        </label>
        <label className="wr-graph__setting">
          <input
            data-testid="graph-setting-labels"
            type="checkbox"
            checked={settings.showLabels}
            onChange={(event) => {
              changeSettings({ showLabels: event.target.checked });
            }}
          />
          <span>Labels</span>
        </label>
        <button
          type="button"
          className="wr-graph__reset"
          data-testid="graph-view-reset"
          onClick={() => {
            moveView(RESTING_VIEWPORT);
          }}
        >
          Reset view
        </button>
      </div>
      <svg
        ref={setSvgEl}
        className="wr-graph__canvas"
        data-testid="graph-canvas"
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Links around ${graph.seed.title}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* A picture is clipped to the disc it sits on, so an image of any shape reads as a
            node rather than as a rectangle floating over the graph. */}
        <defs>
          <clipPath id={`${clipId}-seed`} clipPathUnits="userSpaceOnUse">
            <circle r={SEED_RADIUS} />
          </clipPath>
          <clipPath id={`${clipId}-node`} clipPathUnits="userSpaceOnUse">
            <circle r={NODE_RADIUS} />
          </clipPath>
        </defs>
        <g
          data-testid="graph-viewport"
          data-pan-x={String(viewport.x)}
          data-pan-y={String(viewport.y)}
          data-zoom={String(viewport.zoom)}
          transform={`translate(${String(viewport.x)} ${String(viewport.y)}) scale(${String(
            viewport.zoom,
          )})`}
        >
          {graph.edges.map((edge) => {
            const from = positions.get(keyOf(edge.sourceType, edge.sourceId));
            const to = positions.get(keyOf(edge.targetType, edge.targetId));
            if (from === undefined || to === undefined) return null;
            return (
              <line
                key={edge.id}
                className="wr-graph__edge"
                data-testid={`graph-edge-${edge.id}`}
                data-link-type={edge.type}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const key = keyOf(node.entityType, node.entityId);
            const position = positions.get(key);
            if (position === undefined) return null;
            const isSeed = key === seedKey;
            // The name the researcher gave the node, or what the thing is called. The title is
            // still what the tooltip says, so a renamed node does not hide what it is.
            const label = node.displayName ?? node.title;
            const radius = isSeed ? SEED_RADIUS : NODE_RADIUS;
            const icon = node.iconFileId;
            return (
              <g
                key={key}
                className={isSeed ? 'wr-graph__node wr-graph__node--seed' : 'wr-graph__node'}
                data-testid={`graph-node-${node.entityId}`}
                data-entity-type={node.entityType}
                data-distance={String(node.distance)}
                data-degree={String(node.degree)}
                data-display-name={node.displayName ?? ''}
                data-icon-file-id={icon ?? ''}
                // Whether the bytes arrived, not merely whether an icon was asked for.
                data-icon-loaded={icon !== null && iconsLoaded[icon] === true ? 'true' : 'false'}
                role="button"
                tabIndex={0}
                aria-label={`Open ${label}`}
                transform={`translate(${String(position.x)}, ${String(position.y)})`}
                onClick={() => open(node.entityType, node.entityId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    open(node.entityType, node.entityId);
                  }
                }}
              >
                <circle className="wr-graph__disc" r={radius} />
                {icon !== null && (
                  // `rrfile://<file id>` — built here, from an id the main process sent. A
                  // picture that fails to load draws nothing and leaves the disc, which is
                  // why the disc is underneath rather than replaced.
                  <image
                    className="wr-graph__icon"
                    data-testid={`graph-icon-${node.entityId}`}
                    href={`rrfile://${icon}`}
                    x={-radius}
                    y={-radius}
                    width={radius * 2}
                    height={radius * 2}
                    preserveAspectRatio="xMidYMid slice"
                    clipPath={`url(#${clipId}-${isSeed ? 'seed' : 'node'})`}
                    onLoad={() => {
                      noteIcon(icon, true);
                    }}
                    onError={() => {
                      noteIcon(icon, false);
                    }}
                  />
                )}
                <title>{node.title}</title>
                {settings.showLabels && (
                  <text className="wr-graph__label" y={isSeed ? 34 : 28} textAnchor="middle">
                    {truncate(label)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

interface PanelParams {
  readonly panelId: string;
}

export function graphDescriptorFrom(descriptor: PanelDescriptor | null): {
  seedEntityId: string;
  seedEntityType: string;
} | null {
  if (descriptor === null || descriptor.kind !== 'link-graph') return null;
  if (descriptor.seedEntityId === null || descriptor.seedEntityType === null) return null;
  return {
    seedEntityId: descriptor.seedEntityId,
    seedEntityType: descriptor.seedEntityType,
  };
}

export function GraphPanel({ params }: IDockviewPanelProps<PanelParams>): JSX.Element {
  const state = useWorkspaceState();
  const seed = graphDescriptorFrom(state.panels[params.panelId] ?? null);
  if (seed === null) {
    return (
      <EmptyState
        message="Open a document or a note, then open the graph on it."
        testId="graph-panel-empty"
      />
    );
  }
  return <GraphPanelBody {...seed} />;
}
