import { describe, expect, it } from 'vitest';
import {
  boundedNeighbourhood,
  contextFieldPositions,
  createGraph,
  focusPositions,
  forcePositions,
  groupBoxes,
  layoutPositions,
  overviewPositions,
  type ForceEdge,
  type ForceNode,
  type GraphPosition,
  type GroupBox,
} from '../src/index.js';

/** A chain a -> b -> c -> d, plus a hub of `spokes` neighbours hanging off `a`. */
function chain(spokes = 0): ReturnType<typeof createGraph> {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const edges = [
    { id: 'ab', source: 'a', target: 'b' },
    { id: 'bc', source: 'b', target: 'c' },
    { id: 'cd', source: 'c', target: 'd' },
  ];
  for (let index = 0; index < spokes; index += 1) {
    nodes.push({ id: `s${String(index)}` });
    edges.push({ id: `as${String(index)}`, source: 'a', target: `s${String(index)}` });
  }
  return createGraph(nodes, edges);
}

describe('the graph model', () => {
  it('keeps a depth-bounded neighbourhood and nothing beyond it', () => {
    const result = boundedNeighbourhood(chain(), { seedId: 'a', depth: 1, nodeLimit: 50 });

    expect(result.nodeIds).toEqual(['a', 'b']);
    expect(result.edgeIds).toEqual(['ab']);
    expect(result.elidedNodes).toBe(0);
  });

  it('follows edges in both directions, since a link is a fact about both endpoints', () => {
    const result = boundedNeighbourhood(chain(), { seedId: 'c', depth: 1, nodeLimit: 50 });
    expect(result.nodeIds).toEqual(['c', 'b', 'd']);
  });

  it('records the hop distance of every node it keeps', () => {
    const result = boundedNeighbourhood(chain(), { seedId: 'a', depth: 3, nodeLimit: 50 });
    expect([...result.distances.entries()]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ]);
  });

  it('caps the node count, keeps the nearest, and reports what it dropped', () => {
    const result = boundedNeighbourhood(chain(10), { seedId: 'a', depth: 2, nodeLimit: 4 });

    expect(result.nodeIds).toHaveLength(4);
    expect(result.nodeIds[0]).toBe('a');
    // 13 nodes lie within two hops of `a` (it, `b`, ten spokes, and `c` behind `b`).
    expect(result.elidedNodes).toBe(9);
    // Every kept edge joins two kept nodes: a half-edge would draw a line to nothing.
    const kept = new Set(result.nodeIds);
    const graph = chain(10);
    for (const id of result.edgeIds) {
      const edge = graph.getElementById(id);
      expect(kept.has(edge.source().id())).toBe(true);
      expect(kept.has(edge.target().id())).toBe(true);
    }
  });

  it('answers an unknown seed with an empty neighbourhood rather than throwing', () => {
    expect(boundedNeighbourhood(chain(), { seedId: 'nope', depth: 2, nodeLimit: 50 })).toEqual({
      nodeIds: [],
      edgeIds: [],
      distances: new Map(),
      elidedNodes: 0,
    });
  });

  it('lays every node out at a finite, distinct position inside the box', () => {
    const graph = createGraph(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        { id: 'ab', source: 'a', target: 'b' },
        { id: 'ac', source: 'a', target: 'c' },
      ],
    );
    const distances = new Map([
      ['a', 0],
      ['b', 1],
      ['c', 1],
    ]);

    const positions = layoutPositions(graph, { width: 600, height: 400 }, distances);

    expect(positions.size).toBe(3);
    for (const position of positions.values()) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
    expect(positions.get('a')).toEqual({ x: 300, y: 200 });
    expect(positions.get('b')).not.toEqual(positions.get('c'));
  });

  /** A paper with two highlights in it, a second paper, and the link between the papers. */
  function papers(): ReturnType<typeof createGraph> {
    return createGraph(
      [
        { id: 'doc a' },
        { id: 'ann 1', parent: 'doc a' },
        { id: 'ann 2', parent: 'doc a' },
        { id: 'doc b' },
        { id: 'ann 3', parent: 'doc b' },
      ],
      [
        { id: 'e1', source: 'ann 1', target: 'doc a' },
        { id: 'e2', source: 'ann 2', target: 'doc a' },
        { id: 'e3', source: 'doc a', target: 'doc b' },
        { id: 'e4', source: 'ann 3', target: 'doc b' },
      ],
    );
  }

  /** Hops from `doc a`, as the traversal would report them. */
  const distances = (): Map<string, number> =>
    new Map([
      ['doc a', 0],
      ['ann 1', 1],
      ['ann 2', 1],
      ['doc b', 1],
      // Deliberately the far ring: a highlight of the paper next door is two hops out, and
      // placing it by its hop count is exactly what containment replaces.
      ['ann 3', 2],
    ]);

  it('[G06] holds a highlight inside the paper it was made in', () => {
    const graph = papers();

    expect(graph.getElementById('doc a').isParent()).toBe(true);
    expect(graph.getElementById('ann 1').parent().id()).toBe('doc a');
    expect(graph.getElementById('doc b').children().map((node) => node.id())).toEqual(['ann 3']);
    // Containment is not an edge, and does not become one: the four links are still the graph.
    expect(graph.edges().length).toBe(4);
  });

  it('[G06] draws a contained node beside its container, not on its own ring', () => {
    const graph = papers();

    const positions = layoutPositions(graph, { width: 1000, height: 700 }, distances());
    const distance = (from: string, to: string): number => {
      const a = positions.get(from);
      const b = positions.get(to);
      if (a === undefined || b === undefined) throw new Error(`${from} or ${to} was not laid out`);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    // Every highlight is nearer the paper holding it than that paper is to the other paper.
    const papersApart = distance('doc a', 'doc b');
    expect(distance('ann 1', 'doc a')).toBeLessThan(papersApart);
    expect(distance('ann 2', 'doc a')).toBeLessThan(papersApart);
    // …including the one two hops from the seed. Its ring would have put it furthest out.
    expect(distance('ann 3', 'doc b')).toBeLessThan(distance('ann 3', 'doc a'));
    expect(positions.get('ann 1')).not.toEqual(positions.get('ann 2'));
  });

  it('[G06] boxes each container round where its contents actually ended up', () => {
    const graph = papers();

    const positions = layoutPositions(graph, { width: 1000, height: 700 }, distances());
    const boxes = groupBoxes(graph, positions);

    expect([...boxes.keys()].sort()).toEqual(['doc a', 'doc b']);
    const inside = (box: GroupBox, id: string): boolean => {
      const at = positions.get(id);
      if (at === undefined) return false;
      return (
        at.x >= box.x && at.x <= box.x + box.width && at.y >= box.y && at.y <= box.y + box.height
      );
    };
    const a = boxes.get('doc a');
    const b = boxes.get('doc b');
    if (a === undefined || b === undefined) throw new Error('a paper was not boxed');

    for (const id of ['doc a', 'ann 1', 'ann 2']) expect(inside(a, id)).toBe(true);
    for (const id of ['doc b', 'ann 3']) expect(inside(b, id)).toBe(true);
    // And the boxes are about their own contents: neither swallows the other's paper.
    expect(inside(a, 'doc b')).toBe(false);
    expect(inside(b, 'doc a')).toBe(false);
  });

  it('[G06] drops a container that was cut away by the bound rather than throwing', () => {
    // The paper is one hop past the node cap; its highlight came back without it. Cytoscape
    // throws on a parent that is not in the elements, so this is the boundary case a bounded
    // neighbourhood produces every time it cuts between a paper and its highlights.
    const graph = createGraph([{ id: 'ann 1', parent: 'doc a' }], []);

    expect(graph.nodes().length).toBe(1);
    expect(graph.getElementById('ann 1').isChild()).toBe(false);
    expect(groupBoxes(graph, layoutPositions(graph, { width: 600, height: 400 }, new Map()))).
      toEqual(new Map());
  });
});

