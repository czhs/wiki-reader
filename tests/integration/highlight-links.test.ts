/**
 * A highlight as one *end* of a link, not only as something links point at (criterion H02).
 *
 * Everything under here already existed: one `links` table of typed directed edges, twelve
 * linkable entity types, and an annotation that has carried its own id since milestone 1. What
 * did not exist was any way to say "this sentence bears on that paper" — the reader's gesture
 * hardcoded both endpoints as documents, and the workbench collapsed a selected highlight into
 * the paper holding it before the picker ever saw it. So these tests go through the real router
 * and the real repositories, and assert the two shapes the criterion names: a highlight to a
 * whole file, and a highlight to a highlight in another file.
 *
 * The third test is the trap. Every annotation is *born* with an edge to the document it was
 * made in — `annotation-belongs-to-document`, written by the annotations repository, marked
 * derived — and `LinksRepository.create` returns the existing row rather than erroring when a
 * link is made twice. Reusing that type for a manual assertion would therefore look like it
 * worked and be indistinguishable afterwards from the automatic edge, so the manual one has a
 * type of its own and the vocabulary refuses the other.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse } from '@wr/shared-types';
import { createMarkdownAnchor } from '@wr/document-model';
import { linkTypesFor } from '@wr/workbench';
import { createTestServices, type AppServices } from '../../apps/desktop/src/main/services.js';
import { createHandlers } from '../../apps/desktop/src/main/handlers.js';
import { dispatch } from '../../apps/desktop/src/main/router.js';
import { silentLogger } from '../../apps/desktop/src/main/logger.js';

let dir: string;
let databasePath: string;
let services: AppServices;

function open(): AppServices {
  return createTestServices({ databasePath, zoteroDataDir: join(dir, 'zotero') });
}

/** Send a request the way the renderer would: through the router and its zod validation. */
async function call<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  const result = await dispatch(createHandlers(services), channel, request, silentLogger);
  if (!result.ok) {
    throw new Error(`ipc ${channel} failed: ${result.error.code} ${result.error.message}`);
  }
  return result.value as IpcResponse<K>;
}

/** Close and reopen against the same file — an application restart. */
function restart(): void {
  services.close();
  services = open();
}

interface MarkedPaper {
  readonly documentId: string;
  readonly annotationId: string;
  readonly quote: string;
}

/** A paper with one sentence marked in it, made the way the reader makes one. */
function paperWithHighlight(title: string, quote: string): MarkedPaper {
  const { db } = services;
  const document = db.documents.create({ title, docType: 'pdf', source: 'zotero', authors: [] });
  const annotation = db.annotations.create({
    documentId: document.id,
    kind: 'highlight',
    color: 'default',
    selectedText: quote,
    // A real anchor, built the way the markdown reader builds one — text evidence and its
    // hashes, not a pair of offsets. Nothing here is about anchoring, but a highlight stored
    // without one is not the thing the rest of the app links to.
    anchor: createMarkdownAnchor({
      selection: {
        kind: 'markdown',
        text: quote,
        documentText: `${title}. ${quote}. And a sentence after it.`,
        position: { start: 0, end: quote.length },
      },
      sourceHash: `hash-${title}`,
    }),
  });
  return { documentId: document.id, annotationId: annotation.id, quote };
}

