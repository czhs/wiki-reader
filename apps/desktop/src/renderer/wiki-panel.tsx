/**
 * The wiki: the library as a place (criterion F01).
 *
 * A page, not a sidecar. The neighbourhood panel is opened *on* something and stays a companion
 * to whatever is being read; this one has no subject, because the library is the subject. That
 * is why it is a second surface rather than a mode on the first: a view whose whole shape is
 * "everything, ranked" cannot also be "one hop around this", and a toggle between the two would
 * make both worse at their own job.
 *
 * It asks `graph:overview` and nothing else. The cap is the contract's and travels with the
 * request, and what came back says how many files the library holds in all — so a map that had
 * to leave some out says so on its face instead of presenting a slice as the library.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { overviewPositions } from '@wr/graph';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { COMMAND_IDS } from '@wr/workbench';
import {
  LinkableEntityTypeSchema,
  type GraphOverview,
  type IpcTopicPayload,
} from '@wr/shared-types';
import { useGraphNodeMenu } from './context-menu.js';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace } from './workspace.js';
import {
  SceneEdge,
  SceneFilter,
  SceneLinkLine,
  SceneNode,
  SceneViewportGroup,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  filterNeedle,
  matchesNeedle,
  sceneKey,
  useSceneView,
  type SceneEntityRef,
} from './graph-canvas.js';

/**
 * How much of the library the page will take, and the choices offered for it.
 *
 * The default is not the contract's ceiling. A first look at a library wants to be readable, and
 * three hundred discs in one view is a texture rather than a map — so the page starts at a size
 * a person can actually pick a file out of and says how many it left out, and widening it is one
 * click for someone who wants the whole thing.
 */
const SIZES = [60, 150, 300] as const;
const DEFAULT_SIZE = 150;

/**
 * How many lines the page will take.
 *
 * Its own budget, asked for and reported on separately from the nodes, because they are
 * separate quantities: three hundred discs of a well-linked library carry tens of thousands of
 * lines between them, and drawing every one is a page nobody can read arriving through an
 * uncapped payload. What was left out is on the header beside the nodes' elision.
 */
const EDGE_LIMIT = 1_500;

/**
 * Which changes to the library redraw the map.
 *
 * The whole-library ranking is the one query in the graph repository with no seed, so it costs
 * the main process — which owns the database and is synchronous — a pass over `links`. A wiki
 * tab left open anywhere in the workspace used to run that pass for every reason the library
 * publishes, including one marked sentence.
 *
 * *Making* a highlight is still the one change that cannot alter this answer, even now that the
 * map draws highlights (`V01`): a highlight reaches the map when something links it, and the
 * only edge a new one carries is the containment edge `graph:overview` deliberately does not
 * count (`DRAWN_KINDS` in `graph.ts`). The link that does put one on the map arrives as `link`,
 * and deleting one arrives as `delete`. So this is not a page choosing to be stale — there is
 * nothing to redraw for.
 */
const REDRAWS_THE_MAP = (reason: IpcTopicPayload<'library:changed'>['reason']): boolean =>
  reason !== 'annotation';

/** Radius of a node's disc. Smaller than the neighbourhood panel's: there are far more of them. */
const NODE_RADIUS = 9;
/**
 * A marked sentence's disc, drawn smaller than a file's.
 *
 * The size is the first thing read, before any label: a highlight is a part of a paper and is
 * drawn as one. The quoted words under it (`V01`) are what say which part.
 */
const SNIPPET_RADIUS = 6;
/** The busiest few files, drawn larger — the map has a middle, and this is how you see it. */
const HUB_RADIUS = 14;
const HUBS = 5;

/**
 * One disc from the map, drawn beside the sentence that says what it means.
 *
 * The same element, the same class and the same radius the canvas uses, in a box sized so the
 * biggest of them fits — a legend redrawn by hand would be a second description of the map and
 * would be the one that went stale.
 */