const BOX = { width: 1000, height: 700 };

const away = (
  positions: ReadonlyMap<string, { x: number; y: number }>,
  id: string,
): number => {
  const at = positions.get(id);
  if (at === undefined) throw new Error(`${id} was not laid out`);
  return Math.hypot(at.x - BOX.width / 2, at.y - BOX.height / 2);
};

describe('[F01] the whole-corpus layout', () => {
  const order = Array.from({ length: 40 }, (_, index) => `document doc-${String(index)}`);

  it('puts the first-ranked node in the middle and spreads the rest outward', () => {
    const positions = overviewPositions(order, BOX);

    expect(positions.size).toBe(order.length);
    expect(positions.get(order[0] ?? '')).toEqual({ x: 500, y: 350 });
    // Rank decides how far out a node lands, so the busiest files are the ones nearest the
    // middle of the page rather than wherever a force layout settled them.
    expect(away(positions, 'document doc-1')).toBeLessThan(away(positions, 'document doc-39'));
  });

  it('keeps every node inside the drawing box, and no two on top of each other', () => {
    const positions = overviewPositions(order, BOX);

    const seen = new Set<string>();
    for (const [id, at] of positions) {
      expect(Number.isFinite(at.x), `${id} has a non-finite x`).toBe(true);
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.x).toBeLessThanOrEqual(BOX.width);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeLessThanOrEqual(BOX.height);
      const cell = `${String(Math.round(at.x))},${String(Math.round(at.y))}`;
      expect(seen.has(cell), `two nodes drawn at ${cell}`).toBe(false);
      seen.add(cell);
    }
  });

  it('draws the same library the same way every time it is opened', () => {
    expect(overviewPositions(order, BOX)).toEqual(overviewPositions(order, BOX));
    // …and a lone file is simply in the middle, not at a radius of NaN.
    expect(overviewPositions(['document only'], BOX).get('document only')).toEqual({
      x: 500,
      y: 350,
    });
    expect(overviewPositions([], BOX).size).toBe(0);
  });

  /**
   * A marked sentence is drawn at its paper, not at its own place in the ranking (`V01`).
   *
   * The spiral is a function of rank, so a highlight placed in it would land wherever its
   * degree put it — which for the one thing on the map that *belongs* to another thing is the
   * one arrangement that says something untrue.
   */
  it('[V01] places a held node beside what holds it, and off the spiral', () => {
    const held = ['document doc-a', 'document doc-b', 'annotation ann-1', 'annotation ann-2'];
    const holders = new Map([
      ['annotation ann-1', 'document doc-b'],
      ['annotation ann-2', 'document doc-b'],
    ]);
    const positions = overviewPositions(held, BOX, holders);

    expect(positions.size).toBe(4);
    const paper = positions.get('document doc-b');
    const other = positions.get('document doc-a');
    if (paper === undefined || other === undefined) throw new Error('the files were not laid out');
    for (const id of ['annotation ann-1', 'annotation ann-2']) {
      const at = positions.get(id);
      if (at === undefined) throw new Error(`${id} was not laid out`);
      const toItsPaper = Math.hypot(at.x - paper.x, at.y - paper.y);
      expect(toItsPaper).toBeGreaterThan(0);
      expect(toItsPaper).toBeLessThan(Math.hypot(at.x - other.x, at.y - other.y));
    }
    // Siblings share the ring rather than the same point.
    expect(positions.get('annotation ann-1')).not.toEqual(positions.get('annotation ann-2'));
    // And the files are laid out as though the highlights were not there at all: the spiral is
    // the ranking of the *library*, and a paper must not move because it was read closely.
    expect(positions.get('document doc-a')).toEqual(
      overviewPositions(['document doc-a', 'document doc-b'], BOX).get('document doc-a'),
    );
  });

  it('[V01] falls back to the spiral for a holder nobody was sent', () => {
    const positions = overviewPositions(
      ['document doc-a', 'annotation ann-1'],
      BOX,
      // The paper was cut away by the node cap, and a node cannot be drawn beside something
      // that is not on the map.
      new Map([['annotation ann-1', 'document doc-gone']]),
    );

    expect(positions.size).toBe(2);
    expect(positions.get('annotation ann-1')).toEqual(
      overviewPositions(['document doc-a', 'annotation ann-1'], BOX).get('annotation ann-1'),
    );
  });
});

