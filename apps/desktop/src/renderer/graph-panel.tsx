/**
 * The graph panel (criteria W09, W10).
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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { createGraph, layoutPositions } from '@wr/graph';
import { EmptyState, ErrorState } from '@wr/shared-ui';
import { LinkableEntityTypeSchema, type GraphNeighbourhood } from '@wr/shared-types';
import type { PanelDescriptor } from '@wr/workbench';
import { call, describeError } from './ipc.js';
import { useWorkspace, useWorkspaceState } from './workspace.js';

/** The logical drawing area. The SVG scales it to whatever the panel is; nothing measures. */
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 700;

/** How many nodes a neighbourhood view asks for. The contract caps it lower than it can go. */
const NODE_LIMIT = 60;

function truncate(text: string, max = 28): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface GraphPanelBodyProps {
  readonly seedEntityId: string;
  readonly seedEntityType: string;
  readonly depth: number;
}

export function GraphPanelBody({
  seedEntityId,
  seedEntityType,
  depth,
}: GraphPanelBodyProps): JSX.Element {
  const { store, workbench } = useWorkspace();
  const [graph, setGraph] = useState<GraphNeighbourhood | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const seedType = LinkableEntityTypeSchema.safeParse(seedEntityType);
    if (!seedType.success) {
      setError(`Not something the graph can open on: ${seedEntityType}`);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const neighbourhood = await call('graph:neighbourhood', {
          seedType: seedType.data,
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
  }, [depth, seedEntityId, seedEntityType]);

  // Cytoscape's model, built from what main sent, laid out by the same package that bounded
  // it. Rebuilt only when the neighbourhood changes: a re-layout on every render would move
  // the graph under the pointer.
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
    const positions = layoutPositions(
      model,
      { width: VIEW_WIDTH, height: VIEW_HEIGHT },
      distances,
    );
    return { keyOf, positions };
  }, [graph]);

  const open = useCallback(
    (entityType: string, entityId: string) => {
      const parsed = LinkableEntityTypeSchema.safeParse(entityType);
      if (!parsed.success) return;
      // Through the workbench, like every other way of opening something. The graph panel
      // does not reach into the reader panel, and it stays open behind what it opened.
      void workbench.navigate({ entityId, entityType: parsed.data }, 'current').catch(
        (failure: unknown) => {
          store.setStatus(describeError(failure).message, 'error');
        },
      );
    },
    [store, workbench],
  );

  if (loading) return <EmptyState message="Reading the graph…" testId="graph-panel-loading" />;
  if (error !== null) return <ErrorState message={error} testId="graph-panel-error" />;
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
      <svg
        className="wr-graph__canvas"
        data-testid="graph-canvas"
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Links around ${graph.seed.title}`}
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
          return (
            <g
              key={key}
              className={isSeed ? 'wr-graph__node wr-graph__node--seed' : 'wr-graph__node'}
              data-testid={`graph-node-${node.entityId}`}
              data-entity-type={node.entityType}
              data-distance={String(node.distance)}
              data-degree={String(node.degree)}
              role="button"
              tabIndex={0}
              aria-label={`Open ${node.title}`}
              transform={`translate(${String(position.x)}, ${String(position.y)})`}
              onClick={() => open(node.entityType, node.entityId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  open(node.entityType, node.entityId);
                }
              }}
            >
              <circle className="wr-graph__disc" r={isSeed ? 16 : 11} />
              <text className="wr-graph__label" y={isSeed ? 34 : 28} textAnchor="middle">
                {truncate(node.title)}
              </text>
            </g>
          );
        })}
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
  depth: number;
} | null {
  if (descriptor === null || descriptor.kind !== 'link-graph') return null;
  if (descriptor.seedEntityId === null || descriptor.seedEntityType === null) return null;
  return {
    seedEntityId: descriptor.seedEntityId,
    seedEntityType: descriptor.seedEntityType,
    depth: descriptor.depth,
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
