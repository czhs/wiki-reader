/**
 * The graph model, shared by the main process and the renderer.
 *
 * Cytoscape's model is separable from its renderer, which is the whole reason it was chosen
 * (`state/DECISIONS.md`): the main process builds a headless instance to answer "what is
 * within N hops of this entity, capped at M nodes", and the renderer builds one from the
 * answer to lay it out. One traversal implementation, two callers — so the bounded subgraph
 * the renderer draws is bounded by the same code that decided what to send it.
 *
 * Nothing here touches the database or the DOM. Nodes are opaque string ids; giving them
 * meaning is `@wr/database`'s job on one side and the panel's on the other.
 */
import cytoscape, { type Core, type NodeCollection } from 'cytoscape';

export interface GraphElementNode {
  readonly id: string;
}

export interface GraphElementEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

/**
 * A headless Cytoscape instance over the given elements.
 *
 * `styleEnabled: false` because nothing here paints: style resolution is measurable work on a
 * few hundred nodes and the caller that renders supplies its own.
 */
export function createGraph(
  nodes: readonly GraphElementNode[],
  edges: readonly GraphElementEdge[],
): Core {
  const known = new Set(nodes.map((node) => node.id));
  return cytoscape({
    headless: true,
    styleEnabled: false,
    elements: {
      nodes: nodes.map((node) => ({ data: { id: node.id } })),
      // A dangling edge would throw when Cytoscape resolved its endpoints. Frontier
      // expansion legitimately produces them at the boundary — the edge to a node one hop
      // past the depth bound — so they are dropped here rather than guarded at every caller.
      edges: edges
        .filter((edge) => known.has(edge.source) && known.has(edge.target))
        .map((edge) => ({ data: { id: edge.id, source: edge.source, target: edge.target } })),
    },
  });
}

export interface NeighbourhoodBound {
  readonly seedId: string;
  /** Hops from the seed. 1 is "the seed and what touches it". */
  readonly depth: number;
  /** Hard cap on returned nodes, seed included. */
  readonly nodeLimit: number;
}

export interface BoundedNeighbourhood {
  /** The seed first, then outward by distance and id. */
  readonly nodeIds: readonly string[];
  /** Only edges whose endpoints are both kept: no half-edges to nodes nobody was sent. */
  readonly edgeIds: readonly string[];
  readonly distances: ReadonlyMap<string, number>;
  /** Nodes inside the depth bound that the node cap dropped. Never silently zero. */
  readonly elidedNodes: number;
}

const EMPTY: BoundedNeighbourhood = {
  nodeIds: [],
  edgeIds: [],
  distances: new Map(),
  elidedNodes: 0,
};

/**
 * Everything within `depth` hops of the seed, capped at `nodeLimit` nodes.
 *
 * Expansion is level by level over Cytoscape's own neighbourhood algebra, so "distance" is a
 * fact about the graph rather than the order a SQL query happened to return rows in. The cap
 * keeps the nearest nodes — dropping the far ones is what a reader expects of a view opened
 * *on* something — and reports how many it dropped, because a truncation nobody is told about
 * reads as "this is all there is".
 */
export function boundedNeighbourhood(
  graph: Core,
  bound: NeighbourhoodBound,
): BoundedNeighbourhood {
  const seed = graph.getElementById(bound.seedId);
  if (seed.empty() || !seed.isNode()) return EMPTY;
  if (bound.nodeLimit < 1 || bound.depth < 0) return EMPTY;

  const distances = new Map<string, number>([[bound.seedId, 0]]);
  const ordered: string[] = [bound.seedId];

  let included: NodeCollection = seed;
  let frontier: NodeCollection = seed;
  for (let hop = 1; hop <= bound.depth; hop += 1) {
    const next = frontier.openNeighborhood().nodes().difference(included);
    if (next.empty()) break;
    const ids = next.map((node) => node.id()).sort();
    for (const id of ids) {
      distances.set(id, hop);
      ordered.push(id);
    }
    included = included.union(next);
    frontier = next;
  }

  const kept = ordered.slice(0, bound.nodeLimit);
  const keptSet = new Set(kept);
  const keptNodes = included.filter((node) => keptSet.has(node.id()));
  const edgeIds = keptNodes
    .edgesWith(keptNodes)
    .map((edge) => edge.id())
    .sort();

  return {
    nodeIds: kept,
    edgeIds,
    distances: new Map(kept.map((id) => [id, distances.get(id) ?? 0])),
    elidedNodes: ordered.length - kept.length,
  };
}

export interface LayoutBox {
  readonly width: number;
  readonly height: number;
}

export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Positions for a laid-out neighbourhood, in the box the caller will draw into.
 *
 * Concentric rings by distance from the seed, computed here rather than by a force layout:
 * a neighbourhood view answers "what is near this thing", and a ring per hop says that
 * directly and lands in the same place every time — a graph that reshuffles itself on every
 * open is one the reader has to re-read. Cytoscape holds the model; the arrangement is a
 * property of the query, so it is derived from the same distances.
 */
export function layoutPositions(
  graph: Core,
  box: LayoutBox,
  distances: ReadonlyMap<string, number>,
): Map<string, GraphPosition> {
  const positions = new Map<string, GraphPosition>();
  const centreX = box.width / 2;
  const centreY = box.height / 2;

  const rings = new Map<number, string[]>();
  for (const node of graph.nodes()) {
    const id = node.id();
    const distance = distances.get(id) ?? 0;
    const ring = rings.get(distance);
    if (ring === undefined) rings.set(distance, [id]);
    else ring.push(id);
  }

  const maxDistance = Math.max(0, ...rings.keys());
  // Leave a margin the size of one node label so nothing on the outer ring is clipped.
  const radiusStep =
    maxDistance === 0 ? 0 : (Math.min(box.width, box.height) / 2 - 48) / maxDistance;

  for (const [distance, ids] of [...rings.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...ids].sort();
    if (distance === 0) {
      for (const id of sorted) positions.set(id, { x: centreX, y: centreY });
      continue;
    }
    const radius = Math.max(radiusStep * distance, 32);
    for (const [index, id] of sorted.entries()) {
      // Rings start at the top and are offset per ring, so a node is never hidden directly
      // behind one on the ring inside it.
      const angle = (index / sorted.length) * Math.PI * 2 - Math.PI / 2 + distance * 0.4;
      positions.set(id, {
        x: centreX + Math.cos(angle) * radius,
        y: centreY + Math.sin(angle) * radius,
      });
    }
  }

  return positions;
}