describe('[F02] the focused layout', () => {
  const arrangement = {
    centreId: 'document doc-a',
    innerIds: ['annotation ann-1', 'annotation ann-2', 'annotation ann-3'],
    outerIds: ['document doc-b', 'document doc-c'],
  };

  it('holds the file in the middle, its highlights inside its connected files', () => {
    const positions = focusPositions(arrangement, BOX);

    expect(positions.get('document doc-a')).toEqual({ x: 500, y: 350 });
    // The whole claim of the criterion, as geometry: *every* highlight is nearer the centre
    // than *every* connected file, whatever the counts are on either side.
    const furthestHighlight = Math.max(...arrangement.innerIds.map((id) => away(positions, id)));
    const nearestFile = Math.min(...arrangement.outerIds.map((id) => away(positions, id)));
    expect(furthestHighlight).toBeLessThan(nearestFile);
  });

  it('keeps the two bands apart however lopsided the file is', () => {
    const lopsided = {
      centreId: 'document doc-a',
      innerIds: Array.from({ length: 60 }, (_, index) => `annotation ann-${String(index)}`),
      outerIds: ['document doc-b'],
    };
    const positions = focusPositions(lopsided, BOX);

    const furthestHighlight = Math.max(...lopsided.innerIds.map((id) => away(positions, id)));
    expect(furthestHighlight).toBeLessThan(away(positions, 'document doc-b'));
    // Sixty highlights are sixty distinct places, not sixty nodes stacked on one point.
    expect(new Set(lopsided.innerIds.map((id) => JSON.stringify(positions.get(id)))).size).toBe(60);
  });

  it('boxes the file with its own highlights and nothing else', () => {
    const graph = createGraph(
      [
        { id: arrangement.centreId },
        ...arrangement.innerIds.map((id) => ({ id, parent: arrangement.centreId })),
        ...arrangement.outerIds.map((id) => ({ id })),
      ],
      [],
    );
    const positions = focusPositions(arrangement, BOX);
    const box = groupBoxes(graph, positions).get(arrangement.centreId);
    if (box === undefined) throw new Error('the focused file was not boxed');

    const inside = (id: string): boolean => {
      const at = positions.get(id);
      if (at === undefined) return false;
      return (
        at.x >= box.x && at.x <= box.x + box.width && at.y >= box.y && at.y <= box.y + box.height
      );
    };
    for (const id of [arrangement.centreId, ...arrangement.innerIds]) expect(inside(id)).toBe(true);
    for (const id of arrangement.outerIds) expect(inside(id)).toBe(false);
  });

  it('lays out a file with nothing on it without falling over', () => {
    const alone = { centreId: 'document doc-a', innerIds: [], outerIds: [] };
    expect(focusPositions(alone, BOX)).toEqual(new Map([['document doc-a', { x: 500, y: 350 }]]));
  });
});

