import { describe, expect, it } from 'vitest';
import {
  boundedNeighbourhood,
  createGraph,
  focusPositions,
  groupBoxes,
  layoutPositions,
  overviewPositions,
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
