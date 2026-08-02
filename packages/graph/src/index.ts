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
 *
 * `heldBy` names the nodes that belong *inside* another one — a marked sentence and the paper
 * it was made in (`V01`). They are not part of the spiral: they sit on a small ring around
 * whatever holds them, so that "this sentence is in that paper" is read off the arrangement
 * the way `G06` reads it off a box, without a box to draw at this density. A holder that is
 * not itself in `order` cannot hold anything, and its children fall back into the spiral —
 * the same rule the neighbourhood's `parent` follows.
 */
export function overviewPositions(
  order: readonly string[],
  box: LayoutBox,
  heldBy: ReadonlyMap<string, string> = new Map(),
): Map<string, GraphPosition> {
  const positions = new Map<string, GraphPosition>();
  const centreX = box.width / 2;
  const centreY = box.height / 2;
  if (order.length === 0) return positions;

  const placeable = new Set(order);
  const held = new Map<string, string[]>();
  const spiral: string[] = [];
  for (const id of order) {
    const holder = heldBy.get(id);
    if (holder === undefined || holder === id || !placeable.has(holder)) {
      spiral.push(id);
      continue;
    }
    const siblings = held.get(holder);
    if (siblings === undefined) held.set(holder, [id]);
    else siblings.push(id);
  }

  // Room for the label under the outermost disc, the same margin the ring layout leaves.
  const limit = Math.min(box.width, box.height) / 2 - 48;
  const step = spiral.length < 2 ? 0 : limit / Math.sqrt(spiral.length - 1);

  for (const [index, id] of spiral.entries()) {
    const radius = step * Math.sqrt(index);
    const angle = index * GOLDEN_ANGLE - Math.PI / 2;
    positions.set(id, {
      x: centreX + Math.cos(angle) * radius,
      y: centreY + Math.sin(angle) * radius,
    });
  }

  placeSatellites(positions, held, step);
  return positions;
}

/** How far a held node sits from what holds it, as a fraction of the spiral's own step. */
const SATELLITE_FRACTION = 0.5;
const SATELLITE_MIN = 26;
const SATELLITE_MAX = 46;
/**
 * Centre-to-centre room each node on a satellite ring is given.
 *
 * Wide enough that two of the small discs a marked sentence is drawn as cannot touch, so a
 * paper read very closely draws a wider ring rather than a ring of overlapping sentences —
 * which is the half of `F08` a relaxation between *top-level* nodes can never fix, because a
 * satellite rides on its holder and is never relaxed against its siblings.
 */
const SATELLITE_SPACING = 18;

/**
 * The ring of held nodes round each holder (`V01`), shared by every field that draws one.
 *
 * Written once because two callers place these — the whole library and the field the focused
 * view lays the rest of the library out in — and a sentence that sat at one distance from its
 * paper on one surface and another distance on the other would be two answers to "how near is
 * near enough to mean *inside*".
 */
function placeSatellites(
  positions: Map<string, GraphPosition>,
  held: ReadonlyMap<string, readonly string[]>,
  step: number,
): void {
  // Close enough to read as belonging, never so close as to be under the disc: a fraction of
  // the field's own step, so a dense library draws tighter clusters rather than clusters that
  // overlap their neighbours — widened when there are enough of them to crowd the ring.
  const base = Math.max(Math.min(step * SATELLITE_FRACTION, SATELLITE_MAX), SATELLITE_MIN);
  for (const [holder, children] of held) {
    const at = positions.get(holder);
    if (at === undefined) continue;
    const orbit = Math.max(base, (children.length * SATELLITE_SPACING) / (Math.PI * 2));
    for (const [index, id] of children.entries()) {
      const angle = (index / children.length) * Math.PI * 2 - Math.PI / 2;
      positions.set(id, {
        x: at.x + Math.cos(angle) * orbit,
        y: at.y + Math.sin(angle) * orbit,
      });
    }
  }
}