/**
 * The relaxation the wiki's arrangement now goes through (`F08`).
 *
 * The two halves of the criterion are asserted separately because they are two mechanisms: the
 * forces are what pull linked things together and push everything else apart, and the
 * separation phase after them is what makes "none overlap" a promise rather than a tendency of
 * a spring layout that happened to settle somewhere comfortable.
 */
describe('[F08] laying out by force', () => {
  /** A library of `count` files, seeded the way the wiki seeds it, with `edges` links in it. */
  function library(count: number, links: readonly (readonly [number, number])[]): {
    nodes: ForceNode[];
    edges: ForceEdge[];
  } {
    const order = Array.from({ length: count }, (_, index) => `document doc-${String(index)}`);
    const seeded = overviewPositions(order, BOX);
    return {
      nodes: order.map((id, rank) => ({
        id,
        radius: rank < 5 ? 14 : 9,
        at: seeded.get(id) ?? { x: 0, y: 0 },
      })),
      edges: links.map(([from, to]) => ({
        source: `document doc-${String(from)}`,
        target: `document doc-${String(to)}`,
      })),
    };
  }

  /** The smallest clearance between any two discs: negative means two of them overlap. */
  function tightest(nodes: readonly ForceNode[], positions: Map<string, GraphPosition>): number {
    let smallest = Number.POSITIVE_INFINITY;
    for (const [i, one] of nodes.entries()) {
      const here = positions.get(one.id);
      if (here === undefined) throw new Error(`${one.id} was not laid out`);
      for (const other of nodes.slice(i + 1)) {
        const there = positions.get(other.id);
        if (there === undefined) throw new Error(`${other.id} was not laid out`);
        smallest = Math.min(
          smallest,
          Math.hypot(here.x - there.x, here.y - there.y) - one.radius - other.radius,
        );
      }
    }
    return smallest;
  }

  it('leaves no two discs overlapping, at every size the wiki offers', () => {
    // The three the page's own control offers, and the pathological seed: forty nodes on a
    // spiral whose step is narrower than the discs standing on it, which is the arrangement
    // this replaces.
    for (const count of [1, 2, 7, 40, 60, 150, 300]) {
      const { nodes, edges } = library(
        count,
        Array.from({ length: count }, (_, index) => [index, (index * 7 + 3) % count] as const),
      );
      const positions = forcePositions(nodes, edges, BOX);
      expect(positions.size).toBe(count);
      expect(tightest(nodes, positions), `${String(count)} nodes overlap`).toBeGreaterThanOrEqual(
        0,
      );
      // The whole disc, not its centre. A node whose rim hangs over the edge of the scene is
      // drawn half off its own panel — and the point a hand aims at, between the disc and the
      // label under it, lands outside the canvas altogether.
      for (const node of nodes) {
        const at = positions.get(node.id);
        if (at === undefined) throw new Error(`${node.id} was not laid out`);
        expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true);
        expect(at.x - node.radius, `${node.id} hangs off the left`).toBeGreaterThanOrEqual(0);
        expect(at.x + node.radius, `${node.id} hangs off the right`).toBeLessThanOrEqual(
          BOX.width,
        );
        expect(at.y - node.radius, `${node.id} hangs off the top`).toBeGreaterThanOrEqual(0);
        expect(at.y + node.radius, `${node.id} hangs off the bottom`).toBeLessThanOrEqual(
          BOX.height,
        );
      }
    }
  });

  it('pulls what is linked together and pushes the rest apart', () => {
    const pairs = Array.from({ length: 15 }, (_, index) => [index * 2, index * 2 + 1] as const);
    const { nodes, edges } = library(30, pairs);
    const positions = forcePositions(nodes, edges, BOX);
    const apart = (a: string, b: string): number => {
      const here = positions.get(a);
      const there = positions.get(b);
      if (here === undefined || there === undefined) throw new Error('a node was not laid out');
      return Math.hypot(here.x - there.x, here.y - there.y);
    };

    // Every linked pair is nearer to each other than the average pair on the map is — which is
    // the whole of "a link is a force" and is false of a spiral of the ranking, where two
    // linked files land wherever their degrees happened to put them.
    let total = 0;
    let seen = 0;
    for (const [i, one] of nodes.entries()) {
      for (const other of nodes.slice(i + 1)) {
        total += apart(one.id, other.id);
        seen += 1;
      }
    }
    const typical = total / seen;
    for (const [from, to] of pairs) {
      expect(
        apart(`document doc-${String(from)}`, `document doc-${String(to)}`),
        `doc-${String(from)} and doc-${String(to)} are linked and were drawn apart`,
      ).toBeLessThan(typical);
    }
  });

  it('draws the same library the same way every time, having no randomness in it', () => {
    const { nodes, edges } = library(40, [
      [0, 1],
      [1, 2],
      [2, 30],
      [7, 19],
    ]);
    expect(forcePositions(nodes, edges, BOX)).toEqual(forcePositions(nodes, edges, BOX));
    expect(forcePositions([], [], BOX).size).toBe(0);
  });

  it('[V01] carries a held node with its holder rather than relaxing it away from it', () => {
    const order = ['document doc-a', 'document doc-b', 'annotation ann-1', 'annotation ann-2'];
    const holders = new Map([
      ['annotation ann-1', 'document doc-b'],
      ['annotation ann-2', 'document doc-b'],
    ]);
    const seeded = overviewPositions(order, BOX, holders);
    const nodes: ForceNode[] = order.map((id) => ({
      id,
      radius: id.startsWith('annotation') ? 6 : 9,
      at: seeded.get(id) ?? { x: 0, y: 0 },
      holder: holders.get(id) ?? null,
    }));
    const positions = forcePositions(nodes, [], BOX);

    const paper = positions.get('document doc-b');
    if (paper === undefined) throw new Error('the paper was not laid out');
    for (const id of ['annotation ann-1', 'annotation ann-2']) {
      const seededAt = seeded.get(id);
      const seededPaper = seeded.get('document doc-b');
      const at = positions.get(id);
      if (at === undefined || seededAt === undefined || seededPaper === undefined) {
        throw new Error(`${id} was not laid out`);
      }
      // Exactly the offset the seed gave it: the sentence moved because its paper moved, and
      // for no other reason.
      expect(at.x - paper.x).toBeCloseTo(seededAt.x - seededPaper.x, 6);
      expect(at.y - paper.y).toBeCloseTo(seededAt.y - seededPaper.y, 6);
    }
    expect(tightest(nodes, positions)).toBeGreaterThanOrEqual(0);
  });

  it('[F09] never moves a pinned node, and keeps the rest clear of it', () => {
    // The focused view's shape: the file, its highlights and the files it reaches are pinned
    // where `focusPositions` put them, and the rest of the library is laid out round them.
    const centreId = 'document focus';
    const innerIds = Array.from({ length: 8 }, (_, index) => `annotation a-${String(index)}`);
    const outerIds = Array.from({ length: 6 }, (_, index) => `document n-${String(index)}`);
    const focus = focusPositions({ centreId, innerIds, outerIds }, BOX);
    // As many as the focused view will ask for, so the assertion is about the density the
    // researcher can actually put on the screen rather than a comfortable one.
    const context = Array.from({ length: 150 }, (_, index) => `document c-${String(index)}`);
    const seeded = contextFieldPositions(context, BOX, 320);
    const nodes: ForceNode[] = [
      { id: centreId, radius: 18, at: focus.get(centreId) ?? { x: 0, y: 0 }, pinned: true },
      ...innerIds.map((id) => ({
        id,
        radius: 10,
        at: focus.get(id) ?? { x: 0, y: 0 },
        pinned: true,
      })),
      ...outerIds.map((id) => ({
        id,
        radius: 13,
        at: focus.get(id) ?? { x: 0, y: 0 },
        pinned: true,
      })),
      ...context.map((id) => ({ id, radius: 9, at: seeded.get(id) ?? { x: 0, y: 0 } })),
    ];
    const positions = forcePositions(nodes, [], BOX, { gravity: 0.02 });

    for (const node of nodes) {
      if (node.pinned !== true) continue;
      expect(positions.get(node.id)).toEqual(node.at);
    }
    expect(tightest(nodes, positions)).toBeGreaterThanOrEqual(0);
  });
});