/** Every edge touching an entity, as the app reads them back. */
async function edgesOn(
  entityType: 'annotation' | 'document',
  entityId: string,
): Promise<{ type: string; direction: string; otherType: string; otherId: string; origin: string }[]> {
  const { links } = await call('link:findReferences', { entityType, entityId });
  return links.map((link) => ({
    type: link.type,
    direction: link.direction,
    otherType: link.otherType,
    otherId: link.direction === 'outgoing' ? link.targetId : link.sourceId,
    origin: link.origin,
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-highlight-links-'));
  databasePath = join(dir, 'wiki-reader.db');
  services = open();
});

afterEach(() => {
  services.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('links a highlight can hold', () => {
  it('[H02] links a highlight to a whole file, distinctly from the paper it lives in', async () => {
    const marked = paperWithHighlight('The residual stream', 'features are directions');
    const other = services.db.documents.create({
      title: 'Superposition',
      docType: 'pdf',
      source: 'zotero',
      authors: [],
    });

    // Before the assertion is made, the highlight already has exactly one edge — to its own
    // paper, written for it, marked derived. That edge is the reason this criterion needs a
    // second type rather than a second use of the first one.
    expect(await edgesOn('annotation', marked.annotationId)).toEqual([
      {
        type: 'annotation-belongs-to-document',
        direction: 'outgoing',
        otherType: 'document',
        otherId: marked.documentId,
        origin: 'derived',
      },
    ]);

    const { link } = await call('link:create', {
      type: 'annotation-references-document',
      sourceType: 'annotation',
      sourceId: marked.annotationId,
      targetType: 'document',
      targetId: other.id,
      origin: 'manual',
    });
    expect(link.sourceType).toBe('annotation');
    expect(link.targetType).toBe('document');

    restart();

    // Two edges now, and they are different facts: one containment the app wrote, one
    // assertion the researcher made, each with its own type and its own origin.
    expect(await edgesOn('annotation', marked.annotationId)).toEqual([
      {
        type: 'annotation-belongs-to-document',
        direction: 'outgoing',
        otherType: 'document',
        otherId: marked.documentId,
        origin: 'derived',
      },
      {
        type: 'annotation-references-document',
        direction: 'outgoing',
        otherType: 'document',
        otherId: other.id,
        origin: 'manual',
      },
    ]);

    // And it is findable from the other end: the paper knows the sentence that bears on it.
    expect(await edgesOn('document', other.id)).toEqual([
      {
        type: 'annotation-references-document',
        direction: 'incoming',
        otherType: 'annotation',
        otherId: marked.annotationId,
        origin: 'manual',
      },
    ]);
  });

  it('[H02] links a highlight to a highlight already made in another file', async () => {
    const here = paperWithHighlight('The residual stream', 'features are directions');
    const there = paperWithHighlight('Superposition', 'more features than dimensions');

    await call('link:create', {
      type: 'annotation-references-annotation',
      sourceType: 'annotation',
      sourceId: here.annotationId,
      targetType: 'annotation',
      targetId: there.annotationId,
      origin: 'manual',
    });

    restart();

    const outgoing = (await edgesOn('annotation', here.annotationId)).filter(
      (edge) => edge.otherType === 'annotation',
    );
    expect(outgoing).toEqual([
      {
        type: 'annotation-references-annotation',
        direction: 'outgoing',
        otherType: 'annotation',
        otherId: there.annotationId,
        origin: 'manual',
      },
    ]);

    // The two highlights are in two different papers, which is the half of the criterion that
    // an implementation linking a highlight to its neighbour would still satisfy.
    expect(here.documentId).not.toBe(there.documentId);
    const { annotation } = await call('annotation:get', {
      annotationId: there.annotationId as never,
    });
    expect(annotation.documentId).toBe(there.documentId);
    expect(annotation.selectedText).toBe(there.quote);
  });

  it('[H02] never offers the edge every highlight already has as a relationship to choose', () => {
    // `annotation-belongs-to-document` is the derived containment edge. If the picker offered
    // it, "link this highlight to that paper" would return the *existing* row whenever the
    // paper was the highlight's own — `LinksRepository.create` is idempotent on
    // (type, source, target) — and report success for a link it never made.
    expect(linkTypesFor('annotation', 'document')).not.toContain('annotation-belongs-to-document');
    expect(linkTypesFor('annotation', 'document')).toContain('annotation-references-document');
    expect(linkTypesFor('annotation', 'annotation')).toContain('annotation-references-annotation');

    // And the collision it protects against is real, not hypothetical.
    const marked = paperWithHighlight('The residual stream', 'features are directions');
    const born = services.db.links.findReferences({
      entityType: 'annotation',
      entityId: marked.annotationId,
    });
    const again = services.db.links.create({
      type: 'annotation-belongs-to-document',
      sourceType: 'annotation',
      sourceId: marked.annotationId,
      targetType: 'document',
      targetId: marked.documentId,
      origin: 'manual',
    });
    expect(again.id).toBe(born[0]?.id);
    expect(again.origin).toBe('derived');
  });

  /**
   * A ledger is a view of what this file says *now* (criterion H03).
   *
   * Deleting a highlight is a soft delete: the row and its links stay, so the removal can be
   * undone (`B03`). The ledger filtered that only at the near end — whether an endpoint was
   * inside *this* file — so a link made from a highlight in another paper survived that paper's
   * highlight being deleted, was described from a row nobody checked, and came back
   * `broken: false`. The panel then navigates a not-broken row, to a highlight that is gone.
   *
   * The focused view has always been right about this, which is the other half of the test: two
   * milestone-5 surfaces reading the same table have to say the same thing about it.
   */
  it('[H03] drops a deleted highlight\'s link from the ledger, as the focused view does', async () => {
    const paper = services.db.documents.create({
      title: 'Superposition',
      docType: 'pdf',
      source: 'zotero',
      authors: [],
    });
    const marked = paperWithHighlight('The residual stream', 'features are directions');
    await call('link:create', {
      type: 'annotation-references-document',
      sourceType: 'annotation',
      sourceId: marked.annotationId,
      targetType: 'document',
      targetId: paper.id,
      origin: 'manual',
    });

    const before = await call('link:findForDocument', { documentId: paper.id });
    expect(before.entries).toHaveLength(1);
    expect(before.entries[0]?.link.otherType).toBe('annotation');
    expect(before.entries[0]?.link.broken).toBe(false);
    const reachedBefore = await call('graph:focus', { documentId: paper.id });
    expect(reachedBefore.neighbours).toHaveLength(1);

    await call('annotation:delete', { annotationId: marked.annotationId });

    const after = await call('link:findForDocument', { documentId: paper.id });
    expect(after.entries).toHaveLength(0);
    // The two surfaces agree, which is the property that was actually broken.
    const reachedAfter = await call('graph:focus', { documentId: paper.id });
    expect(reachedAfter.neighbours).toHaveLength(0);

    // The other file's own ledger loses it too: the highlight is gone from both ends.
    const source = await call('link:findForDocument', { documentId: marked.documentId });
    expect(source.entries.map((entry) => entry.link.type)).not.toContain(
      'annotation-references-document',
    );
  });
});
