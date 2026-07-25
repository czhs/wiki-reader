/**
 * The graph query boundary (criterion W10).
 *
 * The point of this criterion is *where the traversal runs*, so these tests assert on what
 * crosses the IPC boundary rather than on what a view renders. Every request goes through the
 * real router — the same zod validation the renderer's request meets — into the real
 * `GraphRepository` over a real SQLite file. Each case seeds edges that must **not** come
 * back: a query that returned the whole graph would satisfy any purely positive assertion
 * about the nodes that should be there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPC_CHANNELS, type IpcChannel, type IpcRequest, type IpcResponse } from '@wr/shared-types';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';

class Workspace {
  readonly dir: string;
  readonly databasePath: string;
  readonly services: AppServices;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'wr-graph-'));
    this.databasePath = join(this.dir, 'wiki-reader.db');
    this.services = createTestServices({
      databasePath: this.databasePath,
      zoteroDataDir: join(this.dir, 'zotero'),
    });
  }

  /** Send a request the way the renderer would: through the router and its validation. */
  async call<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
    const result = await dispatch(createHandlers(this.services), channel, request, silentLogger);
    if (!result.ok) {
      throw new Error(`ipc ${channel} failed: ${result.error.code} ${result.error.message}`);
    }
    return result.value as IpcResponse<K>;
  }

  /** The raw envelope, for the cases where the rejection *is* the assertion. */
  async attempt(channel: string, request: unknown): Promise<ReturnType<typeof dispatch>> {
    return dispatch(createHandlers(this.services), channel, request, silentLogger);
  }

  dispose(): void {
    this.services.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(() => {
  workspace.dispose();
});

function seedDocument(title: string): string {
  return workspace.services.db.documents.create({
    title,
    docType: 'markdown',
    source: 'corpus',
    authors: [],
  }).id;
}

async function link(sourceId: string, targetId: string, type = 'mentions'): Promise<void> {
  await workspace.call('link:create', {
    type,
    sourceType: 'document',
    sourceId,
    targetType: 'document',
    targetId,
    origin: 'derived',
    generator: 'wikilinks',
  });
}

/**
 * A chain `a -> b -> c -> d`, plus `far -> away`, which touches nothing in the chain.
 *
 * The chain gives the depth bound something to cut; the second component gives the query
 * something it must never return no matter how the bound is set.
 */
async function seedChain(): Promise<Record<'a' | 'b' | 'c' | 'd' | 'far' | 'away', string>> {
  const ids = {
    a: seedDocument('Spaced repetition'),
    b: seedDocument('Forgetting curve'),
    c: seedDocument('Desirable difficulty'),
    d: seedDocument('Testing effect'),
    far: seedDocument('Ionian mode'),
    away: seedDocument('Dorian mode'),
  };
  await link(ids.a, ids.b);
  await link(ids.b, ids.c);
  await link(ids.c, ids.d);
  await link(ids.far, ids.away);
  return ids;
}

describe('graph queries', () => {
  it('[W10] returns the bounded neighbourhood of a seed, never the whole graph', async () => {
    const ids = await seedChain();

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: ids.a,
      depth: 1,
    });

    const returned = graph.nodes.map((node) => node.entityId);
    expect(returned).toEqual([ids.a, ids.b]);

    // The two hops past the bound, and the whole disconnected component, stayed in main.
    for (const absent of [ids.c, ids.d, ids.far, ids.away]) {
      expect(returned).not.toContain(absent);
    }
    // Six documents and four edges exist; the renderer was told about two and one.
    expect(workspace.services.db.documents.count()).toBe(6);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.sourceId).toBe(ids.a);
    expect(graph.edges[0]?.targetId).toBe(ids.b);
  });

  it('[W10] widens by exactly one hop per unit of depth', async () => {
    const ids = await seedChain();

    const two = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: ids.a,
      depth: 2,
    });

    expect(two.nodes.map((node) => node.entityId)).toEqual([ids.a, ids.b, ids.c]);
    expect(two.nodes.map((node) => node.distance)).toEqual([0, 1, 2]);
    expect(two.nodes.map((node) => node.entityId)).not.toContain(ids.d);
  });

  it('[W10] sends no edge whose other end was withheld', async () => {
    const ids = await seedChain();

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: ids.a,
      depth: 2,
    });

    // `c` is on the boundary: its edge to `d` exists in the database and must not be drawn,
    // or the view would show a line to a node the renderer knows nothing about.
    const known = new Set(graph.nodes.map((node) => node.entityId));
    for (const edge of graph.edges) {
      expect(known.has(edge.sourceId)).toBe(true);
      expect(known.has(edge.targetId)).toBe(true);
    }
    expect(graph.edges).toHaveLength(2);
  });

  it('[W10] caps the node count and reports what it elided rather than truncating silently', async () => {
    const hub = seedDocument('Spaced repetition');
    for (let index = 0; index < 12; index += 1) {
      await link(hub, seedDocument(`Neighbour ${String(index)}`));
    }

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: hub,
      depth: 1,
      nodeLimit: 5,
    });

    expect(graph.nodes).toHaveLength(5);
    expect(graph.nodes[0]?.entityId).toBe(hub);
    expect(graph.truncated).toBe(true);
    expect(graph.elidedNodes).toBe(8);

    // The seed's degree is the truth about the database, so the view can say that this node
    // continues past the edge of what was sent.
    expect(graph.nodes[0]?.degree).toBe(12);
    expect(graph.edges.length).toBeLessThan(12);
  });

  it('[W10] refuses a request that tries to widen the bound past the contract', async () => {
    const ids = await seedChain();

    const tooDeep = await workspace.attempt('graph:neighbourhood', {
      seedType: 'document',
      seedId: ids.a,
      depth: 25,
    });
    expect(tooDeep.ok).toBe(false);
    expect(tooDeep.ok ? null : tooDeep.error.code).toBe('INVALID_REQUEST');

    const tooWide = await workspace.attempt('graph:neighbourhood', {
      seedType: 'document',
      seedId: ids.a,
      nodeLimit: 100_000,
    });
    expect(tooWide.ok).toBe(false);
    expect(tooWide.ok ? null : tooWide.error.code).toBe('INVALID_REQUEST');
  });

  it('[W10] exposes no channel that asks for the graph without a scope and a bound', () => {
    // Every channel that can return edges. A request with nothing in it must fail: an
    // unscoped form is exactly what "load the whole graph into the renderer" would look like.
    for (const channel of ['graph:neighbourhood', 'link:findReferences', 'link:findByType']) {
      const contract = IPC_CHANNELS[channel as IpcChannel];
      expect(contract.request.safeParse({}).success, `${channel} accepts an empty request`).toBe(
        false,
      );
    }

    // And the bounds are in the contract, not in the caller: a renderer cannot raise them.
    expect(
      IPC_CHANNELS['link:findReferences'].request.safeParse({
        entityType: 'document',
        entityId: 'doc_x',
        limit: 1_000_000,
      }).success,
    ).toBe(false);
    expect(
      IPC_CHANNELS['link:findByType'].request.safeParse({ type: 'mentions', limit: 1_000_000 })
        .success,
    ).toBe(false);
  });

  it('[W10] resolves titles in main and lets no filesystem path reach the renderer', async () => {
    const ids = await seedChain();

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: ids.a,
      depth: 1,
    });

    expect(graph.seed.title).toBe('Spaced repetition');
    expect(graph.nodes.map((node) => node.title)).toEqual([
      'Spaced repetition',
      'Forgetting curve',
    ]);
    // Each node carries the document to open, so activating one needs no second round trip.
    expect(graph.nodes[1]?.documentId).toBe(ids.b);

    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain(workspace.dir);
    expect(serialized).not.toContain(tmpdir());
  });

  it('[W10] answers a seed with no edges with just that seed', async () => {
    const lonely = seedDocument('Unlinked note');

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: lonely,
      depth: 3,
    });

    expect(graph.nodes.map((node) => node.entityId)).toEqual([lonely]);
    expect(graph.edges).toEqual([]);
    expect(graph.truncated).toBe(false);
  });

  it('[W10] keeps the graph panel on the neighbourhood channel and off the link tables', async () => {
    // The architectural half of the criterion: the renderer's graph view has one way to ask
    // about the graph. Reaching for `link:findByType` here would pull an unbounded-by-seed
    // result set into the panel and quietly undo the bound the main process applies.
    const source = await readFile(
      fileURLToPath(new URL('../../apps/desktop/src/renderer/graph-panel.tsx', import.meta.url)),
      'utf8',
    );

    expect(source).toContain("call('graph:neighbourhood'");
    for (const channel of ['link:findByType', 'link:findReferences', 'link:peek']) {
      expect(source, `the graph panel calls ${channel}`).not.toContain(`call('${channel}'`);
    }
  });
});