/**
 * The rest of the library, laid out round a view that is focused on one file (`F09`).
 *
 * Focusing used to *hide* the library: the focused state drew one file, its highlights and the
 * files it reaches, and everything else in the corpus simply was not there. The researcher's
 * verdict was that focus should not hide things — it should centre on the thing and leave the
 * rest of the map where it is, faint. So the focused view keeps its two bands and this places
 * everything else outside them: a sunflower field in the band between the outer ring and the
 * edges of the box, filled evenly by area so the corners are used rather than a ring being
 * stacked against the focus.
 *
 * `inner` is the radius the focused view has already spent. Nothing is seeded inside it, which
 * is what keeps the relaxation that follows from having to dig a hole in the middle of the map
 * before it can do anything else.
 */
export function contextFieldPositions(
  order: readonly string[],
  box: LayoutBox,
  inner: number,
  heldBy: ReadonlyMap<string, string> = new Map(),
): Map<string, GraphPosition> {
  const positions = new Map<string, GraphPosition>();
  if (order.length === 0) return positions;
  const centreX = box.width / 2;
  const centreY = box.height / 2;

  const placeable = new Set(order);
  const held = new Map<string, string[]>();
  const field: string[] = [];
  for (const id of order) {
    const holder = heldBy.get(id);
    if (holder === undefined || holder === id || !placeable.has(holder)) {
      field.push(id);
      continue;
    }
    const siblings = held.get(holder);
    if (siblings === undefined) held.set(holder, [id]);
    else siblings.push(id);
  }

  // The box is wider than it is tall, so the field is an ellipse rather than a circle: a
  // circular field would leave the corners of the map empty and crowd everything into a band.
  const limitX = Math.max(box.width / 2 - FIELD_MARGIN, 1);
  const limitY = Math.max(box.height / 2 - FIELD_MARGIN, 1);
  const startX = Math.min(inner / limitX, 0.9) ** 2;
  const startY = Math.min(inner / limitY, 0.9) ** 2;

  for (const [index, id] of field.entries()) {
    // Even by area between the inner boundary and the edge, which is what makes a doubled
    // library denser rather than pushing everything into one outer ring.
    const share = (index + 0.5) / field.length;
    const angle = index * GOLDEN_ANGLE - Math.PI / 2;
    positions.set(id, {
      x: centreX + Math.cos(angle) * limitX * Math.sqrt(startX + (1 - startX) * share),
      y: centreY + Math.sin(angle) * limitY * Math.sqrt(startY + (1 - startY) * share),
    });
  }

  placeSatellites(positions, held, SATELLITE_MIN * 2);
  return positions;
}

/** Room left round the field for the label under the outermost disc. */
const FIELD_MARGIN = 48;

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

// ---------------------------------------------------------------------------
// Laying out by force (`F08`)
// ---------------------------------------------------------------------------

/**
 * One node the relaxation moves, or carries.
 *
 * `at` is where a deterministic arrangement already put it — the spiral of the ranking, the
 * rings of a focused view, the field round one. The relaxation *refines* that; it never
 * invents a starting point, which is what keeps the same library drawing the same map every
 * time it is opened. See `forcePositions`.
 */
export interface ForceNode {
  readonly id: string;
  /** How much room this node's own disc needs. Two of them never end up closer than the sum. */
  readonly radius: number;
  readonly at: GraphPosition;
  /** Never moved: the file a focused view is on, or the busiest file the map has as its middle. */
  readonly pinned?: boolean;
  /**
   * The node this one rides on, at exactly the offset the seed gave it.
   *
   * A marked sentence and the paper it was made in (`V01`). A satellite is *not* relaxed: it
   * would be pulled off its paper by the first repulsion, and "this sentence is in that paper"
   * is read off the arrangement rather than off a box at this density. Its holder's radius is
   * widened to cover it instead, so the whole cluster keeps its distance from everything else.
   */
  readonly holder?: string | null;
}

