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

  /**
   * The ledger lists every highlight of the file, linked or not (criterion E03).
   *
   * The bug this pins down is one of derivation. A ledger built only from `links` groups the
   * edges it found by whichever end is inside the file, so a marked sentence with no edge
   * produces no group — and "Link this highlight…" existed exactly and only where linking had
   * already happened, on the page whose whole purpose is noticing what a paper *should* be
   * connected to. Six marked sentences and no edges read "nothing is linked to this file yet".
   *
   * So the highlights come from `annotations`, and the assertions below are about the two
   * halves that cannot both come from the same place: a highlight appears with zero links, and
   * the count beside a highlight that does have links agrees with the entries the same call
   * returned. Deleted highlights stay out, because a ledger is a view of what the file says now
   * — which is the `H03` rule directly above, and this must not quietly undo it.
   */
  it('[E03] lists every highlight of the file in the ledger, linked or not', async () => {
    const paper = services.db.documents.create({
      title: 'Spacing effects in deep networks',
      docType: 'pdf',
      source: 'zotero',
      authors: [],
    });
    // Three sentences of one page, marked out of order, so "in the order they are on the page"
    // is a claim with something to be wrong about — the ids are ULIDs and three annotations
    // created in the same millisecond have no creation order to fall back on.
    const QUOTES = [
      'Review spread across days beats review massed into one.',
      'The effect survives a ten-fold change in total study time.',
      'Nothing here has been said about anything yet.',
    ] as const;
    const PAGE = QUOTES.map((quote, index) => `Section ${String(index)}. ${quote}`).join('\n\n');
    const mark = (quote: string): string =>
      services.db.annotations.create({
        documentId: paper.id,
        kind: 'highlight',
        color: 'default',
        selectedText: quote,
        anchor: createMarkdownAnchor({
          selection: {
            kind: 'markdown',
            text: quote,
            documentText: PAGE,
            position: { start: PAGE.indexOf(quote), end: PAGE.indexOf(quote) + quote.length },
          },
          sourceHash: 'hash-spacing',
        }),
      }).id;

    const third = mark(QUOTES[2]);
    const first = mark(QUOTES[0]);
    const second = mark(QUOTES[1]);

    // Nothing has been linked. Every marked sentence is still on the page, each with a plain
    // zero — which is the whole criterion, and is false of a ledger built out of edges.
    const blank = await call('link:findForDocument', { documentId: paper.id });
    expect(blank.entries).toHaveLength(0);
    expect(blank.highlights.map((highlight) => highlight.annotationId)).toEqual([
      first,
      second,
      third,
    ]);
    expect(blank.highlights.map((highlight) => highlight.links)).toEqual([0, 0, 0]);
    // Down the page rather than in the order the pen touched them — the third was marked
    // first and is listed last — and readable as themselves rather than as ids.
    expect(blank.highlights[0]?.label).toBe(QUOTES[0]);
    expect(blank.highlights[2]?.label).toBe(QUOTES[2]);

    // Every highlight already carries the derived `annotation-belongs-to-document` edge to this
    // very paper. It is bookkeeping, not a connection, and the count says so — otherwise every
    // sentence would open at "1 link" and the number would mean nothing.
    const born = services.db.links.findReferences({ entityType: 'annotation', entityId: first });
    expect(born.map((link) => link.type)).toContain('annotation-belongs-to-document');

    // Now say something about one of them.
    const elsewhere = services.db.documents.create({
      title: 'Retrieval practice',
      docType: 'pdf',
      source: 'zotero',
      authors: [],
    });
    await call('link:create', {
      type: 'annotation-references-document',
      sourceType: 'annotation',
      sourceId: first,
      targetType: 'document',
      targetId: elsewhere.id,
      origin: 'manual',
    });

    restart();

    const after = await call('link:findForDocument', { documentId: paper.id });
    // The two halves agree: the count beside the highlight is the number of rows the ledger
    // would print under it. A count derived any other way is the one nobody believes.
    const entriesFor = (annotationId: string): number =>
      after.entries.filter((entry) => entry.near.entityId === annotationId).length;
    for (const highlight of after.highlights) {
      expect(highlight.links).toBe(entriesFor(highlight.annotationId));
    }
    expect(after.highlights.map((highlight) => highlight.links)).toEqual([1, 0, 0]);
    // And the two that nobody has said anything about are still there, which is the point.
    expect(after.highlights).toHaveLength(3);

    // A deleted highlight is not a highlight of this file (`H03`'s rule, kept).
    await call('annotation:delete', { annotationId: second as never });
    const trimmed = await call('link:findForDocument', { documentId: paper.id });
    expect(trimmed.highlights.map((highlight) => highlight.annotationId)).toEqual([first, third]);
  });
});