function Swatch({ kind }: { readonly kind: 'hub' | 'file' | 'quote' }): JSX.Element {
  const radius = kind === 'hub' ? HUB_RADIUS : kind === 'quote' ? SNIPPET_RADIUS : NODE_RADIUS;
  // The *modifier* class only, never `wr-graph__node` itself: the fill rules are written as
  // `.wr-graph__node--seed .wr-graph__disc`, so the modifier alone paints the swatch the way
  // the canvas paints the disc, without also giving a legend the pointer cursor of a control.
  const modifier =
    kind === 'hub' ? 'wr-graph__node--seed' : kind === 'quote' ? 'wr-graph__node--quote' : '';
  const box = HUB_RADIUS + 2;
  return (
    <svg
      className="wr-graph__swatch"
      viewBox={`${String(-box)} ${String(-box)} ${String(box * 2)} ${String(box * 2)}`}
      aria-hidden="true"
    >
      <g className={modifier}>
        <circle className="wr-graph__disc" r={radius} />
      </g>
    </svg>
  );
}

export interface WikiPanelBodyProps {
  /**
   * When set, a node is *chosen* instead of opened — the link picker's map (`H04`).
   *
   * The page is unchanged otherwise: the same query, the same ranking, the same layout. What a
   * click means belongs to the surface, which is why `graph-canvas` carries the decision as a
   * `data-action` rather than baking one in.
   */
  readonly onChoose?: (entityType: string, entityId: string) => void;
  /** What the map is called on screen, when it is being used for something else. */
  readonly heading?: string;
}