/** A spring between two nodes. An end that is carried pulls through whatever carries it. */
export interface ForceEdge {
  readonly source: string;
  readonly target: string;
}

export interface ForceSettings {
  readonly iterations?: number;
  /** Clear space between the rims of two discs at rest. */
  readonly gap?: number;
  /** How hard the middle of the box holds the picture together, as a share of the step. */
  readonly gravity?: number;
  /** The spring's rest length, as a share of the room each node has in the box. */
  readonly spread?: number;
  /** How far inside the box a node's own rim must stay. */
  readonly margin?: number;
}

const FORCE_GAP = 6;
const FORCE_GRAVITY = 0.06;
const FORCE_SPREAD = 0.55;
const FORCE_MARGIN = 26;
/**
 * How many passes are spent pushing overlapping discs apart, after the forces have settled.
 *
 * A separate phase, and the reason `F08`'s second half is a *guarantee* rather than a
 * tendency: a spring layout balances attraction against repulsion and will happily rest with
 * two discs touching when an edge is pulling them together hard enough. Nothing here pulls —
 * each pass only ever moves two nodes apart, by exactly the distance they overlap — so the
 * arrangement it is given can only get less crowded, and it stops as soon as nothing moved.
 */
const SEPARATION_PASSES = 400;

/** How near "exactly far enough apart" counts as far enough apart, in scene units. */
const SETTLED = 1e-3;

/**
 * A force-directed arrangement: nodes push each other apart, links pull their ends together,
 * and no two discs overlap at rest (`F08`).
 *
 * The wiki used to be a pure sunflower spiral of the ranking — every node at the place its
 * degree bought it, whatever it was linked to. That drew a library as a texture: a paper and
 * the three papers it cites landed nowhere near each other unless their degrees happened to be
 * adjacent, and discs sat on top of one another wherever the spiral's step fell below their
 * size. The researcher asked for a layout that pushes nodes apart. So the spiral survives as
 * the *seed* — deterministic, ranked, the same picture every time — and this relaxes it:
 * Fruchterman–Reingold with a cooling schedule, clamped into the box, followed by a separation
 * phase that is what makes "none overlap" a promise instead of a hope.
 *
 * **Deterministic on purpose, and not Cytoscape's `cose`.** The library is here and its force
 * layouts were the obvious answer, but `cose` draws from `Math.random` on every run, so the
 * same library would come back a different shape each time it was opened — the map stops being
 * a place — and no assertion could name where anything was drawn. It is also the wrong shape
 * for the second half of the criterion: headless with `styleEnabled: false` it has no node
 * sizes to keep apart, and sizes are exactly what "none overlap" is about. Nothing here reads
 * a clock or a random number, so the same input is the same output, run for run and machine
 * for machine.
 */