/**
 * What counts as a link, when it comes to taking one away (`H07`).
 *
 * `H07` is "a link is deleted wherever it is seen", and the sentence has a subject: a *link* is
 * something the researcher made. Every surface drew a × on every edge, which made two promises
 * the application could not keep.
 *
 * A `[[wikilink]]` between two papers is `origin: 'derived'` and is rewritten by
 * `replaceDerived` for every walked file at every launch — so a deleted one was back after a
 * restart, silently, and nothing on any surface said so before the press. In the demo corpus
 * every line between two papers is one of these.
 *
 * The edge every highlight is born with — `annotation-belongs-to-document`, also derived — is
 * the opposite failure: it is written once, when the highlight is made, and never again. So
 * deleting *that* one is permanent, and takes a marked sentence out of its own file's graph for
 * good. The wiki excludes it from what it draws and so does the ledger; the neighbourhood panel
 * did not, and offered a × on it indistinguishable from a researcher's link.
 *
 * One predicate answers both — `unlinkRefusal`, in `@wr/shared-types` so that the channel and
 * the four surfaces refuse on the same rule rather than on a guard and a guess about it.
 */
describe('an edge nobody made', () => {
  /** `link:delete` without the throwing wrapper: a refusal is the answer being asked about. */
  async function tryDelete(linkId: string): Promise<{ ok: boolean; code: string; message: string }> {
    const result = await dispatch(
      createHandlers(services),
      'link:delete',
      { linkId },
      silentLogger,
    );
    return result.ok
      ? { ok: true, code: '', message: '' }
      : { ok: false, code: result.error.code, message: result.error.message };
  }

  it('[H07] refuses to unlink a marked sentence from the file it was marked in', async () => {
    const marked = paperWithHighlight('The residual stream', 'features are directions');
    const [containment] = services.db.links.findReferences({
      entityType: 'annotation',
      entityId: marked.annotationId,
    });
    expect(containment?.type).toBe('annotation-belongs-to-document');
    if (containment === undefined) return;

    const refused = await tryDelete(containment.id);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('CONFLICT');
    expect(refused.message).toContain('marked sentence');

    // Still there, and still there after a restart: this one is written once and never again,
    // so losing it takes the highlight off its own file's graph permanently.
    restart();
    expect(
      services.db.links.findReferences({
        entityType: 'annotation',
        entityId: marked.annotationId,
      }),
    ).toHaveLength(1);
  });

  it('[H07] refuses to unlink a wikilink the page writes for itself', async () => {
    const { db } = services;
    const source = db.documents.create({
      title: 'Field Station',
      docType: 'markdown',
      source: 'corpus',
      authors: [],
    });
    const target = db.documents.create({
      title: 'Ground Truth',
      docType: 'markdown',
      source: 'corpus',
      authors: [],
    });
    // Exactly what `MarkdownCorpusImporter` writes for `See [[Ground Truth]].`, and exactly
    // what it writes again the next time it walks the file.
    const derived = db.links.create({
      type: 'document-references-document',
      sourceType: 'document',
      sourceId: source.id,
      targetType: 'document',
      targetId: target.id,
      label: 'Ground Truth',
      origin: 'derived',
      generator: 'wikilink',
    });

    const refused = await tryDelete(derived.id);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('CONFLICT');
    expect(refused.message).toContain('Edit the text');
    expect(db.links.getById(derived.id)).not.toBeNull();
  });

  it('[H07] still takes away the link the researcher made', async () => {
    const marked = paperWithHighlight('The residual stream', 'features are directions');
    const other = services.db.documents.create({
      title: 'Superposition',
      docType: 'pdf',
      source: 'zotero',
      authors: [],
    });
    const { link } = await call('link:create', {
      type: 'annotation-references-document',
      sourceType: 'annotation',
      sourceId: marked.annotationId,
      targetType: 'document',
      targetId: other.id,
      origin: 'manual',
    });

    expect(await tryDelete(link.id)).toMatchObject({ ok: true });
    expect(services.db.links.getById(link.id)).toBeNull();
    // …and the containment edge it sat beside is untouched.
    expect(
      services.db.links.findReferences({
        entityType: 'annotation',
        entityId: marked.annotationId,
      }),
    ).toHaveLength(1);
  });
});
