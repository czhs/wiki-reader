import { describe, expect, it } from 'vitest';
import { boundedNeighbourhood, createGraph, layoutPositions } from '../src/index.js';

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
});
