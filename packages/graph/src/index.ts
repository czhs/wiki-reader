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
  /**
   * The compound node this one is drawn inside, or null for one that stands alone.
   *
   * Cytoscape's own parentage, so "this highlight belongs to that paper" is a fact about the
   * model rather than a hint the renderer is left to infer from how long an edge is (`G06`).
   */
  readonly parent?: string | null;
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
      // A parent nobody was sent is dropped for the same reason a dangling edge is: Cytoscape
      // throws on a container that does not exist, and a bounded neighbourhood legitimately
      // cuts a document away from a highlight it holds. Such a node is drawn on its own.
      nodes: nodes.map((node) => ({
        data:
          node.parent === undefined ||
          node.parent === null ||
          node.parent === node.id ||
          !known.has(node.parent)
            ? { id: node.id }
            : { id: node.id, parent: node.parent },
      })),
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
 * How far a node inside a container sits from the container's own node.
 *
 * Fixed rather than scaled by how many there are: a highlight is at a glance *this paper's*,
 * and a ring that grew with the count would put the first one of ten somewhere different from
 * the first one of two. Crowding is absorbed by widening, below.
 */
const CHILD_ORBIT = 46;

/**
 * Positions for a laid-out neighbourhood, in the box the caller will draw into.
 *
 * Concentric rings by distance from the seed, computed here rather than by a force layout:
 * a neighbourhood view answers "what is near this thing", and a ring per hop says that
 * directly and lands in the same place every time — a graph that reshuffles itself on every
 * open is one the reader has to re-read. Cytoscape holds the model; the arrangement is a
 * property of the query, so it is derived from the same distances.
 *
 * A node inside a compound parent is *not* placed by its own hop count. Its container already
 * has a ring position, and a highlight two hops from the seed but belonging to the paper at one
 * would otherwise be drawn a ring away from the thing it is part of — which is precisely the
 * inference `G06` stops asking the reader to make. Children orbit their container instead.
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
    if (node.isChild()) continue;
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

  for (const parent of graph.nodes().filter((node) => node.isParent())) {
    const at = positions.get(parent.id());
    if (at === undefined) continue;
    const children = parent
      .children()
      .map((child) => child.id())
      .sort();
    // Enough of a ring that discs on it do not touch, however many there are.
    const orbit = Math.max(CHILD_ORBIT, (children.length * 26) / (Math.PI * 2));
    for (const [index, id] of children.entries()) {
      const angle = (index / children.length) * Math.PI * 2 - Math.PI / 2;
      positions.set(id, {
        x: at.x + Math.cos(angle) * orbit,
        y: at.y + Math.sin(angle) * orbit,
      });
    }
  }

  return positions;
}

/**
 * The golden angle. Successive nodes on a spiral placed this far apart never line up into
 * spokes, which is what makes a sunflower arrangement read as an even field rather than as a
 * set of arms — the property that matters when the thing being drawn is "all of it".
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Positions for a whole-corpus view: a spiral, densest at the middle, in the given order.
 *
 * Not concentric rings, because there is no seed to be a hop away from — the wiki page is the
 * library seen at once, and its centre is whatever the caller ranked first. A spiral spends the
 * area evenly, so doubling the number of files makes the picture denser rather than pushing
 * everything into one outer ring, and the arrangement is a pure function of the order: the same
 * library draws the same map every time it is opened, which is what makes it a *place* rather
 * than a fresh picture of the same facts.
 *
 * `order` is the caller's ranking and is the only thing that decides where a node lands.
 */
export function overviewPositions(
  order: readonly string[],
  box: LayoutBox,
): Map<string, GraphPosition> {
  const positions = new Map<string, GraphPosition>();
  const centreX = box.width / 2;
  const centreY = box.height / 2;
  if (order.length === 0) return positions;

  // Room for the label under the outermost disc, the same margin the ring layout leaves.
  const limit = Math.min(box.width, box.height) / 2 - 48;
  const step = order.length < 2 ? 0 : limit / Math.sqrt(order.length - 1);

  for (const [index, id] of order.entries()) {
    const radius = step * Math.sqrt(index);
    const angle = index * GOLDEN_ANGLE - Math.PI / 2;
    positions.set(id, {
      x: centreX + Math.cos(angle) * radius,
      y: centreY + Math.sin(angle) * radius,
    });
  }
  return positions;
}