export function forcePositions(
  nodes: readonly ForceNode[],
  edges: readonly ForceEdge[],
  box: LayoutBox,
  settings: ForceSettings = {},
): Map<string, GraphPosition> {
  const positions = new Map<string, GraphPosition>();
  if (nodes.length === 0) return positions;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const gap = settings.gap ?? FORCE_GAP;
  const margin = settings.margin ?? FORCE_MARGIN;

  // Who rides on whom, and at what offset. A holder that is itself carried, or one nobody
  // sent, cannot hold anything — the rider falls back into the field, the same rule
  // `overviewPositions` follows for a holder the node cap cut away.
  const riders = new Map<string, { holder: string; dx: number; dy: number; radius: number }>();
  const field: ForceNode[] = [];
  for (const node of nodes) {
    const holderId = node.holder ?? null;
    const holder = holderId === null || holderId === node.id ? undefined : byId.get(holderId);
    if (holder === undefined || (holder.holder ?? null) !== null) {
      field.push(node);
      continue;
    }
    riders.set(node.id, {
      holder: holder.id,
      dx: node.at.x - holder.at.x,
      dy: node.at.y - holder.at.y,
      radius: node.radius,
    });
  }

  const count = field.length;
  if (count === 0) {
    for (const node of nodes) positions.set(node.id, { x: node.at.x, y: node.at.y });
    return positions;
  }

  const index = new Map(field.map((node, at) => [node.id, at]));
  const x = field.map((node) => node.at.x);
  const y = field.map((node) => node.at.y);
  const pinned = field.map((node) => node.pinned === true);
  // A holder is as big as the cluster it carries: everything else is kept clear of the whole
  // ring rather than of the disc in the middle of it.
  const radius = field.map((node) => node.radius);
  for (const rider of riders.values()) {
    const at = index.get(rider.holder);
    if (at === undefined) continue;
    radius[at] = Math.max(radius[at] ?? 0, Math.hypot(rider.dx, rider.dy) + rider.radius);
  }

  const springs: (readonly [number, number])[] = [];
  for (const edge of edges) {
    const from = index.get(riders.get(edge.source)?.holder ?? edge.source);
    const to = index.get(riders.get(edge.target)?.holder ?? edge.target);
    if (from === undefined || to === undefined || from === to) continue;
    springs.push([from, to]);
  }

  const centreX = box.width / 2;
  const centreY = box.height / 2;
  const widest = Math.max(0, ...radius);
  // The distance a spring wants between its ends: the room one node has in the box, floored so
  // that two of the biggest clusters pulled together still cannot be asked to overlap.
  const rest = Math.max(
    Math.sqrt((box.width * box.height) / count) * (settings.spread ?? FORCE_SPREAD),
    widest * 2 + gap,
  );
  // Fewer passes over a big library: the repulsion is every pair against every other, so the
  // work is quadratic and a map of three hundred files is redrawn whenever the library changes.
  const iterations = settings.iterations ?? (count > 180 ? 120 : 220);
  const gravity = settings.gravity ?? FORCE_GRAVITY;
  const hottest = Math.min(box.width, box.height) / 8;
  const push = new Float64Array(count);
  const pull = new Float64Array(count);
  /**
   * Whether anything is nailed down, which decides how the picture is kept inside the box.
   *
   * Either way the forces themselves run in a plane with no walls. What differs is how the
   * result is brought back into the box: with nothing pinned it is *fitted* — moved to the
   * middle and, only if it has to be, made smaller, one translation and one scale over
   * everything at once, so the relations the forces found survive exactly. With something
   * pinned there is nothing to fit around: a pinned node is a fixed point, and scaling the
   * picture round it would move everything else relative to the one thing that was meant to
   * stay. Those runs are clamped instead, which is a compromise and is why they are also the
   * runs that carry a seed already inside the box.
   */
  const anchored = pinned.includes(true);

  for (let pass = 0; pass < iterations; pass += 1) {
    // Linear cooling: early passes move nodes across the map, late ones only settle them.
    const share = 1 - pass / iterations;
    const temperature = hottest * share;
    push.fill(0);
    pull.fill(0);

    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let ax = (x[i] ?? 0) - (x[j] ?? 0);
        let ay = (y[i] ?? 0) - (y[j] ?? 0);
        let apart = Math.hypot(ax, ay);
        if (apart < 1e-6) {
          // Two nodes seeded at the same point have no direction to separate along. The golden
          // angle of their own indices is one, and it is the same one on every run.
          const angle = (i + j + 1) * GOLDEN_ANGLE;
          ax = Math.cos(angle);
          ay = Math.sin(angle);
          apart = 1;
        }
        const force = (rest * rest) / apart / apart;
        push[i] = (push[i] ?? 0) + ax * force;
        pull[i] = (pull[i] ?? 0) + ay * force;
        push[j] = (push[j] ?? 0) - ax * force;
        pull[j] = (pull[j] ?? 0) - ay * force;
      }
    }

    for (const [from, to] of springs) {
      const ax = (x[from] ?? 0) - (x[to] ?? 0);
      const ay = (y[from] ?? 0) - (y[to] ?? 0);
      const apart = Math.max(Math.hypot(ax, ay), 1e-6);
      // A spring with a rest length, not the textbook `d²/k` attraction. That one has no
      // length it is happy at — a node whose repulsion happens to balance elsewhere is drawn
      // onto its neighbour until the two discs touch — and a map where every link is drawn as
      // "these two are the same place" says less about the library than one where a link is a
      // distance. Slack below the rest length, pulling only above it.
      const force = Math.max(0, apart - rest) / apart;
      push[from] = (push[from] ?? 0) - ax * force;
      pull[from] = (pull[from] ?? 0) - ay * force;
      push[to] = (push[to] ?? 0) + ax * force;
      pull[to] = (pull[to] ?? 0) + ay * force;
    }

    for (let i = 0; i < count; i += 1) {
      if (pinned[i] === true) continue;
      const dx = push[i] ?? 0;
      const dy = pull[i] ?? 0;
      const length = Math.hypot(dx, dy);
      let nx = x[i] ?? 0;
      let ny = y[i] ?? 0;
      if (length > 1e-9) {
        const step = Math.min(length, temperature);
        nx += (dx / length) * step;
        ny += (dy / length) * step;
      }
      // Gravity, cooling with everything else: without it a component nothing links drifts to
      // the wall and stays there, and with it undimmed it would collapse the map onto its own
      // middle once the temperature had gone.
      nx += (centreX - nx) * gravity * share;
      ny += (centreY - ny) * gravity * share;
      x[i] = nx;
      y[i] = ny;
    }
  }

  // Into the box, once, now the forces have finished. Never *during* them: a wall stops one
  // node and lets its neighbour carry on, so a crowded map grows a boundary layer of nodes
  // stacked against the frame — and that is a state the separation below cannot dig out of,
  // because the direction it needs to push in is the direction the wall is.
  if (anchored) {
    for (let i = 0; i < count; i += 1) {
      if (pinned[i] === true) continue;
      clampInto(x, y, i, radius[i] ?? 0, box, margin);
    }
  } else {
    frameInto(x, y, radius, box, margin);
  }

  /**
   * Move one node along a direction, and answer how far it actually got.
   *
   * The answer is the whole point: a node already against the wall cannot take its half of a
   * separation, and half a separation leaves the pair overlapping for ever. What it could not
   * take is handed to the other one below.
   */
  const shove = (at: number, ux: number, uy: number, want: number): number => {
    const fromX = x[at] ?? 0;
    const fromY = y[at] ?? 0;
    x[at] = fromX + ux * want;
    y[at] = fromY + uy * want;
    clampInto(x, y, at, radius[at] ?? 0, box, margin);
    return Math.hypot((x[at] ?? 0) - fromX, (y[at] ?? 0) - fromY);
  };

  for (let pass = 0; pass < SEPARATION_PASSES; pass += 1) {
    let moved = false;
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const want = (radius[i] ?? 0) + (radius[j] ?? 0) + gap;
        let ax = (x[i] ?? 0) - (x[j] ?? 0);
        let ay = (y[i] ?? 0) - (y[j] ?? 0);
        // Two comparisons before the square root. Almost every pair on a map of three hundred
        // is nowhere near touching, and this phase looks at every pair several hundred times.
        if (ax > want || ax < -want || ay > want || ay < -want) continue;
        let apart = Math.hypot(ax, ay);
        // A hair of slack, so a pair separated to exactly the distance it wanted is not
        // reported as still moving on every pass for ever after by floating-point alone.
        if (apart >= want - SETTLED) continue;
        if (apart < 1e-6) {
          const angle = (i + j + 1) * GOLDEN_ANGLE;
          ax = Math.cos(angle);
          ay = Math.sin(angle);
          apart = 1;
        }
        // A pinned node does not give way, so the free one carries the whole separation.
        const iFree = pinned[i] !== true;
        const jFree = pinned[j] !== true;
        if (!iFree && !jFree) continue;
        const room = want - apart;
        const ux = ax / apart;
        const uy = ay / apart;
        if (!iFree) shove(j, -ux, -uy, room);
        else if (!jFree) shove(i, ux, uy, room);
        else shove(j, -ux, -uy, room - shove(i, ux, uy, room / 2));
        moved = true;
      }
    }
    if (!moved) break;
  }

  for (const [at, node] of field.entries()) {
    positions.set(node.id, { x: x[at] ?? node.at.x, y: y[at] ?? node.at.y });
  }
  for (const [id, rider] of riders) {
    const holder = positions.get(rider.holder);
    if (holder === undefined) continue;
    positions.set(id, { x: holder.x + rider.dx, y: holder.y + rider.dy });
  }
  return positions;
}