export function WikiPanelBody({ onChoose, heading }: WikiPanelBodyProps = {}): JSX.Element {
  const { store, workbench, run } = useWorkspace();
  const [size, setSize] = useState<number>(DEFAULT_SIZE);
  const [overview, setOverview] = useState<GraphOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [query, setQuery] = useState('');
  /** The line the researcher has singled out, ready to be taken away (`H07`). */
  const [chosenEdge, setChosenEdge] = useState<string | null>(null);

  /**
   * Two discs joined by dragging between them (`H09`).
   *
   * Through the command every other link gesture goes through, so a drag makes exactly the edge
   * the picker makes — including the type nobody was asked for. The picker in the corner of the
   * screen and a drag across the map must not be two ways of writing two different things.
   */
  const linkNodes = useCallback(
    (from: SceneEntityRef, to: SceneEntityRef) => {
      if (onChoose !== undefined) return; // the picker's copy of this page chooses, it does not write
      void run(COMMAND_IDS.createDocumentLink, {
        sourceId: from.entityId,
        sourceType: from.entityType,
        targetId: to.entityId,
        targetType: to.entityType,
      });
    },
    [onChoose, run],
  );

  const scene = useSceneView(undefined, linkNodes);
  const clipId = useId();

  const load = useCallback(
    (nodeLimit: number) => {
      setLoading(true);
      return call('graph:overview', { nodeLimit, edgeLimit: EDGE_LIMIT })
        .then((answer) => {
          setOverview(answer);
          setError(null);
        })
        .catch((failure: unknown) => {
          setError(describeError(failure).message);
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    void load(size);
    // The library is what this page is of, so it redraws when the library changes — a file
    // imported while the wiki is open belongs on the map without reopening it.
    return subscribe('library:changed', (payload) => {
      if (!REDRAWS_THE_MAP(payload.reason)) return;
      void load(size);
    });
  }, [load, size]);

  // The arrangement, from the same package that ranked the answer. Rebuilt only when the answer
  // changes: a re-layout on every render would move the map under the pointer.
  //
  // No Cytoscape model here, unlike the other two surfaces. The spiral is a pure function of the
  // ranking main sent, and nothing on this page asks the graph a question — there is no
  // containment to box and no traversal to walk, so an instance would be built and thrown away
  // once per redraw of the whole library.
  const laidOut = useMemo(() => {
    if (overview === null) return null;
    const order = overview.nodes.map((node) => sceneKey(node.entityType, node.entityId));
    // A marked sentence is drawn beside the paper it was made in rather than at its own place
    // in the ranking (`V01`). The containment comes from the answer — the same `parent` the
    // neighbourhood panel boxes with (`G06`) — so the page never infers it from a link type.
    const heldBy = new Map(
      overview.nodes.flatMap((node) =>
        node.parent === null
          ? []
          : [
              [
                sceneKey(node.entityType, node.entityId),
                sceneKey(node.parent.entityType, node.parent.entityId),
              ] as const,
            ],
      ),
    );
    return {
      positions: overviewPositions(order, { width: VIEW_WIDTH, height: VIEW_HEIGHT }, heldBy),
    };
  }, [overview]);

  /**
   * What the researcher is looking for, and where it is (`V02`).
   *
   * The map is searched in place: matching nodes keep their positions and everything else is
   * dimmed, so what is found is found *somewhere* — in the middle of a cluster, at the edge,
   * beside a paper it was marked in — which is the whole reason to have a map rather than a
   * list. A highlight is matched on its own words as well as its title, because the words are
   * what it is (`V01`) and looking for a sentence you marked is the case this exists for.
   */
  const needle = filterNeedle(query);
  const matched = useMemo(() => {
    const found = new Set<string>();
    if (overview === null || laidOut === null || needle === '') return found;
    for (const node of overview.nodes) {
      if (matchesNeedle(needle, node.displayName, node.title, node.snippet)) {
        found.add(sceneKey(node.entityType, node.entityId));
      }
    }
    return found;
  }, [laidOut, needle, overview]);

  // The matches as one string — a change detector and nothing else, so the view moves when
  // the *answer* changes and not on every render of the page around it. The keys themselves
  // are read from a ref, because a key is `<type> <id>` and splitting a joined list of them
  // back apart is a bug waiting for the first id with a separator in it.
  const matchedRef = useRef(matched);
  matchedRef.current = matched;
  const destination = [...matched].sort().join('|');
  const panTo = scene.panTo;
  useEffect(() => {
    if (destination === '' || laidOut === null) return;
    panTo(
      [...matchedRef.current].flatMap((id) => {
        const at = laidOut.positions.get(id);
        return at === undefined ? [] : [at];
      }),
    );
    // `laidOut` is deliberately not a dependency: a redraw of the library must not yank the
    // view back to a filter the researcher has since panned away from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, panTo]);

  /**
   * Open what a node stands for.
   *
   * Through the workbench, like every other way of opening something — this page never reaches
   * into a reader. To the side, so the map is still there to click again: it is a way of getting
   * around the library, not a menu that closes behind you.
   */
  const open = useCallback(
    (entityType: string, entityId: string) => {
      if (onChoose !== undefined) {
        onChoose(entityType, entityId);
        return;
      }
      const parsed = LinkableEntityTypeSchema.safeParse(entityType);
      if (!parsed.success) return;
      void workbench
        .navigate({ entityId, entityType: parsed.data }, 'side')
        .catch((failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        });
    },
    [onChoose, store, workbench],
  );

  // The same actions the row in the library offers, on the disc that stands for the same file
  // (`R01`). The picker's copy of this page gets it too: choosing an end of a link is one thing
  // you can do to a node, and it is not the only one.
  const nodeMenu = useGraphNodeMenu();

  if (error !== null) return <ErrorState message={error} testId="wiki-panel-error" />;
  if (overview === null && loading) {
    return <EmptyState message="Reading the library…" testId="wiki-panel-loading" />;
  }
  if (overview === null || laidOut === null) {
    return <EmptyState message="Nothing on the shelf yet." testId="wiki-panel-empty" />;
  }
  const { positions } = laidOut;
  /** Marked sentences actually on the map, which is what the header may promise. */
  const quoted = overview.nodes.filter((node) => node.entityType === 'annotation').length;

  return (
    <div
      className="wr-graph"
      data-testid="wiki-panel"
      data-node-count={String(overview.nodes.length)}
      data-edge-count={String(overview.edges.length)}
      data-total-nodes={String(overview.totalNodes)}
      data-total-edges={String(overview.totalEdges)}
      data-elided-edges={String(overview.elidedEdges)}
      data-truncated={overview.truncated ? 'true' : 'false'}
    >
      <header className="wr-graph__header">
        <span className="wr-graph__title">
          {heading ?? 'The wiki'} ·{' '}
          {overview.totalNodes === 1
            ? '1 file'
            : quoted === 0
              ? `${String(overview.totalNodes)} files and notes`
              : `${String(overview.totalNodes)} files, notes and highlights`}
        </span>
        {/*
          A marked sentence reaches the map only once something links it — the containment edge
          every highlight is born with is not drawn, so "on the map" means "the researcher
          connected this sentence to something". A header that promised highlights to a
          researcher who had just marked six of them and could see none explained nothing. Said
          here rather than in the legend because the legend describes the marks the map uses,
          and this is about the map in front of you.
        */}
        {quoted === 0 && (
          <span className="wr-graph__elided" data-testid="wiki-no-quotes">
            a sentence you marked joins the map when you link it to something
          </span>
        )}
        {/* Two counters, never one number: a file left off the map and a line left off it are
            different facts about what is missing, and a sum of them is neither. */}
        {overview.elidedNodes > 0 && (
          <span className="wr-graph__elided" data-testid="wiki-elision">
            {overview.elidedNodes} more not shown
          </span>
        )}
        {overview.elidedEdges > 0 && (
          <span className="wr-graph__elided" data-testid="wiki-edge-elision">
            {overview.elidedEdges} more links not drawn
          </span>
        )}
      </header>
      <div className="wr-graph__settings" data-testid="wiki-settings">
        <SceneFilter
          testIdPrefix="wiki"
          query={query}
          onQuery={setQuery}
          matches={matched.size}
          total={overview.nodes.length}
        />
        <label className="wr-graph__setting">
          <span>Show</span>
          <select
            data-testid="wiki-setting-size"
            data-control="wiki.size"
            title="How many files, notes and marked sentences to lay out, busiest first"
            value={String(size)}
            onChange={(event) => {
              setSize(Number(event.target.value));
            }}
          >
            {SIZES.map((choice) => (
              <option key={choice} value={String(choice)}>
                {choice}
              </option>
            ))}
          </select>
        </label>
        <label className="wr-graph__setting">
          <input
            data-testid="wiki-setting-labels"
            data-control="graph.labels"
            type="checkbox"
            checked={showLabels}
            onChange={(event) => {
              setShowLabels(event.target.checked);
            }}
          />
          <span>Labels</span>
        </label>
        <button
          type="button"
          className="wr-graph__reset"
          data-testid="wiki-view-reset"
          data-control="graph.reset"
          onClick={scene.reset}
        >
          Reset view
        </button>
      </div>
      {/*
        What the picture means, said on the picture.
        The page already encodes three distinctions in its marks — a hub is drawn larger, a
        marked sentence is drawn smaller and quoted, a line is a typed edge — and nothing on
        screen said so, so the map was something to look at rather than to read. The swatches
        are the same classes the canvas draws with, at the same radii, which is the only way a
        legend can stay true: restyle a disc and its swatch moves with it.
      */}
      <p className="wr-graph__legend" data-testid="wiki-legend">
        <span className="wr-graph__legend-item">
          <Swatch kind="hub" />
          one of the {HUBS} most-linked
        </span>
        <span className="wr-graph__legend-item">
          <Swatch kind="file" />a file or a note
        </span>
        <span className="wr-graph__legend-item">
          <Swatch kind="quote" />
          “a sentence you marked”
        </span>
        <span className="wr-graph__legend-item">
          <svg className="wr-graph__swatch" viewBox="-16 -16 32 32" aria-hidden="true">
            <line className="wr-graph__edge" x1={-13} y1={0} x2={13} y2={0} />
          </svg>
          a typed link between them
        </span>
        <span className="wr-graph__legend-item wr-graph__legend-item--verb">
          Click one to open it; right-click for the rest.
        </span>
      </p>
      <svg
        className="wr-graph__canvas"
        data-testid="wiki-canvas"
        // The gesture that makes a link here has no button to hang an id on, so the canvas
        // carries it: press a disc, drag to another, let go (`H09`).
        data-control="link.dragNodes"
        data-linking={scene.linkDrag === null ? 'false' : 'true'}
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Every file in the library and the links between them"
        {...scene.svgProps}
      >
        <defs>
          <clipPath id={`${clipId}-hub`} clipPathUnits="userSpaceOnUse">
            <circle r={HUB_RADIUS} />
          </clipPath>
          <clipPath id={`${clipId}-node`} clipPathUnits="userSpaceOnUse">
            <circle r={NODE_RADIUS} />
          </clipPath>
          <clipPath id={`${clipId}-snippet`} clipPathUnits="userSpaceOnUse">
            <circle r={SNIPPET_RADIUS} />
          </clipPath>
        </defs>
        <SceneViewportGroup testId="wiki-viewport" view={scene.view}>
          {overview.edges.map((edge) => {
            const from = positions.get(sceneKey(edge.sourceType, edge.sourceId));
            const to = positions.get(sceneKey(edge.targetType, edge.targetId));
            if (from === undefined || to === undefined) return null;
            return (
              <SceneEdge
                key={edge.id}
                testId={`wiki-edge-${edge.id}`}
                linkType={edge.type}
                from={from}
                to={to}
                lit={
                  needle === '' ||
                  matched.has(sceneKey(edge.sourceType, edge.sourceId)) ||
                  matched.has(sceneKey(edge.targetType, edge.targetId))
                }
                // A line on the map is a row in `links`, and this is where a wrong one is most
                // often seen (`H07`). Two presses: one to say which line, one to mean it.
                chosen={chosenEdge === edge.id}
                onChoose={
                  onChoose === undefined
                    ? () => {
                        setChosenEdge((now) => (now === edge.id ? null : edge.id));
                      }
                    : undefined
                }
                onDelete={() => {
                  setChosenEdge(null);
                  void run(COMMAND_IDS.deleteLink, { linkId: edge.id });
                }}
              />
            );
          })}
          {overview.nodes.map((node, rank) => {
            const at = positions.get(sceneKey(node.entityType, node.entityId));
            if (at === undefined) return null;
            // A marked sentence is never a hub, whatever its degree: the hubs are the middle of
            // the *library*, and a sentence drawn like a paper is the confusion `V01` is about.
            const hub = rank < HUBS && node.degree > 0 && node.snippet === null;
            const radius = node.snippet === null ? (hub ? HUB_RADIUS : NODE_RADIUS) : SNIPPET_RADIUS;
            return (
              <SceneNode
                key={sceneKey(node.entityType, node.entityId)}
                testIdPrefix="wiki-node"
                entityType={node.entityType}
                entityId={node.entityId}
                title={node.title}
                displayName={node.displayName}
                iconFileId={node.iconFileId}
                quote={node.snippet}
                x={at.x}
                y={at.y}
                radius={radius}
                primary={hub}
                showLabel={showLabels}
                matches={needle === '' || matched.has(sceneKey(node.entityType, node.entityId))}
                clipPathId={`${clipId}-${node.snippet === null ? (hub ? 'hub' : 'node') : 'snippet'}`}
                action={onChoose === undefined ? 'open' : 'refocus'}
                data={{ degree: String(node.degree), rank: String(rank) }}
                onActivate={() => {
                  open(node.entityType, node.entityId);
                }}
                onContextMenu={(event) => {
                  nodeMenu(event, node);
                }}
              />
            );
          })}
        </SceneViewportGroup>
        {/* Over the scene rather than in it: both ends are already in the canvas's own units. */}
        <SceneLinkLine testId="wiki-link-drag" drag={scene.linkDrag} />
      </svg>
    </div>
  );
}

export function WikiPanel(_props: IDockviewPanelProps<{ panelId: string }>): JSX.Element {
  return <WikiPanelBody />;
}
