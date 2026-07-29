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
import { fixtureFetch } from '../../packages/zotero-adapter/test/fake-api.js';

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
      // `G03`'s whole point is what the *next import* does to a name, so the recorded Zotero
      // fixtures have to be reachable from here.
      zoteroFetch: fixtureFetch(),
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

/**
 * A note whose only path to a document runs through a highlight: `note -> annotation ->
 * document`. Deleting the highlight is then distinguishable from hiding it — the document
 * behind it has to go too, because nothing else reaches it.
 */
async function seedAnnotatedNote(): Promise<{
  documentId: string;
  annotationId: string;
  noteId: string;
}> {
  const documentId = seedDocument('Spaced repetition');
  const { annotation } = await workspace.call('annotation:create', {
    documentId,
    kind: 'highlight',
    color: 'default',
    selectedText: 'Recall is strongest when review is spread out',
    comment: 'the claim this note is about',
    anchor: {
      kind: 'markdown',
      version: 1,
      quote: {
        exact: 'Recall is strongest when review is spread out',
        prefix: '',
        suffix: ' rather than massed.',
      },
      position: { start: 0, end: 45 },
      documentTextHash: 'text-hash',
      sourceHash: 'source-hash',
      normalizationVersion: 1,
    },
  });
  const { note } = await workspace.call('note:create', {
    title: 'Why spacing works',
    contentJson: { type: 'doc', content: [] },
    contentText: 'The highlight is the evidence.',
    attachToAnnotationId: annotation.id,
  });
  await workspace.call('link:create', {
    type: 'annotation-belongs-to-document',
    sourceType: 'annotation',
    sourceId: annotation.id,
    targetType: 'document',
    targetId: documentId,
    origin: 'derived',
    generator: 'reader',
  });
  return { documentId, annotationId: annotation.id, noteId: note.id };
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

  it('[U08] drops a deleted highlight from the graph, and the edge that reached it', async () => {
    const { documentId, annotationId, noteId } = await seedAnnotatedNote();

    // Present first, or the assertion after the delete proves nothing.
    const before = await workspace.call('graph:neighbourhood', {
      seedType: 'note',
      seedId: noteId,
      depth: 2,
    });
    expect(before.nodes.map((node) => node.entityId)).toContain(annotationId);
    expect(before.edges.map((edge) => edge.targetId)).toContain(annotationId);

    const { deleted } = await workspace.call('annotation:delete', { annotationId });
    expect(deleted).toBe(true);
    // Soft deletion: the row and its edge are both still there, which is the whole trap.
    expect(workspace.services.db.annotations.get(annotationId)?.deletedAt).not.toBeNull();

    const after = await workspace.call('graph:neighbourhood', {
      seedType: 'note',
      seedId: noteId,
      depth: 2,
    });
    expect(after.nodes.map((node) => node.entityId)).not.toContain(annotationId);
    expect(after.edges.map((edge) => edge.targetId)).not.toContain(annotationId);
    // The document was reachable only *through* the highlight, so it goes with it rather than
    // staying behind as a node with no path back to the seed.
    expect(after.nodes.map((node) => node.entityId)).not.toContain(documentId);
    expect(after.nodes.map((node) => node.entityId)).toEqual([noteId]);
  });

  it('[U08] stops counting a deleted highlight in the degree the view shows', async () => {
    const { annotationId, noteId } = await seedAnnotatedNote();

    const before = await workspace.call('graph:neighbourhood', {
      seedType: 'note',
      seedId: noteId,
      depth: 1,
    });
    expect(before.nodes[0]?.degree).toBe(1);

    await workspace.call('annotation:delete', { annotationId });

    const after = await workspace.call('graph:neighbourhood', {
      seedType: 'note',
      seedId: noteId,
      depth: 1,
    });
    // Degree is what tells the view a node continues past the bound. Counting the deleted
    // edge would promise a neighbour that expanding can never produce.
    expect(after.nodes[0]?.degree).toBe(0);
  });

  it('[U08] drops a deleted note the same way, wherever the deletion happened', async () => {
    const { annotationId, noteId, documentId } = await seedAnnotatedNote();

    // Notes have no delete channel yet, so this one goes through the repository. The filter is
    // in the query either way, which is the point: it holds for every route to `deleted_at`.
    expect(workspace.services.db.notes.softDelete(noteId)).toBe(true);

    // Seeded from the other end this time: the surviving highlight must not keep the note,
    // and must keep the document it does still belong to.
    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'annotation',
      seedId: annotationId,
      depth: 2,
    });
    expect(graph.nodes.map((node) => node.entityId)).not.toContain(noteId);
    expect(graph.nodes.map((node) => node.entityId)).toEqual([annotationId, documentId]);
    expect(graph.edges).toHaveLength(1);
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

/**
 * The view state behind `G01` and `G02`, at the boundary the panel talks to.
 *
 * `G01` and `G02` are proved end to end, through the real gestures and a real restart. What
 * cannot be reached from there is what happens after the sixty-fifth graph someone has panned
 * — so the bound on the stored viewports is asserted here, where sixty-five seeds cost
 * nothing.
 */
describe('the graph view', () => {
  it('starts at the defaults, and gives them back after a value it cannot read', async () => {
    const fresh = await workspace.call('graph:getView', { seedType: 'document', seedId: 'nobody' });
    expect(fresh.settings).toEqual({ spacing: 1, showLabels: true, depth: 1 });
    expect(fresh.viewport).toBeNull();

    // A hand-edited settings row, of the kind nothing in the app writes.
    workspace.services.db.settings.set('graph.view.settings', { depth: 'as far as it goes' });
    const recovered = await workspace.call('graph:getView', { seedType: null, seedId: null });
    expect(recovered.settings).toEqual({ spacing: 1, showLabels: true, depth: 1 });
  });

  it('keeps a viewport per seed, so one graph does not move another', async () => {
    await workspace.call('graph:setViewport', {
      seedType: 'document',
      seedId: 'doc-one',
      viewport: { x: 40, y: -12.5, zoom: 1.75 },
    });
    await workspace.call('graph:setViewport', {
      seedType: 'document',
      seedId: 'doc-two',
      viewport: { x: -8, y: 3, zoom: 0.5 },
    });

    const one = await workspace.call('graph:getView', { seedType: 'document', seedId: 'doc-one' });
    expect(one.viewport).toEqual({ x: 40, y: -12.5, zoom: 1.75 });
    const two = await workspace.call('graph:getView', { seedType: 'document', seedId: 'doc-two' });
    expect(two.viewport).toEqual({ x: -8, y: 3, zoom: 0.5 });
    // The type is part of the key, not decoration: an annotation and a document may share an id.
    const other = await workspace.call('graph:getView', {
      seedType: 'annotation',
      seedId: 'doc-one',
    });
    expect(other.viewport).toBeNull();
  });

  it('forgets the least recently moved graph rather than growing without bound', async () => {
    // Sixty-five seeds panned in order. The first one is the one that has to go.
    for (let index = 0; index < 65; index += 1) {
      await workspace.call('graph:setViewport', {
        seedType: 'document',
        seedId: `doc-${String(index)}`,
        viewport: { x: index, y: 0, zoom: 1 },
      });
    }

    const evicted = await workspace.call('graph:getView', {
      seedType: 'document',
      seedId: 'doc-0',
    });
    expect(evicted.viewport).toBeNull();
    const kept = await workspace.call('graph:getView', { seedType: 'document', seedId: 'doc-1' });
    expect(kept.viewport).toEqual({ x: 1, y: 0, zoom: 1 });
    const newest = await workspace.call('graph:getView', {
      seedType: 'document',
      seedId: 'doc-64',
    });
    expect(newest.viewport).toEqual({ x: 64, y: 0, zoom: 1 });

    // Re-panning an old graph makes it recent again, so it outlives the next arrival.
    await workspace.call('graph:setViewport', {
      seedType: 'document',
      seedId: 'doc-1',
      viewport: { x: 99, y: 0, zoom: 1 },
    });
    await workspace.call('graph:setViewport', {
      seedType: 'document',
      seedId: 'doc-65',
      viewport: { x: 65, y: 0, zoom: 1 },
    });
    const refreshed = await workspace.call('graph:getView', {
      seedType: 'document',
      seedId: 'doc-1',
    });
    expect(refreshed.viewport).toEqual({ x: 99, y: 0, zoom: 1 });
    const dropped = await workspace.call('graph:getView', {
      seedType: 'document',
      seedId: 'doc-2',
    });
    expect(dropped.viewport).toBeNull();
  });

  it('[G03] a node takes a display name that does not rewrite the document’s title', async () => {
    // A real Zotero import, because the trap is what the *next* one does. The title under
    // test is the one the provider supplied, not one the test chose.
    await workspace.call('zotero:import', {});
    const imported = workspace.services.db.library.list({ limit: 1 }).items[0];
    if (imported === undefined) throw new Error('the fixtures imported nothing to rename');
    const documentId = imported.document.id;
    const zoteroTitle = imported.document.title;
    expect(zoteroTitle.length).toBeGreaterThan(0);

    await workspace.call('graph:setNodeName', {
      entityType: 'document',
      entityId: documentId,
      displayName: 'RLHF ⟶ sycophancy',
    });

    // The graph says the new name, and still says what the thing is called.
    const named = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    const seedNode = named.nodes.find((node) => node.entityId === documentId);
    expect(seedNode?.displayName).toBe('RLHF ⟶ sycophancy');
    expect(seedNode?.title).toBe(zoteroTitle);

    // The document itself was not touched — not the title, and not the row's mtime either.
    const document = workspace.services.db.documents.getById(documentId);
    expect(document?.title).toBe(zoteroTitle);
    // Nor is the name reachable through the document read the rest of the app uses, which is
    // what a write-through implementation would have made true.
    expect(JSON.stringify(document)).not.toContain('RLHF');

    // The run that would have eaten a name written into the title: `force` re-reads every
    // item from Zotero and rewrites the fields it owns.
    await workspace.call('zotero:import', { force: true });

    const after = workspace.services.db.documents.getById(documentId);
    expect(after?.title).toBe(zoteroTitle);
    const survived = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    expect(
      survived.nodes.find((node) => node.entityId === documentId)?.displayName,
    ).toBe('RLHF ⟶ sycophancy');
  });

  it('[G03] names the node and not the document, whatever kind of node it is', async () => {
    // A highlight is as renameable as a paper, and there is no title field on it to write
    // through to — which is why the name is keyed by entity rather than by document.
    const { documentId, annotationId } = await seedAnnotatedNote();

    await workspace.call('graph:setNodeName', {
      entityType: 'annotation',
      entityId: annotationId,
      displayName: 'the claim',
    });

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    expect(graph.nodes.find((node) => node.entityId === annotationId)?.displayName).toBe(
      'the claim',
    );
    // The document shares nothing with it: the key is the pair, not the id.
    expect(graph.nodes.find((node) => node.entityId === documentId)?.displayName).toBeNull();
    expect(workspace.services.db.documents.getById(documentId)?.title).toBe('Spaced repetition');

    // Clearing gives the node back its own name rather than leaving it blank.
    await workspace.call('graph:setNodeName', {
      entityType: 'annotation',
      entityId: annotationId,
      displayName: null,
    });
    const cleared = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    const node = cleared.nodes.find((entry) => entry.entityId === annotationId);
    expect(node?.displayName).toBeNull();
    expect(node?.title.length).toBeGreaterThan(0);
  });

  it('[G03] keeps the graph panel off the channels that would write a title', async () => {
    // The architectural half: renaming a node has one route, and it is not `document:update`.
    const source = await readFile(
      fileURLToPath(new URL('../../apps/desktop/src/renderer/graph-panel.tsx', import.meta.url)),
      'utf8',
    );
    expect(source, 'nothing in the app can rename a node').toContain("call('graph:setNodeName'");
    for (const channel of ['document:update', 'library:getDocument']) {
      expect(source, `the graph panel calls ${channel}`).not.toContain(`call('${channel}'`);
    }
  });

  it('refuses a zoom the panel could not come back from', async () => {
    const result = await workspace.attempt('graph:setViewport', {
      seedType: 'document',
      seedId: 'doc-one',
      viewport: { x: 0, y: 0, zoom: 5000 },
    });
    expect(result.ok).toBe(false);
    // Refused at the boundary, so nothing was stored to come back to.
    const view = await workspace.call('graph:getView', { seedType: 'document', seedId: 'doc-one' });
    expect(view.viewport).toBeNull();
  });
});
