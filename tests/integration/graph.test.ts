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
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPC_CHANNELS, type IpcChannel } from '@wr/shared-types';
import { fixtureFetch } from '../../packages/zotero-adapter/test/fake-api.js';
import { IntegrationWorkspace } from './support/workspace.js';

class Workspace extends IntegrationWorkspace {
  constructor() {
    // `G03`'s whole point is what the *next import* does to a name, so the recorded
    // Zotero fixtures have to be reachable from here.
    super('wr-graph-', () => ({ zoteroFetch: fixtureFetch() }));
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
    // `graph:overview` is the one channel that is not seeded (`F01`), so it is the one this
    // rule most has to reach: it stays on the list because its bound is required rather than
    // defaulted, which is what keeps "the whole graph" a request that names its own ceiling.
    for (const channel of [
      'graph:neighbourhood',
      'graph:overview',
      'graph:focus',
      'link:findReferences',
      'link:findByType',
    ]) {
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
    // The wiki page's cap is the contract's too, and it has no default to fall back to: a
    // caller that forgot to say how much of the library it would take is refused.
    expect(IPC_CHANNELS['graph:overview'].request.safeParse({ nodeLimit: 1_000_000 }).success).toBe(
      false,
    );
    expect(IPC_CHANNELS['graph:overview'].request.safeParse({ nodeLimit: 50 }).success).toBe(true);
    expect(
      IPC_CHANNELS['graph:focus'].request.safeParse({ documentId: 'doc_x', annotationLimit: 5_000 })
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

  it('[G06] answers with a highlight’s document as the node it is drawn inside', async () => {
    const { documentId, annotationId } = await seedAnnotatedNote();

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });

    const highlight = graph.nodes.find((node) => node.entityId === annotationId);
    expect(highlight?.parent).toEqual({ entityType: 'document', entityId: documentId });
    // The container is not its own child, which would be a box drawn round a box.
    expect(graph.nodes.find((node) => node.entityId === documentId)?.parent).toBeNull();
    // Containment does not replace the edge: the link the highlight belongs by is still sent,
    // so the view draws a line into the group as well as the group.
    expect(
      graph.edges.some(
        (edge) => edge.sourceId === annotationId && edge.targetId === documentId,
      ),
    ).toBe(true);
  });

  it('[G06] claims no container the view was not sent', async () => {
    const { documentId, annotationId, noteId } = await seedAnnotatedNote();

    // Seeded on the note, one hop: the highlight is here and the paper it belongs to is two
    // hops out, so it was withheld. A parent named anyway is a box the view cannot draw.
    const near = await workspace.call('graph:neighbourhood', {
      seedType: 'note',
      seedId: noteId,
      depth: 1,
    });
    expect(near.nodes.map((node) => node.entityId)).toEqual([noteId, annotationId]);
    expect(near.nodes.find((node) => node.entityId === annotationId)?.parent).toBeNull();

    // One hop further and the paper arrives — the same highlight is inside it now.
    const wider = await workspace.call('graph:neighbourhood', {
      seedType: 'note',
      seedId: noteId,
      depth: 2,
    });
    expect(wider.nodes.find((node) => node.entityId === annotationId)?.parent).toEqual({
      entityType: 'document',
      entityId: documentId,
    });
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

  it('[W10] keeps every graph surface on its own channel and off the link tables', async () => {
    // The same guarantee, extended to the two surfaces milestone 5 adds. Each one has exactly
    // one way to ask about the graph, and it is the bounded channel written for it — a panel
    // that reached the link tables directly would be the largest hole in the bound the main
    // process applies, precisely because these two are the widest views in the app.
    const surfaces = [
      { file: 'wiki-panel.tsx', channel: 'graph:overview' },
      { file: 'focus-panel.tsx', channel: 'graph:focus' },
    ];
    for (const surface of surfaces) {
      const source = await readFile(
        fileURLToPath(
          new URL(`../../apps/desktop/src/renderer/${surface.file}`, import.meta.url),
        ),
        'utf8',
      );
      expect(source, `${surface.file} never asks ${surface.channel}`).toContain(
        `call('${surface.channel}'`,
      );
      for (const forbidden of ['link:findByType', 'link:findReferences', 'link:peek']) {
        expect(source, `${surface.file} calls ${forbidden}`).not.toContain(`call('${forbidden}'`);
      }
    }
  });
});

/**
 * The wiki page and the focused view (`F01`, `F02`, `F03`), at the boundary they talk to.
 *
 * Both are proved end to end through the real surfaces. What is asserted here is what a
 * rendered view cannot show: that the whole-corpus answer is capped and says so, and that the
 * focused answer's two halves are budgeted separately, which is the property that stops one
 * from starving the other on a paper that is lopsided.
 */
describe('the wiki page and the focused view', () => {
  it('[F01] answers with the whole library, ranked, capped, and honest about the rest', async () => {
    const ids = await seedChain();
    // A file nobody has linked yet. It belongs on the map: a wiki that showed only what was
    // already connected would hide exactly the work still to do.
    const lonely = seedDocument('Ionian cadences');

    const all = await workspace.call('graph:overview', { nodeLimit: 300 });
    expect(all.nodes.map((node) => node.entityId)).toContain(lonely);
    expect(all.totalNodes).toBe(7);
    expect(all.truncated).toBe(false);
    expect(all.elidedNodes).toBe(0);
    // The edges are the ones that join two nodes on the map, in both components.
    expect(all.edges).toHaveLength(4);
    for (const edge of all.edges) {
      const drawn = new Set(all.nodes.map((node) => node.entityId));
      expect(drawn.has(edge.sourceId) && drawn.has(edge.targetId)).toBe(true);
    }

    // Capped, the busiest files survive: `b` and `c` have two edges each, `a` and `d` one,
    // and the file nobody linked has none — so rank is by degree and not by id or by title.
    const capped = await workspace.call('graph:overview', { nodeLimit: 2 });
    // Tied on degree, they fall back to the title: "Desirable difficulty" before
    // "Forgetting curve", which is a stable order and not the order the rows were written in.
    expect(capped.nodes.map((node) => node.entityId)).toEqual([ids.c, ids.b]);
    expect(capped.nodes.map((node) => node.degree)).toEqual([2, 2]);
    expect(capped.truncated).toBe(true);
    expect(capped.elidedNodes).toBe(5);
    // And no half-edge: the chain's links to `a` and `d` are not drawn to nodes nobody was sent.
    expect(capped.edges).toHaveLength(1);
  });

  it('[F01] leaves highlights to the focused view, and never draws an edge it invented', async () => {
    const { documentId, annotationId, noteId } = await seedAnnotatedNote();

    const map = await workspace.call('graph:overview', { nodeLimit: 300 });
    const drawn = map.nodes.map((node) => node.entityId);
    // The paper and the note are places on the map; the highlight between them is not.
    expect(drawn).toContain(documentId);
    expect(drawn).toContain(noteId);
    expect(drawn).not.toContain(annotationId);
    // …and the note's path to the paper runs through that highlight, so there is no line
    // between them here. Redrawing it would be the view inventing a row nobody wrote.
    expect(map.edges).toHaveLength(0);
  });

  it('[F02] budgets the highlights and the connected files apart from each other', async () => {
    const paper = seedDocument('Spaced repetition');
    const other = seedDocument('Forgetting curve');
    await link(paper, other);

    // Twelve highlights on the paper. Under one shared node cap these would sort ahead of the
    // connected file and take the whole answer — which is the half of the criterion that would
    // then be missing from the screen.
    for (let index = 0; index < 12; index += 1) {
      await workspace.call('annotation:create', {
        documentId: paper,
        kind: 'highlight',
        color: 'default',
        selectedText: `Marked sentence ${String(index)}`,
        anchor: {
          kind: 'markdown',
          version: 1,
          quote: { exact: `Marked sentence ${String(index)}`, prefix: '', suffix: '' },
          position: { start: index * 40, end: index * 40 + 20 },
          documentTextHash: 'text-hash',
          sourceHash: 'source-hash',
          normalizationVersion: 1,
        },
      });
    }

    const focused = await workspace.call('graph:focus', {
      documentId: paper,
      annotationLimit: 4,
      neighbourLimit: 4,
    });

    expect(focused.focus.documentId).toBe(paper);
    // Four of twelve highlights, and the file at the edge is still there.
    expect(focused.annotations).toHaveLength(4);
    expect(focused.elidedAnnotations).toBe(8);
    expect(focused.neighbours.map((neighbour) => neighbour.documentId)).toEqual([other]);
    expect(focused.elidedNeighbours).toBe(0);
    // The highlights carry their own words, so the middle of the view reads rather than counts.
    expect(focused.annotations[0]?.excerpt).toContain('Marked sentence 0');
  });

  it('[F03] reaches a file through a highlight, and says the connection is not a direct one', async () => {
    const here = seedDocument('Spaced repetition');
    const there = seedDocument('Forgetting curve');
    const anchor = (exact: string): Record<string, unknown> => ({
      kind: 'markdown',
      version: 1,
      quote: { exact, prefix: '', suffix: '' },
      position: { start: 0, end: exact.length },
      documentTextHash: 'text-hash',
      sourceHash: 'source-hash',
      normalizationVersion: 1,
    });
    const mark = async (documentId: string, exact: string): Promise<string> => {
      const { annotation } = await workspace.call('annotation:create', {
        documentId,
        kind: 'highlight',
        color: 'default',
        selectedText: exact,
        anchor: anchor(exact) as never,
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
      return annotation.id;
    };

    const claim = await mark(here, 'Recall is strongest when review is spread out');
    const evidence = await mark(there, 'Retention decays roughly exponentially');
    // The two papers are joined by nothing but the sentence in one answering the sentence in
    // the other — the shape a library actually grows into.
    await workspace.call('link:create', {
      type: 'supports',
      sourceType: 'annotation',
      sourceId: claim,
      targetType: 'annotation',
      targetId: evidence,
      origin: 'manual',
    });

    const from = await workspace.call('graph:focus', { documentId: here });
    expect(from.neighbours.map((neighbour) => neighbour.documentId)).toEqual([there]);
    expect(from.neighbours[0]?.throughAnnotation).toBe(true);

    // Crawling is the same question asked of the file at the edge, and it leads back: the
    // view is a way around the library rather than a one-way step off it.
    const onward = await workspace.call('graph:focus', { documentId: there });
    expect(onward.focus.documentId).toBe(there);
    expect(onward.neighbours.map((neighbour) => neighbour.documentId)).toEqual([here]);
    expect(onward.annotations.map((annotation) => annotation.entityId)).toEqual([evidence]);
    // A file's own highlights are never also files at its edge.
    expect(onward.neighbours.map((neighbour) => neighbour.documentId)).not.toContain(there);
  });

  it('[F02] refuses to draw a focused view of a file that is not there', async () => {
    // A well-formed id for a file that was never written: the contract lets it through, and
    // the handler is what has to notice.
    const missing = await workspace.attempt('graph:focus', {
      documentId: 'doc_00000000000000000000000000',
    });
    expect(missing.ok).toBe(false);
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND');
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

/**
 * The picture on a node (criterion G04), at the boundary the panel talks to.
 *
 * `G04` is proved end to end — a real image, a real drop, real bytes over `rrfile://`. What a
 * browser cannot show is what the channel *refuses*, and the refusals are the security half:
 * an icon is a file id the library already holds and never a path, and a file id that names a
 * paper rather than a picture would turn an `<image>` element into a way of asking for a
 * document's bytes.
 */
describe('a node’s picture', () => {
  /** A real 1×1 PNG on disk, added the way a dropped file is: where it lies. */
  async function addImage(name = 'diagram.png'): Promise<{ fileId: string; path: string }> {
    const path = join(workspace.dir, name);
    writeFileSync(
      path,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const { document } = await workspace.services.localFiles.add(path);
    const file = workspace.services.db.files.primaryForDocument(document.id);
    if (file === null) throw new Error('the image was added without a file row');
    // The row's own path: adding a file resolves it through symlinks first, and on macOS the
    // temporary directory is one (`/var` -> `/private/var`).
    return { fileId: file.id, path: file.path };
  }

  it('[G04] a node takes an icon from a local image, and still wears it after a restart', async () => {
    const documentId = seedDocument('Spaced repetition');
    const image = await addImage();

    const set = await workspace.call('graph:setNodeIcon', {
      entityType: 'document',
      entityId: documentId,
      fileId: image.fileId,
    });
    expect(set.iconFileId).toBe(image.fileId);

    workspace.restart();

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    const node = graph.nodes.find((entry) => entry.entityId === documentId);
    expect(node?.iconFileId).toBe(image.fileId);
    // A file id is all the renderer gets. Where those bytes are stays in the main process,
    // which is the whole reason the column holds an id rather than a path.
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain(workspace.dir);
    expect(serialized).not.toContain('diagram.png');
    // And the id resolves to the file on disk here, where it is allowed to.
    expect(workspace.services.db.files.getById(image.fileId)?.path).toBe(image.path);
  });

  it('[G04] takes the picture off again without disturbing the name', async () => {
    const documentId = seedDocument('Spaced repetition');
    const image = await addImage();

    await workspace.call('graph:setNodeName', {
      entityType: 'document',
      entityId: documentId,
      displayName: 'spacing',
    });
    await workspace.call('graph:setNodeIcon', {
      entityType: 'document',
      entityId: documentId,
      fileId: image.fileId,
    });

    const cleared = await workspace.call('graph:setNodeIcon', {
      entityType: 'document',
      entityId: documentId,
      fileId: null,
    });
    expect(cleared.iconFileId).toBeNull();

    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    const node = graph.nodes.find((entry) => entry.entityId === documentId);
    expect(node?.iconFileId).toBeNull();
    // The two are given up separately: clearing one must not clear the other.
    expect(node?.displayName).toBe('spacing');
  });

  it('[G04] refuses a file that is not an image, and one that is not in the library', async () => {
    const documentId = seedDocument('Spaced repetition');

    // A paper, not a picture. Serving it behind an `<image>` element is a way of asking for a
    // document's bytes that has nothing to do with illustrating anything.
    const paperPath = join(workspace.dir, 'paper.pdf');
    writeFileSync(paperPath, '%PDF-1.4\n%fixture\n');
    const { document: paper } = await workspace.services.localFiles.add(paperPath);
    const paperFile = workspace.services.db.files.primaryForDocument(paper.id);
    if (paperFile === null) throw new Error('the paper was added without a file row');

    const notAnImage = await workspace.attempt('graph:setNodeIcon', {
      entityType: 'document',
      entityId: documentId,
      fileId: paperFile.id,
    });
    expect(notAnImage.ok).toBe(false);
    expect(notAnImage.ok ? null : notAnImage.error.code).toBe('INVALID_REQUEST');

    const unknown = await workspace.attempt('graph:setNodeIcon', {
      entityType: 'document',
      entityId: documentId,
      fileId: 'dfl_00000000000000000000000000',
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? null : unknown.error.code).toBe('NOT_FOUND');

    // Neither refusal left anything behind: the node is still a plain disc.
    const graph = await workspace.call('graph:neighbourhood', {
      seedType: 'document',
      seedId: documentId,
      depth: 1,
    });
    expect(graph.nodes.find((entry) => entry.entityId === documentId)?.iconFileId).toBeNull();
  });

  it('[G04] takes no path on any channel, whatever the request says', async () => {
    const documentId = seedDocument('Spaced repetition');
    const image = await addImage();

    // The shape a compromised renderer would try: a path where the file id goes. It is
    // refused by the contract, before any handler sees it.
    for (const fileId of [image.path, `../${image.path}`, '/etc/hosts']) {
      const refused = await workspace.attempt('graph:setNodeIcon', {
        entityType: 'document',
        entityId: documentId,
        fileId,
      });
      expect(refused.ok, `${fileId} was accepted as a file id`).toBe(false);
      expect(refused.ok ? null : refused.error.code).toBe('INVALID_REQUEST');
    }

    // And no channel in the whole contract offers a path-shaped way in to an icon.
    expect(
      Object.keys(IPC_CHANNELS).filter((channel) => channel.startsWith('graph:')).sort(),
    ).toEqual([
      'graph:focus',
      'graph:getView',
      'graph:iconChoices',
      'graph:neighbourhood',
      'graph:overview',
      'graph:setNodeIcon',
      'graph:setNodeName',
      'graph:setViewSettings',
      'graph:setViewport',
    ]);
  });

  it('[G04] offers the library’s images to choose from, and nothing else', async () => {
    const image = await addImage('sketch.png');
    const paperPath = join(workspace.dir, 'not-a-picture.pdf');
    writeFileSync(paperPath, '%PDF-1.4\n%fixture\n');
    await workspace.services.localFiles.add(paperPath);

    const { choices } = await workspace.call('graph:iconChoices', {});
    expect(choices.map((choice) => choice.fileId)).toEqual([image.fileId]);
    expect(choices[0]?.title).toBe('sketch');
    // The picker is a list of pictures, not a list of paths.
    expect(JSON.stringify(choices)).not.toContain(workspace.dir);

    // A picture taken out of the library is no longer on offer.
    const document = workspace.services.db.files.getById(image.fileId)?.documentId;
    if (document === undefined) throw new Error('the image has no document');
    await workspace.call('library:removeDocument', { documentId: document });
    const after = await workspace.call('graph:iconChoices', {});
    expect(after.choices).toEqual([]);
  });
});
