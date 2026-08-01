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
import {
  LinkableEntityTypeSchema,
  type GraphOverview,
  type IpcTopicPayload,
} from '@wr/shared-types';
import { useGraphNodeMenu } from './context-menu.js';
import { call, describeError, subscribe } from './ipc.js';
import { useWorkspace } from './workspace.js';
import {
  SceneFilter,
  SceneNode,
  SceneViewportGroup,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  filterNeedle,
  matchesNeedle,
  useSceneView,
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
  const { store, workbench } = useWorkspace();
  const [size, setSize] = useState<number>(DEFAULT_SIZE);
  const [overview, setOverview] = useState<GraphOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [query, setQuery] = useState('');
  const scene = useSceneView();
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
    const keyOf = (entityType: string, entityId: string): string => `${entityType} ${entityId}`;
    const order = overview.nodes.map((node) => keyOf(node.entityType, node.entityId));
    // A marked sentence is drawn beside the paper it was made in rather than at its own place
    // in the ranking (`V01`). The containment comes from the answer — the same `parent` the
    // neighbourhood panel boxes with (`G06`) — so the page never infers it from a link type.
    const heldBy = new Map(
      overview.nodes.flatMap((node) =>
        node.parent === null
          ? []
          : [
              [
                keyOf(node.entityType, node.entityId),
                keyOf(node.parent.entityType, node.parent.entityId),
              ] as const,
            ],
      ),
    );
    return {
      keyOf,
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
        found.add(laidOut.keyOf(node.entityType, node.entityId));
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
  const { keyOf, positions } = laidOut;

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
            : `${String(overview.totalNodes)} files, notes and highlights`}
        </span>
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
      <svg
        className="wr-graph__canvas"
        data-testid="wiki-canvas"
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
            const from = positions.get(keyOf(edge.sourceType, edge.sourceId));
            const to = positions.get(keyOf(edge.targetType, edge.targetId));
            if (from === undefined || to === undefined) return null;
            // A line is as dim as the fainter of its two ends: a line into the dark from a
            // match is the answer to "and what does this one reach", and one between two
            // dimmed nodes is not what was asked for.
            const lit =
              needle === '' ||
              matched.has(keyOf(edge.sourceType, edge.sourceId)) ||
              matched.has(keyOf(edge.targetType, edge.targetId));
            return (
              <line
                key={edge.id}
                className={lit ? 'wr-graph__edge' : 'wr-graph__edge wr-graph__edge--dimmed'}
                data-testid={`wiki-edge-${edge.id}`}
                data-link-type={edge.type}
                data-match={lit ? 'true' : 'false'}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            );
          })}
          {overview.nodes.map((node, rank) => {
            const at = positions.get(keyOf(node.entityType, node.entityId));
            if (at === undefined) return null;
            // A marked sentence is never a hub, whatever its degree: the hubs are the middle of
            // the *library*, and a sentence drawn like a paper is the confusion `V01` is about.
            const hub = rank < HUBS && node.degree > 0 && node.snippet === null;
            const radius = node.snippet === null ? (hub ? HUB_RADIUS : NODE_RADIUS) : SNIPPET_RADIUS;
            return (
              <SceneNode
                key={keyOf(node.entityType, node.entityId)}
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
                matches={needle === '' || matched.has(keyOf(node.entityType, node.entityId))}
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
      </svg>
    </div>
  );
}

export function WikiPanel(_props: IDockviewPanelProps<{ panelId: string }>): JSX.Element {
  return <WikiPanelBody />;
}