describe('[F09] the field the rest of the library is laid out in', () => {
  const order = Array.from({ length: 60 }, (_, index) => `document c-${String(index)}`);

  it('starts outside the band the focused view has already spent', () => {
    const positions = contextFieldPositions(order, BOX, 240);
    expect(positions.size).toBe(order.length);
    for (const [id, at] of positions) {
      expect(away(positions, id), `${id} was laid out inside the focused band`).toBeGreaterThan(
        200,
      );
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.x).toBeLessThanOrEqual(BOX.width);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeLessThanOrEqual(BOX.height);
    }
  });

  it('uses the corners of the box rather than stacking a ring against the focus', () => {
    const positions = contextFieldPositions(order, BOX, 240);
    const xs = [...positions.values()].map((at) => at.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(BOX.width * 0.7);
  });

  it('[V01] keeps a held node beside its holder here too, and draws the same field twice', () => {
    const holders = new Map([['annotation ann-1', 'document c-3']]);
    const withHeld = contextFieldPositions([...order, 'annotation ann-1'], BOX, 240, holders);
    const paper = withHeld.get('document c-3');
    const held = withHeld.get('annotation ann-1');
    if (paper === undefined || held === undefined) throw new Error('the field left one out');
    expect(Math.hypot(held.x - paper.x, held.y - paper.y)).toBeLessThan(60);
    expect(contextFieldPositions(order, BOX, 240)).toEqual(contextFieldPositions(order, BOX, 240));
    expect(contextFieldPositions([], BOX, 240).size).toBe(0);
  });
});