/**
 * Move a finished arrangement into the box: to the middle, and smaller only if it must be.
 *
 * The forces run without walls, so what comes out of them is a shape rather than a picture in
 * a frame. This is the framing, and it is one translation and one scale over every node at
 * once — so the *relations* the forces found survive it exactly, which a wall does not: a wall
 * stops one node and lets its neighbour carry on, and the map's shape is quietly rewritten
 * wherever it touched.
 *
 * It never enlarges. A library of four files spread across a plane is not evidence that it
 * should fill the page, and blowing it up would make the same four files look like a different
 * corpus every time one was added.
 */
function frameInto(
  x: number[],
  y: number[],
  radius: readonly number[],
  box: LayoutBox,
  margin: number,
): void {
  const count = x.length;
  if (count === 0) return;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let room = 0;
  for (let i = 0; i < count; i += 1) {
    minX = Math.min(minX, x[i] ?? 0);
    maxX = Math.max(maxX, x[i] ?? 0);
    minY = Math.min(minY, y[i] ?? 0);
    maxY = Math.max(maxY, y[i] ?? 0);
    room = Math.max(room, (radius[i] ?? 0) + margin);
  }
  // The room every disc needs comes off the box *before* the scale is chosen, and does not
  // scale with it. Taking it inside the span instead — fitting "positions plus rims" into the
  // box — quietly overflows whenever the scale is under one, because the rims stay the size
  // they were while the positions shrink away from them. A hub landed fourteen units past the
  // bottom of the scene that way, drawn half off its own panel and unclickable.
  const inside = (span: number, limit: number): number =>
    Math.min(1, Math.max(limit - room * 2, 1) / Math.max(span, 1e-6));
  const scale = Math.min(inside(maxX - minX, box.width), inside(maxY - minY, box.height));
  const fromX = (minX + maxX) / 2;
  const fromY = (minY + maxY) / 2;
  const toX = box.width / 2;
  const toY = box.height / 2;
  for (let i = 0; i < count; i += 1) {
    x[i] = toX + ((x[i] ?? 0) - fromX) * scale;
    y[i] = toY + ((y[i] ?? 0) - fromY) * scale;
    clampInto(x, y, i, radius[i] ?? 0, box, margin);
  }
}

/**
 * Keep a node's whole disc inside the box.
 *
 * On the centre rather than on the drawn edge, and with the room checked before it is used: a
 * cluster wider than the box has no position that satisfies both walls, and the middle is the
 * honest answer rather than whichever wall the arithmetic reached first.
 */
function clampInto(
  x: number[],
  y: number[],
  at: number,
  radius: number,
  box: LayoutBox,
  margin: number,
): void {
  const insetX = radius + margin;
  const insetY = radius + margin;
  x[at] =
    insetX * 2 >= box.width
      ? box.width / 2
      : Math.min(Math.max(x[at] ?? 0, insetX), box.width - insetX);
  y[at] =
    insetY * 2 >= box.height
      ? box.height / 2
      : Math.min(Math.max(y[at] ?? 0, insetY), box.height - insetY);
}