/** One file in the middle, what it says around it, where it leads at the edges. */
export interface FocusArrangement {
  /** The file the view is focused on. */
  readonly centreId: string;
  /** Its own highlights: the inner ring, nearest the middle. */
  readonly innerIds: readonly string[];
  /** The files it connects to: the outer ring, at the edge. */
  readonly outerIds: readonly string[];
}

/**
 * How near the middle the inner ring sits, as a fraction of the outer one.
 *
 * Fixed and well under 1, so "an annotation is nearer the centre than any connected file" is a
 * property of the layout rather than of how many of each there happen to be. The focused view
 * is read as two bands — what this file says, and where it leads — and a ring that could grow
 * past the one outside it would dissolve that reading exactly when the file is richest.
 */
const INNER_RING_FRACTION = 0.42;

/**
 * Positions for a focused view: the file at the centre, its highlights around it, the files it
 * connects to at the edge.
 *
 * Two bands rather than one layout with a node cap, because the two are answering different
 * questions and must not compete for room: what this paper says is the middle of the picture,
 * and what it leads to is its border. Deterministic from the order it is given, for the same
 * reason the ring layout is — a view somebody crawls has to hold still under them.
 */
export function focusPositions(
  arrangement: FocusArrangement,
  box: LayoutBox,
): Map<string, GraphPosition> {
  const positions = new Map<string, GraphPosition>();
  const centreX = box.width / 2;
  const centreY = box.height / 2;
  positions.set(arrangement.centreId, { x: centreX, y: centreY });

  const outerRadius = Math.max(Math.min(box.width, box.height) / 2 - 56, 64);
  const innerRadius = outerRadius * INNER_RING_FRACTION;

  const place = (ids: readonly string[], radius: number, offset: number): void => {
    for (const [index, id] of ids.entries()) {
      if (id === arrangement.centreId) continue;
      const angle = (index / Math.max(ids.length, 1)) * Math.PI * 2 - Math.PI / 2 + offset;
      positions.set(id, {
        x: centreX + Math.cos(angle) * radius,
        y: centreY + Math.sin(angle) * radius,
      });
    }
  };

  place(arrangement.innerIds, innerRadius, 0);
  // Offset, so a file at the edge is never drawn directly behind a highlight on the ring
  // inside it and the line to it never runs through one.
  place(arrangement.outerIds, outerRadius, Math.PI / 7);
  return positions;
}

/** A drawn container: where it starts and how big it is, in the same units as the positions. */
export interface GroupBox extends GraphPosition, LayoutBox {}

/**
 * The rectangle around each compound node, from where its contents actually ended up.
 *
 * Derived from the laid-out positions rather than placed: the caller may have moved the whole
 * arrangement — spacing does exactly that — and a box computed from anything but the final
 * positions is a rectangle that has drifted off the things it claims to hold.
 */
export function groupBoxes(
  graph: Core,
  positions: ReadonlyMap<string, GraphPosition>,
  padding = 26,
): Map<string, GroupBox> {
  const boxes = new Map<string, GroupBox>();
  for (const parent of graph.nodes().filter((node) => node.isParent())) {
    const held = [parent.id(), ...parent.children().map((child) => child.id())]
      .map((id) => positions.get(id))
      .filter((at): at is GraphPosition => at !== undefined);
    if (held.length === 0) continue;
    const xs = held.map((at) => at.x);
    const ys = held.map((at) => at.y);
    const left = Math.min(...xs) - padding;
    const top = Math.min(...ys) - padding;
    boxes.set(parent.id(), {
      x: left,
      y: top,
      width: Math.max(...xs) + padding - left,
      height: Math.max(...ys) + padding - top,
    });
  }
  return boxes;
}
